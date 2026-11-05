#!/usr/bin/env node
/**
 * Reliability benchmark runner for the black-box execution path.
 * Runs the fixed task set from tasks.ts against a real provider CLI and
 * records pass/fail, duration, and artifact facts under benchmark/results/.
 *
 * Usage:
 *   npm run bench -- --unsafe-host --provider pi --tasks summarize
 *   npm run bench -- --provider native --tasks summarize
 *
 * The native provider runs in-process with per-call scope checks, so it does
 * not need --unsafe-host; it requires CLONE_AI_NATIVE_MODEL and
 * CLONE_AI_NATIVE_BASE_URL, and records exact token usage in the report.
 *
 * Costs: each task is one or more real model calls (a few cents per task).
 * The "missing-input" task is intentionally expected to fail and verifies that
 * failures are classified cleanly instead of hanging.
 *
 * 黑盒执行路径的可靠性基准运行器：用真实 Provider CLI 运行 tasks.ts 中的固定任务集，
 * 把通过/失败、耗时和产物事实记录到 benchmark/results/ 下。
 *
 * 用法：
 *   npm run bench -- --unsafe-host --provider pi --tasks summarize
 *   npm run bench -- --provider native --tasks summarize
 *
 * 原生 Provider 在进程内运行、每次调用做 Scope 校验，因此不需要 --unsafe-host；
 * 它需要 CLONE_AI_NATIVE_MODEL 与 CLONE_AI_NATIVE_BASE_URL，并在报告中记录精确 token 用量。
 *
 * 成本：每个任务是一次或多次真实模型调用（每个任务几美分）。
 * missing-input 任务刻意期望失败，用来验证失败能被干净分类而不是挂死。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BlackBoxCliWorker, type BlackBoxProviderConfig } from "../src/workers/black-box-cli-worker.ts";
import { createConfiguredNativeWorker } from "../src/workers/native-worker-factory.ts";
import { StaticAgentRegistry } from "../src/workers/static-worker-registry.ts";
import { JsonlJournalStore } from "../src/core/journal.ts";
import { DefaultPolicyEngine } from "../src/core/policy.ts";
import { CloneRuntime } from "../src/core/runtime.ts";
import { EvidenceVerifier } from "../src/core/verification.ts";
import { JsonWorkspaceCheckpointStore } from "../src/core/workspace-evidence.ts";
import { MemoryPipeline } from "../src/memory/memory-pipeline.ts";
import { BENCH_TASKS, type BenchTask } from "./tasks.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const resultsDirectory = join(here, "results");

interface BenchRecord {
  taskId: string;
  title: string;
  passed: boolean;
  expectedFailure: boolean;
  status: string;
  durationMs: number;
  artifacts: Array<{ path: string; bytes: number }>;
  error?: string;
  failureCategory?: string;
  failureReason?: string;
  verification?: { passed: boolean; needsReview: boolean; summary: string };
  /** Exact usage when the adapter reports it (the native worker does). Adapter 报告时的精确用量（原生 Worker 会）。 */
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number; modelCalls: number };
}

function parseArgs(): { provider: string; tasks: string[]; unsafeHost: boolean } {
  const argv = process.argv.slice(2);
  const providerIndex = argv.indexOf("--provider");
  const tasksIndex = argv.indexOf("--tasks");
  return {
    provider: providerIndex >= 0 && argv[providerIndex + 1] !== undefined ? argv[providerIndex + 1]! : "pi",
    tasks: tasksIndex >= 0 && argv[tasksIndex + 1] !== undefined
      ? argv[tasksIndex + 1]!.split(",").map((item) => item.trim()).filter(Boolean)
      : BENCH_TASKS.map((task) => task.id),
    unsafeHost: argv.includes("--unsafe-host"),
  };
}

