import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";

import type { Evidence, PlanStep, Verifier, VerificationResult } from "./contracts.ts";
import { verifiedWorkspacePath } from "./verified-workspace-path.ts";

/**
 * A Verifier that only speaks when the step asked for something it can check.
 * Steps that mention neither tests nor diffs return an empty pass so a
 * CompositeVerifier can keep the Kernel's file/receipt checks in charge.
 * 只在步骤点名了它能检查的东西时才发言的 Verifier。既不提测试也不提 diff 的步骤
 * 返回空通过，好让 CompositeVerifier 继续把关 Kernel 的文件 / Receipt 检查。
 */
export function silentPass(runId: string): VerificationResult {
  return {
    runId,
    passed: true,
    summary: "",
    checkedEvidenceIds: [],
    createdAt: new Date().toISOString(),
  };
}

/**
 * Runs a named test command only if trusted code independently approved the
 * exact arguments. Model-authored plan text alone cannot authorize execution.
 * 只有可信代码独立批准了完全一致的参数，才会运行具名测试命令；模型计划本身不能授权执行。
 */
export class TestCommandVerifier implements Verifier {
  readonly #workspacePath?: string;
  readonly #timeoutMs: number;
  readonly #runner: typeof runProcess;
  readonly #approvedCommands: readonly (readonly string[])[];

  constructor(options: { workspacePath?: string; timeoutMs?: number; runner?: typeof runProcess; approvedCommands?: readonly (readonly string[])[] } = {}) {
    this.#workspacePath = options.workspacePath;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#runner = options.runner ?? runProcess;
    this.#approvedCommands = options.approvedCommands ?? [];
  }

  async verify(input: Parameters<Verifier["verify"]>[0]): Promise<VerificationResult> {
    const failures: string[] = [];
    const unverified: string[] = [];
    const checked: string[] = [];
    for (const step of input.plan.steps) {
      const command = extractTestCommand(step);
      if (command !== undefined) {
        if (this.#workspacePath === undefined) {
          failures.push(`${step.title}: named a test command but no workspace is configured`);
          continue;
        }
        const approved = this.#approvedCommands.some((candidate) => candidate.length === command.length && candidate.every((part, index) => part === command[index]));
        if (!approved) {
          unverified.push(`${step.title}: test command is not independently authorized for execution`);
          continue;
        }
        const result = await this.#runner(command, this.#workspacePath, this.#timeoutMs);
        if (result.code !== 0) {
          failures.push(`${step.title}: \`${command.join(" ")}\` exited ${result.code}`);
        }
        continue;
      }
      if (!mentionsTests(step)) continue;
      const testEvidence = input.evidence.filter((item) => item.stepId === step.id && item.kind === "test");
      const withLocator = testEvidence.find((item) => item.locator !== undefined);
      if (withLocator?.locator === undefined) {
        failures.push(`${step.title}: a test step needs test evidence with a locator`);
        continue;
      }
      checked.push(withLocator.id);
      const problem = await this.readTestOutput(withLocator);
      if (problem !== undefined) failures.push(`${step.title}: ${problem}`);
      else unverified.push(`${step.title}: test output was supplied by a worker and needs review`);
    }
    if (failures.length === 0 && checked.length === 0 && !input.plan.steps.some((step) => extractTestCommand(step) !== undefined || mentionsTests(step))) {
      return silentPass(input.run.id);
    }
    const needsReview = failures.length === 0 && unverified.length > 0;
    const passed = failures.length === 0 && !needsReview;
    return {
      runId: input.run.id,
      passed,
      ...(needsReview ? { needsReview: true, unverifiedCriteria: unverified } : {}),
      summary: passed ? "Test contract checked." : needsReview ? unverified.join("; ") : `Test verification failed. ${failures.join("; ")}.`,
      checkedEvidenceIds: checked,
      createdAt: new Date().toISOString(),
    };
  }

