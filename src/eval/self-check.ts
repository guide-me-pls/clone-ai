/**
 * Self-check loop: adversarial suite -> gate -> optional gated repair -> record.
 *
 * One round is a closed loop the owner can run at any time (or schedule): the
 * probes attack the boundaries, the gate re-runs deterministic behavior, and
 * every round is journaled. When a probe is red the round exports its failure as
 * a trace so the existing repair lane can pick it up — this loop never edits code
 * itself, so "did the loop work?" stays answerable.
 *
 * 自检回路：对抗套件 → 门禁 → 可选带闸门修复 → 记录。
 *
 * 一轮是所有者随时（或定时）可以跑的闭环：探针攻击边界，门禁重跑确定性行为，每一轮写入 Journal。
 * 探针变红时，本轮把失败导出为轨迹，交给既有的修复通道——回路本身从不改代码，因此"回路是否
 * 有效"始终可回答。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runAdversarialProbes, type AdversarialReport } from "./adversarial-probes.ts";
import { exportFailedTraces } from "../audit/failed-traces.ts";
import type { JournalStore } from "../core/journal.ts";
import { logJson } from "../observability/json-log.ts";

export interface SelfCheckOptions {
  dataDirectory: string;
  journal: JournalStore;
  /** Run `npm test` as well as `npm run gate`; off by default because it is the slow part. 是否同时跑 npm test；默认关闭，因为最慢。 */
  fullTests?: boolean;
  /** Where to write the round report. 本轮报告的写入位置。 */
  reportDirectory?: string;
  /** Runs a command; injectable for tests. 执行命令；可注入以便测试。 */
  exec?: (command: string, args: string[], cwd: string) => Promise<{ status: number; stdout: string; stderr: string }>;
  /** Repository root holding `benchmark/gate`. Defaults to this module's repository. 存放 gate 的仓库根；默认本模块所在仓库。 */
  repoRoot?: string;
  now?: Date;
}

export interface SelfCheckRound {
  id: string;
  generatedAt: string;
  probes: AdversarialReport;
  gate: { status: number; tail: string; skipped?: boolean };
  tests?: { status: number; tail: string };
  verdict: "green" | "red";
  /** Set when the round produced material for the repair lane. 本轮为修复通道产出材料时设置。 */
  traceExport?: { written: string[]; directory: string };
  reportPath?: string;
}

export async function runSelfCheckRound(options: SelfCheckOptions): Promise<SelfCheckRound> {
  const now = options.now ?? new Date();
  const exec = options.exec ?? runCommand;
  const repoRoot = options.repoRoot ?? defaultRepoRoot();
  const probes = await runAdversarialProbes(now);
  // The desktop bundle ships the runtime but not the benchmark fixtures; spawning
  // `npm run gate` there would fail for a missing directory, not for a regression.
  // Record it as skipped rather than red, so the loop keeps its meaning in the app.
  // 桌面应用打包了运行时，但不包含 benchmark 夹具；在那里跑 `npm run gate` 会因为目录不存在
  // 而失败，而不是因为回归。记为跳过而不是红色，让回路在应用里仍然有意义。
  const gateAvailable = existsSync(join(repoRoot, "benchmark", "gate"));
  const gate = gateAvailable
    ? await exec("npm", ["run", "gate"], repoRoot)
    : { status: 0, stdout: "", stderr: `gate skipped: benchmark/gate not present under ${repoRoot}` };
  const tests = options.fullTests === true && existsSync(join(repoRoot, "package.json"))
    ? await exec("npm", ["test"], repoRoot)
    : undefined;
  const verdict: SelfCheckRound["verdict"] = probes.failed === 0 && gate.status === 0 && (tests?.status ?? 0) === 0 ? "green" : "red";
  const id = `round-${now.toISOString().replace(/[-:.]/g, "").slice(0, 15)}`;
  const round: SelfCheckRound = {
    id,
    generatedAt: now.toISOString(),
    probes,
    gate: {
      status: gate.status,
      tail: tail(gate.stdout, gate.stderr),
      ...(gateAvailable ? {} : { skipped: true }),
    },
    ...(tests === undefined ? {} : { tests: { status: tests.status, tail: tail(tests.stdout, tests.stderr) } }),
    verdict,
  };

  if (verdict === "red") {
    // A red probe is a failure this agent observed; it belongs in the repair
    // pipeline. The export is redacted by construction.
    // 红色探针是这个 Agent 自己观察到的失败；它属于修复流水线。导出内容在构造时已脱敏。
    try {
      const exported = await exportFailedTraces(options.dataDirectory, options.journal, { limit: 5 });
      round.traceExport = { written: exported.written, directory: exported.directory };
    } catch (error: unknown) {
      logJson("warn", "self-check trace export failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  await options.journal.append({
    type: "selfcheck.completed",
    payload: {
      roundId: round.id,
      verdict,
      probes: { total: probes.total, passed: probes.passed, failed: probes.failed },
      failures: probes.probes.filter((probe) => !probe.passed).map((probe) => ({ id: probe.id, boundary: probe.boundary, detail: probe.detail })),
      gate: { status: round.gate.status },
      ...(round.tests === undefined ? {} : { tests: { status: round.tests.status } }),
      ...(round.traceExport === undefined ? {} : { traces: round.traceExport.written.length }),
      fullTests: options.fullTests === true,
    },
  });

  const directory = options.reportDirectory ?? join(options.dataDirectory, "selfcheck");
  await mkdir(directory, { recursive: true });
  round.reportPath = join(directory, `${round.id}.json`);
  await writeFile(round.reportPath, `${JSON.stringify(round, null, 2)}\n`, "utf8");
  return round;
}

/** The latest rounds, newest first, for the audit view and the CLI. 最近的若干轮，最新在前，供审计界面与 CLI 使用。 */
export async function readSelfCheckRounds(dataDirectory: string, limit = 10): Promise<SelfCheckRound[]> {
  const directory = join(dataDirectory, "selfcheck");
  const names = await readDirectory(directory);
  const rounds: SelfCheckRound[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".json")).sort().reverse().slice(0, limit)) {
    try {
      rounds.push(JSON.parse(await readFile(join(directory, name), "utf8")) as SelfCheckRound);
    } catch {
      continue;
    }
  }
  return rounds;
}

async function readDirectory(directory: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  try {
    return await readdir(directory);
  } catch {
    return [];
  }
}

function tail(stdout: string, stderr: string): string {
  return `${stdout}\n${stderr}`.trim().split("\n").slice(-12).join("\n").slice(-1_500);
}

function defaultRepoRoot(): string {
  // src/eval/self-check.ts -> src -> repository root. src/eval/self-check.ts -> src -> 仓库根。
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function runCommand(command: string, args: string[], cwd: string): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status: status ?? 1, stdout, stderr }));
    child.on("error", (error) => resolve({ status: 1, stdout, stderr: String(error) }));
  });
}