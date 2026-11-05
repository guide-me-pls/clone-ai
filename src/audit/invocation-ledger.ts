import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { redactMemoryPii } from "../memory/memory-hygiene.ts";

/**
 * A shared, append-only ledger for every Main Agent invocation, regardless of
 * which data directory the caller uses. The Run journal explains what a Run
 * did; this ledger explains who invoked the agent, what they asked, what the
 * agent answered, and which Run ids came back.
 *
 * 面向所有 Main Agent 调用的共享追加式账本，不依赖调用方使用的数据目录。
 * Run Journal 解释 Run 做了什么；本账本解释谁调用了 Agent、问了什么、回答了什么，
 * 以及返回了哪些 Run id。
 */
export type InvocationSurface = "cli" | "desktop" | "mobile" | "main" | "unknown";

export interface InvocationCaller {
  kind: string;
  label?: string;
  sessionId?: string;
  pid: number;
  ppid?: number;
}

export interface InvocationStartInput {
  prompt: string;
  surface: InvocationSurface;
  workspacePath: string;
  dataDirectory: string;
  caller?: Partial<Omit<InvocationCaller, "pid" | "ppid">>;
  turnId?: string;
  command?: string;
  auditHome?: string;
  environment?: NodeJS.ProcessEnv;
}

export interface InvocationMetadata {
  sessionFile?: string;
  modelId?: string;
  provider?: string;
  effort?: string;
}

export interface InvocationResult extends InvocationMetadata {
  reply?: string;
  error?: string;
  newRuns?: Array<{ id: string; status: string; planId?: string }>;
}

export interface InvocationRecord {
  schemaVersion: 1;
  id: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  caller: InvocationCaller;
  surface: InvocationSurface;
  prompt: string;
  reply?: string;
  error?: string;
  workspacePath: string;
  dataDirectory: string;
  turnId?: string;
  command?: string;
  sessionFile?: string;
  modelId?: string;
  provider?: string;
  effort?: string;
  newRuns: Array<{ id: string; status: string; planId?: string }>;
  truncated?: boolean;
}

interface LedgerLine {
  schemaVersion: 1;
  phase: "started" | "completed" | "failed";
  id: string;
  at: string;
  /** Start fields. 开始字段。 */
  caller?: InvocationCaller;
  surface?: InvocationSurface;
  prompt?: string;
  workspacePath?: string;
  dataDirectory?: string;
  turnId?: string;
  command?: string;
  /** End fields. 结束字段。 */
  durationMs?: number;
  reply?: string;
  error?: string;
  sessionFile?: string;
  modelId?: string;
  provider?: string;
  effort?: string;
  newRuns?: Array<{ id: string; status: string; planId?: string }>;
  truncated?: boolean;
}

export interface InvocationHandle {
  readonly id: string;
  readonly startedAt: string;
  note(metadata: InvocationMetadata): void;
  complete(result?: InvocationResult): Promise<void>;
  fail(error: unknown): Promise<void>;
}

const MAX_PROMPT = 20_000;
const MAX_REPLY = 80_000;
const MAX_ERROR = 8_000;

/**
 * Resolve the shared audit directory. Production always writes under the user
 * home `.clone/audit`, even when an invocation uses a temporary CLONE_HOME.
 * Tests stay isolated under their data directory unless they set an explicit
 * CLONE_AI_AUDIT_HOME.
 *
 * 解析共享审计目录。生产环境始终写入用户主目录下的 `.clone/audit`，即使调用方使用临时
 * CLONE_HOME；测试默认隔离在自己的数据目录，除非显式设置 CLONE_AI_AUDIT_HOME。
 */
export function resolveInvocationAuditDirectory(input: {
  dataDirectory: string;
  environment?: NodeJS.ProcessEnv;
  auditHome?: string;
}): string {
  const env = input.environment ?? process.env;
  const explicit = input.auditHome ?? env.CLONE_AI_AUDIT_HOME;
  if (explicit !== undefined && explicit.trim().length > 0) return resolve(explicit, "audit");
  if (env.NODE_TEST_CONTEXT !== undefined || env.NODE_ENV === "test") return join(input.dataDirectory, "audit");
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  return join(resolve(home), ".clone", "audit");
}