  private async readTestOutput(evidence: Evidence): Promise<string | undefined> {
    const locator = evidence.locator;
    if (locator === undefined) return "test evidence has no locator";
    const path = await verifiedWorkspacePath(locator, this.#workspacePath);
    if (path === undefined) return `"${locator}" could not be resolved`;
    let contents: string;
    try {
      const info = await stat(path);
      if (!info.isFile()) return `"${locator}" is not a file`;
      contents = await readFile(path, "utf8");
    } catch {
      return `"${locator}" does not exist on disk`;
    }
    if (contents.trim().length === 0) return `"${locator}" is empty`;
    if (/\b(fail(ed|ing|ures?)|error)\b/i.test(contents) && !/\b0 failed\b/i.test(contents)) {
      return `"${locator}" reports failing tests`;
    }
    return undefined;
  }
}

/**
 * Reads a unified diff the plan promised, instead of trusting a worker's
 * "looks good" sentence.
 * 去读计划承诺过的 unified diff，而不是相信 Worker 一句“看起来没问题”。
 */
export class DiffFileVerifier implements Verifier {
  readonly #workspacePath?: string;

  constructor(options: { workspacePath?: string } = {}) {
    this.#workspacePath = options.workspacePath;
  }

  async verify(input: Parameters<Verifier["verify"]>[0]): Promise<VerificationResult> {
    const failures: string[] = [];
    const checked: string[] = [];
    let relevant = false;
    for (const step of input.plan.steps) {
      if (!mentionsDiff(step)) continue;
      relevant = true;
      const candidates = input.evidence.filter((item) => item.stepId === step.id && item.locator !== undefined);
      const diffEvidence = candidates.find((item) => looksLikeDiffLocator(item.locator ?? ""));
      if (diffEvidence?.locator === undefined) {
        failures.push(`${step.title}: a diff review needs a .diff / .patch locator`);
        continue;
      }
      checked.push(diffEvidence.id);
      const path = await verifiedWorkspacePath(diffEvidence.locator, this.#workspacePath);
      if (path === undefined) {
        failures.push(`${step.title}: "${diffEvidence.locator}" could not be resolved`);
        continue;
      }
      let contents: string;
      try {
        contents = await readFile(path, "utf8");
      } catch {
        failures.push(`${step.title}: "${diffEvidence.locator}" does not exist on disk`);
        continue;
      }
      if (contents.trim().length === 0) {
        failures.push(`${step.title}: "${diffEvidence.locator}" is empty`);
        continue;
      }
      if (!/^(diff --git |--- |\+\+\+ )/m.test(contents)) {
        failures.push(`${step.title}: "${diffEvidence.locator}" is not a unified diff`);
      }
    }
    if (!relevant) return silentPass(input.run.id);
    const passed = failures.length === 0;
    return {
      runId: input.run.id,
      passed,
      summary: passed ? "Diff contract checked." : `Diff verification failed. ${failures.join("; ")}.`,
      checkedEvidenceIds: checked,
      createdAt: new Date().toISOString(),
    };
  }
}

export function extractTestCommand(step: PlanStep): string[] | undefined {
  const text = [step.instructions, ...step.acceptanceCriteria].join("\n");
  const explicit = text.match(/test command:\s*`([^`]+)`/i) ?? text.match(/test command:\s*([^\n]+)/i);
  if (explicit?.[1] !== undefined) {
    const args = splitArgs(explicit[1]);
    return args.length === 0 ? undefined : args;
  }
  if (/\bnpm test\b/.test(text)) return ["npm", "test"];
  if (/\bpytest\b/.test(text)) return ["pytest"];
  if (/\bcargo test\b/.test(text)) return ["cargo", "test"];
  if (/\bgo test\b/.test(text)) return ["go", "test"];
  return undefined;
}

/**
 * True when a step expects a *test run*, not merely test files or a disclaimer.
 *
 * Plans legitimately name `tests/` as a deliverable and legitimately say "the
 * tests were not run". Neither is a request for test evidence, and demanding one
 * from a worker without a shell turns an honest, complete delivery into a
 * failure. A step is a test step when an acceptance criterion asks for a run
 * ("run the tests", "tests pass", "node --test …"), or when the instructions
 * contain a run request, a shell command in a command context, or an acceptance
 * criterion that says a named test file passes. Naming a test directory while
 * writing files, or saying a test was not executed, is not a test step.
 *
 * 当步骤期望"运行测试"、而不只是测试文件或免责声明时为 true。
 *
 * 计划把 `tests/` 列为交付物、以及写明"测试未运行"都是合理的；两者都不是要求测试证据，向没有
 * shell 的 Worker 索要证据会把一次诚实完整的交付判成失败。只有验收标准要求运行（"跑测试"、
 * "测试通过"、"node --test …"），或指令含运行请求、命令语境下的 shell 命令，或验收标准声称
 * 某个具名测试文件通过时，才算测试步骤。边写文件边点名测试目录，或声明测试未执行，都不算。
 */
const TEST_RUN_REQUEST = /(?:运行|跑|执行|执行并记录|跑通|通过)\s*(?:全部|所有|单元|回归|新的?)?\s*测试|\btests?\s+(?:must\s+)?pass(?:es)?\b|\brun\s+(?:the\s+|all\s+|unit\s+|regression\s+)?tests?\b|\bnode\s+--test\b|\bnpm\s+(?:run\s+)?test\b|\byarn\s+test\b|\bpnpm\s+test\b|\bbun\s+test\b|\bpytest\b|\bcargo\s+test\b|\bgo\s+test\b/i;
const TEST_DISCLAIMER = /(?:未|没有|尚未|不|无法|不能|不得|请勿|不要|无需|never|not|no|without|didn't|did\s+not|haven't|have\s+not|cannot|can't|unable)\s*(?:由[^，。；\n]{0,12})?(?:运行|执行|跑)/;

export function mentionsTests(step: PlanStep): boolean {
  const instructions = step.instructions ?? "";
  const criteria = step.acceptanceCriteria.join("\n");
  const hasTestWord = /(?:\btests?\b|测试|单元测试)/i.test(`${instructions}\n${criteria}`);
  if (!hasTestWord) return false;
  // A real run request anywhere settles it, including in an acceptance
  // criterion such as "npm test passes".
  // 任何地方出现真正的运行请求即可判定，包括"npm test 通过"这类验收标准。
  if (TEST_RUN_REQUEST.test(criteria)) return true;
  // A shell command only counts in a command context; a bare mention of
  // `node --test` inside prose about writing files does not run anything.
  // shell 命令只在命令语境中才算；写文件的散文里提到 `node --test` 并不会运行它。
  const instructionSentences = instructions.split(/\n|(?<=[。！？；.!?;])/);
  for (const sentence of instructionSentences) {
    if (TEST_DISCLAIMER.test(sentence)) continue;
    if (TEST_RUN_REQUEST.test(sentence) && !/(?:由所有者|由你|owner|yourself)\s*(?:执行|运行|验证|run|execute|verify)/i.test(sentence)) return true;
  }
  return false;
}

export function mentionsDiff(step: PlanStep): boolean {
  const text = [step.instructions, ...step.acceptanceCriteria].join("\n");
  return /(?:\bdiff\b|\.patch\b|unified diff|差异|补丁)/i.test(text);
}

function looksLikeDiffLocator(locator: string): boolean {
  return /\.(diff|patch)$/i.test(locator) || /diff/i.test(locator);
}

function splitArgs(command: string): string[] {
  return command.trim().split(/\s+/).filter((part) => part.length > 0);
}

export async function runProcess(
  command: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number; output: string }> {
  const [bin, ...args] = command;
  if (bin === undefined) return { code: 1, output: "empty command" };
  return await new Promise((resolvePromise) => {
    const child = spawn(bin, args, {
      cwd,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", USERPROFILE: process.env.USERPROFILE ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ code: 1, output: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? 1, output });
    });
  });
}
