/**
 * One-time approval codes for actions that reach outside the machine.
 *
 * The Kernel already knows how to pause an irreversible step; what it lacked was
 * a way for the owner to answer from a phone. A code is bound to one run and one
 * step, expires in ten minutes, is stored only as a salted hash, and is consumed
 * by the first valid use — so a replayed message, a screenshot of the code, or a
 * code from an earlier run cannot approve anything.
 *
 * 面向会影响外部世界的动作的一次性审批码。
 *
 * Kernel 已经知道如何暂停不可逆步骤；缺的是让所有者在手机上作答的方式。审批码绑定到唯一的
 * Run 与步骤，十分钟过期，只保存加盐哈希，首次有效使用即作废——因此重放消息、截图里的码、
 * 或旧 Run 的码都无法批准任何东西。
 */
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { writeJsonAtomic } from "../config/json-file.ts";

export type ApprovalDecision = "approve" | "reject";

export interface ApprovalRequest {
  id: string;
  runId: string;
  stepId: string;
  planId?: string;
  /** Which surface asked; today only WhatsApp can ask. 由哪个界面发起；目前只有 WhatsApp。 */
  channel: "whatsapp";
  codeHash: string;
  salt: string;
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
}

interface Store {
  version: 1;
  requests: ApprovalRequest[];
}

const FILE = "approval-codes.json";
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const APPROVAL_TTL_MS = 10 * 60_000;

function file(dataDirectory: string): string {
  return join(dataDirectory, FILE);
}

async function load(dataDirectory: string): Promise<Store> {
  try {
    const value = JSON.parse(await readFile(file(dataDirectory), "utf8")) as Partial<Store>;
    return { version: 1, requests: Array.isArray(value.requests) ? value.requests : [] };
  } catch {
    return { version: 1, requests: [] };
  }
}

async function save(dataDirectory: string, store: Store): Promise<void> {
  await writeJsonAtomic(file(dataDirectory), store);
}

function hashCode(code: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${code}`).digest("hex");
}

function newCode(): string {
  const bytes = randomBytes(8);
  let code = "";
  for (const byte of bytes) code += ALPHABET[byte % ALPHABET.length];
  return code;
}

/** Codes are shouted, copied and retyped; normalise before comparing. 审批码会被大声念、复制、重打；比较前先归一。 */
export function normalizeApprovalCode(value: string): string {
  return value.replace(/[\s-]/g, "").toUpperCase();
}

export interface IssuedApproval {
  code: string;
  request: ApprovalRequest;
}

/**
 * Issue a code for one waiting step. Re-issuing for the same run and step
 * invalidates the earlier code, so a chat history full of codes has exactly one
 * that works.
 * 为一个等待中的步骤签发审批码。同一 Run 与步骤重发会使旧码失效，因此聊天记录里的一堆码只有
 * 一个有效。
 */
export async function issueApprovalCode(
  dataDirectory: string,
  input: { runId: string; stepId: string; planId?: string },
  now = new Date(),
  ttlMs = APPROVAL_TTL_MS,
): Promise<IssuedApproval> {
  const store = await load(dataDirectory);
  const active = store.requests.filter((request) => request.usedAt === undefined && Date.parse(request.expiresAt) > now.getTime());
  const code = newCode();
  const salt = randomBytes(8).toString("hex");
  const request: ApprovalRequest = {
    id: randomId(),
    runId: input.runId,
    stepId: input.stepId,
    ...(input.planId === undefined ? {} : { planId: input.planId }),
    channel: "whatsapp",
    codeHash: hashCode(code, salt),
    salt,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  };
  await save(dataDirectory, {
    version: 1,
    requests: [...active.filter((item) => !(item.runId === input.runId && item.stepId === input.stepId)), request],
  });
  return { code, request };
}

/** A live request for this step, so the bridge does not send a new code every poll. 该步骤仍在有效期内的请求，避免桥每次轮询都发新码。 */
export async function activeRequestFor(
  dataDirectory: string,
  runId: string,
  stepId: string,
  now = new Date(),
): Promise<ApprovalRequest | undefined> {
  const store = await load(dataDirectory);
  return store.requests.find((request) => request.runId === runId
    && request.stepId === stepId
    && request.usedAt === undefined
    && Date.parse(request.expiresAt) > now.getTime());
}

export type ConsumeResult =
  | { ok: true; request: ApprovalRequest }
  | { ok: false; reason: "not_found" | "expired" | "used" };

/** Resolve a typed code to its request and burn it. 把输入的码解析为对应请求并作废它。 */
export async function consumeApprovalCode(
  dataDirectory: string,
  code: string,
  now = new Date(),
): Promise<ConsumeResult> {
  const normalized = normalizeApprovalCode(code);
  if (normalized.length === 0) return { ok: false, reason: "not_found" };
  const store = await load(dataDirectory);
  const match = store.requests.find((request) => hashCode(normalized, request.salt) === request.codeHash);
  if (match === undefined) return { ok: false, reason: "not_found" };
  if (match.usedAt !== undefined) return { ok: false, reason: "used" };
  if (Date.parse(match.expiresAt) <= now.getTime()) return { ok: false, reason: "expired" };
  match.usedAt = now.toISOString();
  await save(dataDirectory, store);
  return { ok: true, request: match };
}

function randomId(): string {
  return randomBytes(8).toString("hex");
}