/**
 * Image attachments on a chat turn.
 *
 * A screenshot of a bill, a photo of a whiteboard, a chart someone pasted: these
 * are how a person hands a personal agent context it cannot type. The model can
 * read them; the Kernel never needs to, so an attachment is decoded here and
 * passed to the provider as an image part, not written into the workspace.
 *
 * Validation is strict and local: a claimed MIME type must match a known image
 * signature, and size is bounded. Trusting the declared type would let an
 * arbitrary payload claim to be a PNG and reach the provider, or write itself
 * to disk under an image name.
 *
 * 对话回合中的图片附件。
 *
 * 账单截图、白板照片、别人贴来的图表：这就是一个人给个人 Agent 传递它无法打字的上下文的方式。
 * 模型能读它们；Kernel 从不需要，因此附件在这里解码后作为 image part 交给 Provider，而不写入工作区。
 *
 * 校验严格且本地：声明的 MIME 类型必须与已知图片签名一致，且限制大小。信任声明的类型会让任意载荷
 * 自称 PNG 并被送到 Provider，或以图片之名写到磁盘上。
 */
export type AttachmentResult =
  | { ok: true; images: Array<{ type: "image"; data: string; mimeType: string }> }
  | { ok: false; error: string };

/** Base64 size ceiling; roughly 5 MB of image. 以 base64 计的上限，约相当于 5 MB 图片。 */
const MAX_BASE64_CHARACTERS = 7_000_000;
const MAX_IMAGES = 4;

const SIGNATURES: ReadonlyArray<{ mimeType: string; matches: (bytes: Buffer) => boolean }> = [
  { mimeType: "image/png", matches: (bytes) => bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mimeType: "image/jpeg", matches: (bytes) => bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  { mimeType: "image/gif", matches: (bytes) => bytes.length > 6 && bytes.subarray(0, 4).toString("ascii") === "GIF8" },
  { mimeType: "image/webp", matches: (bytes) => bytes.length > 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP" },
];

/**
 * Validates raw attachment payloads from a request body. Accepts
 * `{ mimeType, data }` objects; anything else is refused with a reason the
 * interface can show.
 * 校验请求体里的原始附件。接受 `{ mimeType, data }` 对象；其他一律带原因拒绝，供界面展示。
 */
export function parseAttachments(input: unknown): AttachmentResult {
  if (input === undefined || input === null) return { ok: true, images: [] };
  if (!Array.isArray(input)) return { ok: false, error: "Attachments must be a list." };
  if (input.length > MAX_IMAGES) return { ok: false, error: `At most ${MAX_IMAGES} images per message.` };
  const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
  for (const [index, raw] of input.entries()) {
    if (typeof raw !== "object" || raw === null) return { ok: false, error: `Attachment ${index + 1} is not an object.` };
    const record = raw as Record<string, unknown>;
    const declared = typeof record.mimeType === "string" ? record.mimeType.toLowerCase() : "";
    const data = typeof record.data === "string" ? record.data.trim() : "";
    if (data.length === 0) return { ok: false, error: `Attachment ${index + 1} has no data.` };
    if (data.length > MAX_BASE64_CHARACTERS) return { ok: false, error: `Attachment ${index + 1} is too large.` };
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return { ok: false, error: `Attachment ${index + 1} is not base64.` };
    const bytes = Buffer.from(data, "base64");
    // The declared type must name a signature the bytes actually carry: a
    // mismatch is refused rather than corrected, because guessing at content is
    // the kind of leniency an injection would rely on.
    // 声明的类型必须与字节实际携带的签名一致：不一致即拒绝而非纠正，因为"猜内容"正是注入会依赖的宽容。
    const actual = SIGNATURES.find((signature) => signature.matches(bytes));
    if (actual === undefined) return { ok: false, error: `Attachment ${index + 1} is not a supported image (PNG, JPEG, GIF or WebP).` };
    if (declared.length > 0 && declared !== actual.mimeType) {
      return { ok: false, error: `Attachment ${index + 1} declares ${declared} but is ${actual.mimeType}.` };
    }
    images.push({ type: "image", data, mimeType: actual.mimeType });
  }
  return { ok: true, images };
}
