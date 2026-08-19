#!/usr/bin/env node
/**
 * Reliability benchmark runner for the black-box execution path.
 * Runs the fixed task set from tasks.ts against a real provider CLI and
 * records pass/fail, duration, and artifact facts under benchmark/results/.
 *
 * Usage:
 *   npm run bench                 # all tasks, provider from --provider (default pi)
 *   npm run bench -- --tasks summarize,two-step-chain
 *   npm run bench -- --provider pi --tasks missing-input
 *
 * Costs: each task is one or more real model calls (a few cents per task).
 * The "missing-input" task is intentionally expected to fail and verifies that
 * failures are classified cleanly instead of hanging.
 *
 * 黑盒执行路径的可靠性基准运行器：用真实 Provider CLI 运行 tasks.ts 中的固定任务集，
 * 把通过/失败、耗时和产物事实记录到 benchmark/results/ 下。
 *
 * 用法：
 *   npm run bench                 # 全部任务，Provider 由 --provider 指定（默认 pi）
 *   npm run bench -- --tasks summarize,two-step-chain
 *   npm run bench -- --provider pi --tasks missing-input
 *
 * 成本：每个任务是一次或多次真实模型调用（每个任务几美分）。
 * missing-input 任务刻意期望失败，用来验证失败能被干净分类而不是挂死。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BlackBoxWorkerAdapter, type BlackBoxProviderConfig } from "../src/adapters/black-box-worker.ts";
import { StaticAgentRegistry } from "../src/agents/static-agent-registry.ts";
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
}

function parseArgs(): { provider: string; tasks: string[] } {
  const argv = process.argv.slice(2);
  const providerIndex = argv.indexOf("--provider");
  const tasksIndex = argv.indexOf("--tasks");
  return {
    provider: providerIndex >= 0 && argv[providerIndex + 1] !== undefined ? argv[providerIndex + 1]! : "pi",
    tasks: tasksIndex >= 0 && argv[tasksIndex + 1] !== undefined
      ? argv[tasksIndex + 1]!.split(",").map((item) => item.trim()).filter(Boolean)
      : BENCH_TASKS.map((task) => task.id),
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

async function runTask(task: BenchTask, provider: string): Promise<BenchRecord> {
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
    const recipe = PROVIDERS[provider];
    if (recipe === undefined) {
      throw new Error(`Unknown provider "${provider}". Known providers: ${Object.keys(PROVIDERS).join(", ")}.`);
    }
    const adapter = new BlackBoxWorkerAdapter({
      agentId: "bench-worker",
      config: { ...recipe, id: provider, label: provider, timeoutMs: 420_000 },
      workCapabilities: ["research", "drafting", "review", "implementation", "filesystem_read", "filesystem_write", "external_action"],
    });
    const journal = new JsonlJournalStore(join(workspace, ".clone-ai", "journal.jsonl"));
    const memory = new MemoryPipeline(journal);
    const runtime = new CloneRuntime({
      journal,
      policy: new DefaultPolicyEngine(),
      verifier: new EvidenceVerifier(),
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
        acceptanceCriteria: ["Benchmark acceptance"],
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
    record.passed = result.status === "completed" && result.verification?.passed === true;

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

const { provider, tasks } = parseArgs();
const selected = BENCH_TASKS.filter((task) => tasks.includes(task.id));
if (selected.length === 0) {
  console.error(`No benchmark tasks match: ${tasks.join(", ")}.`);
  process.exit(2);
}

await mkdir(resultsDirectory, { recursive: true });
console.log(`Benchmark: provider=${provider} tasks=${selected.map((task) => task.id).join(",")}`);
const records: BenchRecord[] = [];
for (const task of selected) {
  const record = await runTask(task, provider);
  records.push(record);
  const expected = record.expectedFailure ? " (expected failure)" : "";
  console.log(
    `  ${record.passed ? "PASS" : record.expectedFailure ? "EXPECTED-FAIL" : "FAIL"}  ${task.id.padEnd(20)} ${(record.durationMs / 1000).toFixed(1).padStart(6)}s${expected}`
      + (record.error === undefined ? "" : `  error: ${record.error.slice(0, 200)}`),
  );
}

const passedCount = records.filter((record) => record.passed || record.expectedFailure).length;
const expectedFailed = records.filter((record) => record.expectedFailure && record.status === "failed").length;
const failed = records.filter((record) => !record.expectedFailure && !record.passed).length;
const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const reportPath = join(resultsDirectory, `${provider}-${stamp}.json`);
await writeFile(reportPath, `${JSON.stringify({ provider, ranAt: new Date().toISOString(), records }, null, 2)}\n`, "utf8");

console.log(`\nSummary: ${passedCount}/${records.length} passed (${failed} unexpected failures, ${expectedFailed}/${records.filter((r) => r.expectedFailure).length} expected failures behaved)`);
console.log(`Report: ${reportPath}`);
process.exit(failed > 0 ? 1 : 0);
