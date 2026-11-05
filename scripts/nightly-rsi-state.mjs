import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

const VERSION = 1;
let warned = false;
const emptyState = () => ({ version: VERSION, traces: {} });

export const stateFilePath = (reportDir) => join(reportDir, "consumed-traces.json");
export const fingerprint = (content) => createHash("sha256").update(content).digest("hex");

function validState(state) {
  if (state === null || typeof state !== "object" || Array.isArray(state) ||
      state.version !== VERSION || state.traces === null || typeof state.traces !== "object" || Array.isArray(state.traces)) return false;
  return Object.entries(state.traces).every(([runId, entry]) =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry) &&
    entry.runId === runId && typeof entry.sha256 === "string" && /^[a-f0-9]{64}$/.test(entry.sha256) &&
    typeof entry.consumedAt === "string" && entry.consumedAt.length > 0 &&
    typeof entry.branch === "string" && entry.branch.length > 0 &&
    (entry.prUrl === undefined || typeof entry.prUrl === "string"));
}

export async function loadState(reportDir) {
  try {
    const state = JSON.parse(await readFile(stateFilePath(reportDir), "utf8"));
    if (!validState(state)) throw new Error("invalid state shape");
    return state;
  } catch (error) {
    if (error?.code !== "ENOENT" && !warned) {
      warned = true;
      console.warn(`[rsi] could not load consumed trace state; treating it as empty: ${String(error?.message ?? error)}`);
    }
    return emptyState();
  }
}

export function isConsumed(state, runId, sha256) {
  return Object.hasOwn(state.traces, runId) && state.traces[runId].sha256 === sha256;
}

export function markConsumed(state, entry, now = new Date()) {
  const { runId, sha256, branch, prUrl } = entry;
  const record = { runId, sha256, consumedAt: now.toISOString(), branch, ...(prUrl ? { prUrl } : {}) };
  return { ...state, traces: { ...state.traces, [runId]: record } };
}

// This is the same batch-outcome decision used by the nightly runner.
export function recordOutcome(state, traces, report, now = new Date()) {
  if (!["fixed", "pr-created", "patch-only"].includes(report.status)) return state;
  return traces.reduce((next, trace) => markConsumed(next, {
    runId: trace.runId,
    sha256: trace.sha256,
    branch: report.branch,
    prUrl: report.prUrl,
  }, now), state);
}

export async function saveState(reportDir, state) {
  await mkdir(reportDir, { recursive: true });
  const target = stateFilePath(reportDir);
  const temporary = join(reportDir, `consumed-traces.json.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let owned = false;
  let file;
  try {
    file = await open(temporary, "wx", 0o600);
    owned = true;
    await file.writeFile(JSON.stringify(state, null, 2) + "\n");
    await file.close();
    file = undefined;
    await rename(temporary, target);
    owned = false;
  } finally {
    if (file) await file.close().catch(() => undefined);
    if (owned) await rm(temporary, { force: true }).catch(() => undefined);
  }
}