const PROVIDERS: Record<string, Pick<BlackBoxProviderConfig, "command" | "args" | "env">> = {
  pi: {
    command: process.platform === "win32" ? "pi.cmd" : "pi",
    args: ["-p", "{{prompt}}"],
    env: ["GEMINI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "PI_CODING_AGENT_DIR", "PI_PACKAGE_DIR"],
  },
  claude: {
    command: process.platform === "win32" ? "claude.cmd" : "claude",
    args: ["-p", "{{prompt}}"],
    env: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "ANTHROPIC_BASE_URL", "ANTHROPIC_DEFAULT_*", "ANTHROPIC_SMALL_*", "ANTHROPIC_MODEL", "ANTHROPIC_SONNET", "ANTHROPIC_OPUS", "ANTHROPIC_HAIKU"],
  },
};

async function runTask(task: BenchTask, provider: string, unsafeHost: boolean): Promise<BenchRecord> {
  const workspace = await mkdtemp(join(tmpdir(), `clone-ai-bench-${task.id}-`));
  const startedAt = Date.now();
  const record: BenchRecord = {
    taskId: task.id,
    title: task.title,
    passed: false,
    expectedFailure: task.id === "missing-input",
    status: "unknown",
    durationMs: 0,
    artifacts: [],
  };
  try {
    for (const [path, content] of Object.entries(task.seedFiles)) {
      await writeFile(join(workspace, path), content, "utf8");
    }
    const workCapabilities = ["research", "drafting", "review", "implementation", "filesystem_read", "filesystem_write", "external_action"];
    const adapter = provider === "native"
      ? createConfiguredNativeWorker(process.env, workspace, { id: "bench-worker", workCapabilities })
      : (() => {
        const recipe = PROVIDERS[provider];
        if (recipe === undefined) {
          throw new Error(`Unknown provider "${provider}". Known providers: native, ${Object.keys(PROVIDERS).join(", ")}.`);
        }
        return new BlackBoxCliWorker({
          agentId: "bench-worker",
          config: { ...recipe, id: provider, label: provider, timeoutMs: 420_000, ...(unsafeHost ? { hostAccess: "unrestricted" as const } : {}) },
          workCapabilities,
        });
      })();
    if (adapter === undefined) {
      throw new Error("Native worker needs CLONE_AI_NATIVE_MODEL and CLONE_AI_NATIVE_BASE_URL.");
    }
    const journal = new JsonlJournalStore(join(workspace, ".clone-ai", "journal.jsonl"));
    const memory = new MemoryPipeline(journal);
    const runtime = new CloneRuntime({
      journal,
      policy: new DefaultPolicyEngine(),
      // The verifier must know the benchmark workspace, or every promised
      // relative path falls through to "does not exist on disk".
      // 验证器必须知道基准工作区，否则每个承诺的相对路径都会落到"磁盘上不存在"。
      verifier: new EvidenceVerifier({ workspacePath: workspace }),
      memory,
      workspacePath: workspace,
      workspaceCheckpointStore: new JsonWorkspaceCheckpointStore(join(workspace, ".clone-ai", "checkpoints")),
    });
    const { run } = await runtime.acceptTrigger({ kind: "manual", summary: task.summary, payload: { bench: true } });
    await runtime.attachPlan(run.id, {
      summary: task.summary,
      steps: task.steps.map((step) => ({
        id: step.id,
        title: step.title,
        instructions: step.instructions,
        risk: step.risk,
        acceptanceCriteria: step.subagents.flatMap((order) => order.expectedArtifacts.filter((artifact) => artifact.required).map((artifact) => `file ${artifact.description} exists`)),
        subagents: step.subagents.map((order) => ({
          ...order,
          inputs: [],
          budget: { maxDurationMs: order.maxDurationMs, maxModelCalls: 12, maxToolCalls: 20, maxAttempts: 1 },
        })),
      })),
    });

    const result = await runtime.execute(run.id, new StaticAgentRegistry([adapter]));
    record.status = result.status;
    record.durationMs = Date.now() - startedAt;
    if (result.verification !== undefined) {
      record.verification = {
        passed: result.verification.passed === true,
        needsReview: result.verification.needsReview === true,
        summary: result.verification.summary,
      };
    }
    const events = await journal.list();
    const usageEvents = events.filter((event) => event.type === "usage.recorded");
    if (usageEvents.length > 0) {
      const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, modelCalls: 0 };
      for (const event of usageEvents) {
        const payload = event.payload as Record<string, unknown>;
        for (const key of ["inputTokens", "outputTokens", "totalTokens", "modelCalls"] as const) {
          if (typeof payload[key] === "number") usage[key] += payload[key] as number;
        }
      }
      record.usage = usage;
    }
    const failures = events.filter((event) => event.type === "subagent.failed");
    const category = (failures.at(-1)?.payload as { report?: { category?: string } } | undefined)?.report?.category;
    if (category !== undefined) record.failureCategory = category;
    const lastSignal = [...events].reverse().find((event) => event.type === "verification.completed" || event.type === "execution.failed");
    if (lastSignal !== undefined) {
      const payload = lastSignal.payload as Record<string, unknown>;
      const reason = typeof payload.summary === "string" ? payload.summary : typeof payload.message === "string" ? payload.message : undefined;
      if (reason !== undefined) record.failureReason = reason;
    }
    record.passed = record.expectedFailure
      ? result.status === "failed" && category === "no_artifact"
      : result.status === "completed" && result.verification?.passed === true;

    const fs = await import("node:fs/promises");
    const walk = async (directory: string): Promise<string[]> => {
      const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
      const files: string[] = [];
      for (const entry of entries) {
        if (entry.name === ".clone-ai") continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) files.push(...await walk(path));
        else if (entry.isFile()) files.push(path);
      }
      return files;
    };
    for (const path of await walk(workspace)) {
      const info = await fs.stat(path);
      record.artifacts.push({ path: path.slice(workspace.length + 1).replaceAll("\\", "/"), bytes: info.size });
    }
    return record;
  } catch (error: unknown) {
    record.status = "error";
    record.durationMs = Date.now() - startedAt;
    record.error = error instanceof Error ? error.message : String(error);
    return record;
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
}