export function invocationLedgerPath(input: Parameters<typeof resolveInvocationAuditDirectory>[0]): string {
  return join(resolveInvocationAuditDirectory(input), "invocations.jsonl");
}

/** Infer the calling agent without asking the model: explicit env wins, then common agent ids. 不询问模型，直接推断调用者：显式环境变量优先，然后识别常见 Agent 标识。 */
export function detectInvocationCaller(env: NodeJS.ProcessEnv = process.env): InvocationCaller {
  const explicitKind = env.CLONE_AI_CALLER?.trim();
  const codexSession = env.CODEX_THREAD_ID?.trim();
  const claudeSession = env.CLAUDE_SESSION_ID?.trim() || env.CLAUDE_CODE_SESSION_ID?.trim();
  const kind = explicitKind || (codexSession !== undefined ? "codex" : claudeSession !== undefined ? "claude-code" : "unknown");
  const sessionId = env.CLONE_AI_CALLER_SESSION?.trim()
    || (kind === "codex" ? codexSession : undefined)
    || (kind === "claude-code" ? claudeSession : undefined);
  return {
    kind,
    pid: process.pid,
    ...(process.ppid === undefined ? {} : { ppid: process.ppid }),
    ...(sessionId === undefined || sessionId.length === 0 ? {} : { sessionId }),
  };
}

/**
 * Start a best-effort invocation record. A ledger failure must never prevent
 * the agent from answering; it is logged and the invocation continues.
 *
 * 开始一条尽力而为的调用记录。账本写入失败绝不能阻止 Agent 回答；失败只记日志并继续。
 */
export async function beginInvocation(input: InvocationStartInput): Promise<InvocationHandle> {
  const id = randomUUID();
  const startedAt = new Date().toISOString();
  const detected = detectInvocationCaller(input.environment);
  const caller: InvocationCaller = {
    ...detected,
    ...(input.caller?.kind === undefined ? {} : { kind: input.caller.kind }),
    ...(input.caller?.label === undefined ? {} : { label: input.caller.label }),
    ...(input.caller?.sessionId === undefined ? {} : { sessionId: input.caller.sessionId }),
  };
  const prompt = truncate(redact(input.prompt), MAX_PROMPT);
  let metadata: InvocationMetadata = {};
  let ended = false;

  await appendLine(input, {
    schemaVersion: 1,
    phase: "started",
    id,
    at: startedAt,
    caller,
    surface: input.surface,
    prompt: prompt.text,
    workspacePath: input.workspacePath,
    dataDirectory: input.dataDirectory,
    ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
    ...(input.command === undefined ? {} : { command: input.command }),
    ...(prompt.truncated ? { truncated: true } : {}),
  });

  return {
    id,
    startedAt,
    note(next) {
      metadata = { ...metadata, ...stripUndefined(next) };
    },
    async complete(result = {}) {
      if (ended) return;
      ended = true;
      await appendEnd(input, {
        schemaVersion: 1,
        phase: "completed",
        id,
        at: new Date().toISOString(),
        durationMs: Date.now() - Date.parse(startedAt),
        ...metadata,
        ...(result.reply === undefined ? {} : { reply: truncate(redact(result.reply), MAX_REPLY).text }),
        ...(result.newRuns === undefined ? {} : { newRuns: result.newRuns }),
        ...(result.sessionFile === undefined ? {} : { sessionFile: result.sessionFile }),
        ...(result.modelId === undefined ? {} : { modelId: result.modelId }),
        ...(result.provider === undefined ? {} : { provider: result.provider }),
        ...(result.effort === undefined ? {} : { effort: result.effort }),
      });
    },
    async fail(error) {
      if (ended) return;
      ended = true;
      const message = error instanceof Error ? error.message : String(error);
      await appendEnd(input, {
        schemaVersion: 1,
        phase: "failed",
        id,
        at: new Date().toISOString(),
        durationMs: Date.now() - Date.parse(startedAt),
        ...metadata,
        error: truncate(redact(message), MAX_ERROR).text,
      });
    },
  };
}

