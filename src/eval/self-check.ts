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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
  /** Runs a command in the repository root; injectable for tests. 在仓库根目录执行命令；可注入以便测试。 */
  exec?: (command: string, args: string[]) => Promise<{ status: number; stdout: string; stderr: string }>;
  now?: Date;
}

export interface SelfCheckRound {
  id: string;
  generatedAt: string;
  probes: AdversarialReport;
  gate: { status: number; tail: string };
  tests?: { status: number; tail: string };
  verdict: "green" | "red";
  /** Set when the round produced material for the repair lane. 本轮为修复通道产出材料时设置。 */
  traceExport?: { written: string[]; directory: string };
  reportPath?: string;
}

export async function runSelfCheckRound(options: SelfCheckOptions): Promise<SelfCheckRound> {
  const now = options.now ?? new Date();
  const exec = options.exec ?? runCommand;
  const probes = await runAdversarialProbes(now);
  const gate = await exec("npm", ["run", "gate"]);
  const tests = options.fullTests === true ? await exec("npm", ["test"]) : undefined;
  const verdict: SelfCheckRound["verdict"] = probes.failed === 0 && gate.status === 0 && (tests?.status ?? 0) === 0 ? "green" : "red";
  const id = `round-${now.toISOString().replace(/[-:.]/g, "").slice(0, 15)}`;
  const round: SelfCheckRound = {
    id,
    generatedAt: now.toISOString(),
    probes,
    gate: { status: gate.status, tail: tail(gate.stdout, gate.stderr) },
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

function runCommand(command: string, args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status: status ?? 1, stdout, stderr }));
    child.on("error", (error) => resolve({ status: 1, stdout, stderr: String(error) }));
  });
}