import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * WhatsApp Cloud API primitives used by the phone bridge.
 *
 * The relay must authenticate Meta's raw request body before parsing it, so
 * these helpers take strings or buffers rather than an already-parsed object.
 *
 * 手机桥使用的 WhatsApp Cloud API 基础能力。
 *
 * 中继必须先对 Meta 的原始请求体验签，再解析内容；因此这些函数接收字符串或 Buffer，
 * 而不是已经解析过的对象。
 */

export interface WhatsAppTextMessage {
  id: string;
  from: string;
  text: string;
  timestamp?: string;
  group: boolean;
  /**
   * The sender forwarded this from somewhere else, so the text may be written by
   * a third party. It is still the owner's message, but its content is data, not
   * a command. 发送者转发了这条内容，因此正文可能出自第三方。它仍是所有者的消息，但内容
   * 是数据，不是命令。
   */
  forwarded: boolean;
}

export interface WhatsAppMessageBatch {
  messages: WhatsAppTextMessage[];
  ignored: number;
}

/** Normalize a phone number to digits so `+86 138...` and `86138...` compare equally. 把电话号码归一为数字，使带加号、空格和纯数字的写法等价。 */
export function normalizeWhatsAppNumber(value: string): string {
  return value.replace(/\D/g, "");
}

export function allowedWhatsAppNumbers(values: readonly string[]): Set<string> {
  return new Set(values.map(normalizeWhatsAppNumber).filter((value) => value.length > 0));
}

export function isAllowedWhatsAppNumber(from: string, allowed: ReadonlySet<string>): boolean {
  return allowed.has(normalizeWhatsAppNumber(from));
}

/**
 * Constant-time HMAC check for `X-Hub-Signature-256`.
 *
 * A missing header, malformed hex, or a different secret all fail closed.
 *
 * 对 `X-Hub-Signature-256` 做常量时间 HMAC 校验。
 *
 * 缺少请求头、十六进制格式错误、密钥不一致，都会按失败处理。
 */
export function verifyWhatsAppSignature(input: {
  rawBody: string | Buffer;
  signatureHeader: string | undefined;
  appSecret: string;
}): boolean {
  if (input.signatureHeader === undefined || input.appSecret.length === 0) return false;
  const match = /^sha256=([0-9a-f]{64})$/i.exec(input.signatureHeader.trim());
  if (match === null) return false;
  const expected = createHmac("sha256", input.appSecret).update(input.rawBody).digest();
  const provided = Buffer.from(match[1], "hex");
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

/** Meta's GET verification challenge. 处理 Meta 的 GET 校验挑战。 */
export function whatsAppChallengeResponse(
  searchParams: URLSearchParams,
  verifyToken: string,
): { status: number; body: string } {
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge") ?? "";
  if (mode === "subscribe" && token !== null && token === verifyToken && verifyToken.length > 0) {
    return { status: 200, body: challenge };
  }
  return { status: 403, body: "Forbidden" };
}

/**
 * Extract text messages and explicitly count everything else as ignored.
 *
 * Group messages, media, reactions, and status callbacks never reach the
 * Main Agent; the bridge has no safe way to turn them into text yet.
 *
 * 提取文本消息，并把其他内容明确计为忽略。
 *
 * 群消息、媒体、表情回应和状态回调不会进入 Main Agent；桥接层目前无法安全地把它们
 * 转成文本。
 */
export function extractWhatsAppTextMessages(payload: unknown): WhatsAppMessageBatch {
  const messages: WhatsAppTextMessage[] = [];
  let ignored = 0;
  const root = asRecord(payload);
  const entries = Array.isArray(root?.entry) ? root.entry : [];
  for (const entry of entries) {
    const changes = Array.isArray(asRecord(entry)?.changes) ? (asRecord(entry)?.changes as unknown[]) : [];
    for (const change of changes) {
      const value = asRecord(asRecord(change)?.value);
      const incoming = Array.isArray(value?.messages) ? value.messages : [];
      for (const raw of incoming) {
        const message = asRecord(raw);
        const id = typeof message?.id === "string" ? message.id : "";
        const from = typeof message?.from === "string" ? message.from : "";
        const type = typeof message?.type === "string" ? message.type : "";
        const text = type === "text" ? asRecord(message?.text) : undefined;
        const body = typeof text?.body === "string" ? text.body : "";
        const group = typeof message?.group_id === "string" || value?.chat_type === "group";
        const context = asRecord(message?.context);
        const forwarded = context?.forwarded === true || context?.frequently_forwarded === true;
        if (id.length === 0 || from.length === 0 || body.trim().length === 0 || group) {
          ignored += 1;
          continue;
        }
        messages.push({
          id,
          from,
          text: body,
          group,
          forwarded,
          ...(typeof message?.timestamp === "string" ? { timestamp: message.timestamp } : {}),
        });
      }
      if (Array.isArray(value?.statuses) && value.statuses.length > 0) ignored += value.statuses.length;
    }
  }
  return { messages, ignored };
}

/**
 * Split visible agent output for the Cloud API's 4096-character text limit.
 *
 * Paragraph boundaries win, then line boundaries, then a hard split. The
 * suffix is reserved while packing so it cannot push a part over the limit.
 *
 * 按 Cloud API 的 4096 字符文本上限切分可见回复。
 *
 * 优先按段落，其次按行，最后才硬切。打包时会预留序号后缀的空间，避免后缀把某一段
 * 顶超上限。
 */
export function splitWhatsAppText(text: string, limit = 4_096): string[] {
  if (limit < 16) throw new Error("WhatsApp text limit must be at least 16 characters.");
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) return [];
  if (normalized.length <= limit) return [normalized];

  const reserve = 20;
  const packingLimit = Math.max(1, limit - reserve);
  const chunks: string[] = [];
  let current = "";
  const blocks = normalized.split(/\n{2,}/);
  let firstLine = true;
  for (const block of blocks) {
    const pieces = block.split("\n");
    for (const [lineIndex, piece] of pieces.entries()) {
      for (const part of hardSplit(piece, packingLimit)) {
        const separator = firstLine ? "" : lineIndex === 0 ? "\n\n" : "\n";
        const candidate = `${current}${separator}${part}`;
        if (candidate.length <= packingLimit) {
          current = candidate;
        } else {
          if (current.length > 0) chunks.push(current);
          current = part;
        }
        firstLine = false;
      }
    }
  }
  if (current.length > 0) chunks.push(current);

  const total = chunks.length;
  const numbered = total <= 1
    ? chunks
    : chunks.map((chunk, index) => `${chunk}\n\n(${index + 1}/${total})`);
  for (const part of numbered) {
    if (part.length > limit) throw new Error("WhatsApp text packing exceeded its configured limit.");
  }
  return numbered;
}

function hardSplit(value: string, limit: number): string[] {
  if (value.length <= limit) return [value];
  const parts: string[] = [];
  for (let index = 0; index < value.length; index += limit) {
    parts.push(value.slice(index, index + limit));
  }
  return parts;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