/** Read and merge the ledger, newest first. Torn or malformed lines are ignored. 读取并合并账本，新的在前；忽略截断或损坏的行。 */
export async function readInvocations(input: {
  dataDirectory: string;
  environment?: NodeJS.ProcessEnv;
  auditHome?: string;
  limit?: number;
}): Promise<InvocationRecord[]> {
  let source = "";
  try {
    source = await readFile(invocationLedgerPath(input), "utf8");
  } catch {
    return [];
  }
  const byId = new Map<string, InvocationRecord>();
  for (const line of source.split("\n")) {
    if (line.trim().length === 0) continue;
    let parsed: LedgerLine;
    try {
      parsed = JSON.parse(line) as LedgerLine;
    } catch {
      continue;
    }
    if (parsed.schemaVersion !== 1 || typeof parsed.id !== "string" || typeof parsed.at !== "string") continue;
    if (parsed.phase === "started") {
      const caller = parsed.caller;
      if (caller === undefined || parsed.surface === undefined || parsed.prompt === undefined
        || parsed.workspacePath === undefined || parsed.dataDirectory === undefined) continue;
      byId.set(parsed.id, {
        schemaVersion: 1,
        id: parsed.id,
        status: "running",
        startedAt: parsed.at,
        caller,
        surface: parsed.surface,
        prompt: parsed.prompt,
        workspacePath: parsed.workspacePath,
        dataDirectory: parsed.dataDirectory,
        newRuns: [],
        ...(parsed.turnId === undefined ? {} : { turnId: parsed.turnId }),
        ...(parsed.command === undefined ? {} : { command: parsed.command }),
        ...(parsed.truncated === true ? { truncated: true } : {}),
      });
      continue;
    }
    const record = byId.get(parsed.id);
    if (record === undefined) continue;
    byId.set(parsed.id, {
      ...record,
      status: parsed.phase === "failed" ? "failed" : "completed",
      endedAt: parsed.at,
      ...(parsed.durationMs === undefined ? {} : { durationMs: parsed.durationMs }),
      ...(parsed.reply === undefined ? {} : { reply: parsed.reply }),
      ...(parsed.error === undefined ? {} : { error: parsed.error }),
      ...(parsed.sessionFile === undefined ? {} : { sessionFile: parsed.sessionFile }),
      ...(parsed.modelId === undefined ? {} : { modelId: parsed.modelId }),
      ...(parsed.provider === undefined ? {} : { provider: parsed.provider }),
      ...(parsed.effort === undefined ? {} : { effort: parsed.effort }),
      ...(parsed.newRuns === undefined ? {} : { newRuns: parsed.newRuns }),
    });
  }
  return [...byId.values()]
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
    .slice(0, Math.min(Math.max(input.limit ?? 100, 1), 500));
}

export async function readInvocation(id: string, input: Parameters<typeof readInvocations>[0]): Promise<InvocationRecord | undefined> {
  return (await readInvocations({ ...input, limit: 500 })).find((record) => record.id === id);
}

async function appendLine(input: InvocationStartInput, line: LedgerLine): Promise<void> {
  try {
    const path = invocationLedgerPath(input);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(line)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    console.warn(`[clone-ai] invocation audit write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function appendEnd(input: InvocationStartInput, line: LedgerLine): Promise<void> {
  await appendLine(input, line);
}

function redact(value: string): string {
  const redacted = redactMemoryPii(String(value ?? "")).text
    .replace(/\b(sk-[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{8,}|xox[bap]-[A-Za-z0-9-]{8,})\b/g, "[redacted-token]")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, "$1[redacted]")
    .replace(/(api[_-]?key\s*[=:]\s*)[^\s]+/gi, "$1[redacted]");
  return redacted;
}

function truncate(value: string, max: number): { text: string; truncated: boolean } {
  if (value.length <= max) return { text: value, truncated: false };
  return { text: `${value.slice(0, max)}\n[truncated ${value.length - max} chars]`, truncated: true };
}

function stripUndefined(value: InvocationMetadata): InvocationMetadata {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as InvocationMetadata;
}