const { provider, tasks, unsafeHost } = parseArgs();
if (!unsafeHost && provider !== "native") {
  console.error("Black-box benchmark workers have no enforced sandbox. Pass --unsafe-host only if you explicitly accept unrestricted host access. The native provider enforces scopes and does not need this flag.");
  process.exit(2);
}
const selected = BENCH_TASKS.filter((task) => tasks.includes(task.id));
if (selected.length === 0) {
  console.error(`No benchmark tasks match: ${tasks.join(", ")}.`);
  process.exit(2);
}

await mkdir(resultsDirectory, { recursive: true });
console.log(`Benchmark: provider=${provider} tasks=${selected.map((task) => task.id).join(",")}`);
const records: BenchRecord[] = [];
for (const task of selected) {
  const record = await runTask(task, provider, unsafeHost);
  records.push(record);
  const expected = record.expectedFailure ? " (expected failure)" : "";
  console.log(
    `  ${record.passed ? (record.expectedFailure ? "EXPECTED-FAIL" : "PASS") : "FAIL"}  ${task.id.padEnd(20)} ${(record.durationMs / 1000).toFixed(1).padStart(6)}s${expected}`
      + (record.usage === undefined ? "" : `  ${record.usage.totalTokens} tokens`)
      + (record.error === undefined ? "" : `  error: ${record.error.slice(0, 200)}`),
  );
}

const passedCount = records.filter((record) => record.passed).length;
const expectedFailed = records.filter((record) => record.expectedFailure && record.passed).length;
const failed = records.filter((record) => !record.passed).length;
const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const reportPath = join(resultsDirectory, `${provider}-${stamp}.json`);
await writeFile(reportPath, `${JSON.stringify({ provider, ranAt: new Date().toISOString(), records }, null, 2)}\n`, "utf8");

console.log(`\nSummary: ${passedCount}/${records.length} passed (${failed} unexpected failures, ${expectedFailed}/${records.filter((r) => r.expectedFailure).length} expected failures behaved)`);
console.log(`Report: ${reportPath}`);
process.exit(failed > 0 ? 1 : 0);
