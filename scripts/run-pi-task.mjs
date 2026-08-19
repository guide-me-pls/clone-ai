#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, rename, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve, join } from "node:path";
import process from "node:process";

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_ATTEMPT_TIMEOUT_MINUTES = 60;
const DEFAULT_VERIFY_TIMEOUT_MINUTES = 20;
const OUTPUT_TAIL_LIMIT = 32 * 1024;
const PI_SETTLE_GRACE_MS = 1_500;

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "blocked", "cancelled"]);

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  if (!options.task) throw new Error("Missing --task <goal>.");
  if (!options.verify) throw new Error("Missing --verify <command>. A real task needs an objective verifier.");

  const workspacePath = resolve(options.workspace ?? process.cwd());
  await access(workspacePath);

  const runId = options.runId ?? `${timestampId()}-${randomUUID().slice(0, 8)}`;
  const runDirectory = join(workspacePath, ".clone", "task-runs", runId);
  await mkdir(runDirectory, { recursive: true });

  const run = {
    version: 1,
    id: runId,
    goal: options.task,
    workspacePath,
    verificationCommand: options.verify,
    piCommand: options.piCommand,
    provider: options.provider,
    model: options.model,
    thinking: options.thinking,
    status: "queued",
    terminalReason: undefined,
    maxAttempts: options.maxAttempts,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    attempts: [],
  };

  await persistRun(runDirectory, run);
  print(`Run ${run.id}`);
  print(`Workspace: ${workspacePath}`);
  print(`State: ${join(runDirectory, "run.json")}`);

  let previousVerificationFingerprint;

  for (let attemptNumber = 1; attemptNumber <= run.maxAttempts; attemptNumber += 1) {
    if (TERMINAL_STATUSES.has(run.status)) break;

    const attemptDirectory = join(runDirectory, `attempt-${attemptNumber}`);
    await mkdir(attemptDirectory, { recursive: true });

    const attempt = {
      number: attemptNumber,
      status: "running",
      startedAt: new Date().toISOString(),
      promptPath: join(attemptDirectory, "prompt.md"),
      piEventsPath: join(attemptDirectory, "pi-events.jsonl"),
      piStderrPath: join(attemptDirectory, "pi-stderr.log"),
      verificationStdoutPath: join(attemptDirectory, "verify-stdout.log"),
      verificationStderrPath: join(attemptDirectory, "verify-stderr.log"),
    };

    run.attempts.push(attempt);
    transition(run, "running");
    await persistRun(runDirectory, run);

    const previousAttempt = run.attempts.at(-2);
    const prompt = buildPrompt(run, attemptNumber, previousAttempt);
    await writeFile(attempt.promptPath, prompt, "utf8");

    print(`\nAttempt ${attemptNumber}/${run.maxAttempts}: starting Pi`);
    const piResult = await runPi({
      command: options.piCommand,
      workspacePath,
      promptPath: attempt.promptPath,
      eventsPath: attempt.piEventsPath,
      stderrPath: attempt.piStderrPath,
      provider: options.provider,
      model: options.model,
      thinking: options.thinking,
      timeoutMs: options.attemptTimeoutMinutes * 60_000,
    });

    Object.assign(attempt, {
      piExitCode: piResult.exitCode,
      piSignal: piResult.signal,
      piCompletedEvent: piResult.completedEvent,
      piTimedOut: piResult.timedOut,
      piSpawnError: piResult.spawnError,
      piErrorMessage: piResult.agentError,
      piFinalText: piResult.finalText,
      piStderrTail: piResult.stderrTail,
    });

    if (piResult.spawnError) {
      attempt.status = "failed";
      attempt.endedAt = new Date().toISOString();
      run.terminalReason = `Pi could not start: ${piResult.spawnError}`;
      transition(run, "blocked");
      await persistRun(runDirectory, run);
      break;
    }

    transition(run, "verifying");
    await persistRun(runDirectory, run);
    print(`Attempt ${attemptNumber}: verifying with ${options.verify}`);

    const verification = await runVerification({
      command: options.verify,
      workspacePath,
      stdoutPath: attempt.verificationStdoutPath,
      stderrPath: attempt.verificationStderrPath,
      timeoutMs: options.verifyTimeoutMinutes * 60_000,
    });

    const fingerprint = createVerificationFingerprint(verification);
    Object.assign(attempt, {
      verificationExitCode: verification.exitCode,
      verificationSignal: verification.signal,
      verificationTimedOut: verification.timedOut,
      verificationSpawnError: verification.spawnError,
      verificationStdoutTail: verification.stdoutTail,
      verificationStderrTail: verification.stderrTail,
      verificationFingerprint: fingerprint,
      endedAt: new Date().toISOString(),
    });

    // Correct workspace state is the source of truth. A Pi wrapper may fail to
    // exit after emitting its terminal event, but a passing verifier still wins.
    if (!verification.spawnError && !verification.timedOut && verification.exitCode === 0) {
      attempt.status = "succeeded";
      run.terminalReason = "Objective verification passed.";
      transition(run, "succeeded");
      await persistRun(runDirectory, run);
      break;
    }

    attempt.status = "failed";
    attempt.failureSummary = summarizeFailure(piResult, verification);

    if (verification.spawnError) {
      run.terminalReason = `Verification command could not start: ${verification.spawnError}`;
      transition(run, "blocked");
    } else if (verification.timedOut) {
      run.terminalReason = "Verification command timed out.";
      transition(run, "blocked");
    } else if (previousVerificationFingerprint === fingerprint) {
      run.terminalReason = "Two consecutive attempts produced the same verification failure; no progress detected.";
      transition(run, "blocked");
    } else if (attemptNumber >= run.maxAttempts) {
      run.terminalReason = `Verification still failed after ${run.maxAttempts} attempts.`;
      transition(run, "failed");
    } else {
      previousVerificationFingerprint = fingerprint;
      transition(run, "retry_wait");
    }

    await persistRun(runDirectory, run);
  }

  if (!TERMINAL_STATUSES.has(run.status)) {
    run.terminalReason = "Task loop ended without a terminal decision.";
    transition(run, "failed");
    await persistRun(runDirectory, run);
  }

  print(`\nTerminal status: ${run.status}`);
  print(`Reason: ${run.terminalReason}`);
  print(`Run record: ${join(runDirectory, "run.json")}`);
  process.exitCode = run.status === "succeeded" ? 0 : run.status === "blocked" ? 2 : 1;
}

function buildPrompt(run, attemptNumber, previousAttempt) {
  const retryContext = previousAttempt
    ? [
        "",
        "## Previous attempt failed",
        "",
        previousAttempt.failureSummary ?? "The objective verifier did not pass.",
        "",
        "Continue from the current workspace state. Preserve correct existing changes and fix the remaining failure.",
      ].join("\n")
    : "";

  return [
    "# Execution task",
    "",
    run.goal,
    "",
    `This is attempt ${attemptNumber} of ${run.maxAttempts}.`,
    `The objective acceptance command is: ${run.verificationCommand}`,
    "",
    "Work directly in the current workspace.",
    "Inspect existing changes before editing and do not discard unrelated user work.",
    "Do not commit, push, open a pull request, or expose credentials.",
    "Run relevant checks yourself. Finish only when the acceptance command should pass, or explain the concrete blocker.",
    retryContext,
  ].join("\n");
}

async function runPi(options) {
  const args = ["--mode", "json", "-p", "--no-session", "--approve"];
  if (options.provider) args.push("--provider", options.provider);
  if (options.model) args.push("--model", options.model);
  if (options.thinking) args.push("--thinking", options.thinking);
  args.push(`@${options.promptPath}`);

  const eventsStream = createWriteStream(options.eventsPath, { flags: "w" });
  const stderrStream = createWriteStream(options.stderrPath, { flags: "w" });
  let stderrTail = "";
  let finalText = "";
  let agentError;
  let completedEvent;
  let buffer = "";
  let timedOut = false;
  let spawnError;
  let completionKillTimer;

  return await new Promise((resolvePromise) => {
    let child;
    try {
      child = spawnPortable(options.command, args, {
        cwd: options.workspacePath,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      eventsStream.end();
      stderrStream.end();
      resolvePromise(emptyProcessResult(error));
      return;
    }

    const timeout = setTimeout(() => {
      timedOut = true;
      terminateChild(child);
    }, options.timeoutMs);

    child.on("error", (error) => {
      spawnError = error instanceof Error ? error.message : String(error);
    });

    child.stdout.on("data", (chunk) => {
      eventsStream.write(chunk);
      buffer += chunk.toString("utf8");
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);
        const event = parseJsonLine(line);
        if (!event) continue;

        if (event.type === "message_end" && event.message?.role === "assistant") {
          finalText = messageText(event.message);
          if (event.message.stopReason === "error") {
            agentError = event.message.errorMessage ?? "Pi assistant stopped with an error.";
          }
        }

        if (event.type === "agent_end" || event.type === "agent_settled") {
          completedEvent = event.type;
          if (!completionKillTimer) {
            completionKillTimer = setTimeout(() => terminateChild(child), PI_SETTLE_GRACE_MS);
          }
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderrStream.write(chunk);
      stderrTail = appendTail(stderrTail, chunk.toString("utf8"));
    });

    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout);
      if (completionKillTimer) clearTimeout(completionKillTimer);
      eventsStream.end();
      stderrStream.end();
      resolvePromise({
        exitCode,
        signal,
        completedEvent,
        timedOut,
        spawnError,
        agentError,
        finalText,
        stderrTail,
      });
    });
  });
}

async function runVerification(options) {
  const stdoutStream = createWriteStream(options.stdoutPath, { flags: "w" });
  const stderrStream = createWriteStream(options.stderrPath, { flags: "w" });
  let stdoutTail = "";
  let stderrTail = "";
  let timedOut = false;
  let spawnError;

  return await new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(options.command, {
        cwd: options.workspacePath,
        shell: true,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      stdoutStream.end();
      stderrStream.end();
      resolvePromise(emptyVerificationResult(error));
      return;
    }

    const timeout = setTimeout(() => {
      timedOut = true;
      terminateChild(child);
    }, options.timeoutMs);

    child.on("error", (error) => {
      spawnError = error instanceof Error ? error.message : String(error);
    });
    child.stdout.on("data", (chunk) => {
      stdoutStream.write(chunk);
      stdoutTail = appendTail(stdoutTail, chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk) => {
      stderrStream.write(chunk);
      stderrTail = appendTail(stderrTail, chunk.toString("utf8"));
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout);
      stdoutStream.end();
      stderrStream.end();
      resolvePromise({ exitCode, signal, timedOut, spawnError, stdoutTail, stderrTail });
    });
  });
}

function spawnPortable(command, args, options) {
  if (process.platform !== "win32") return spawn(command, args, options);

  const commandLine = [command, ...args].map(quoteCmdArgument).join(" ");
  return spawn(process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe", ["/d", "/s", "/c", commandLine], options);
}

function quoteCmdArgument(value) {
  const text = String(value);
  if (/[\r\n"]/.test(text)) throw new Error(`Unsafe process argument: ${text}`);
  return `"${text.replaceAll("%", "%%")}"`;
}

function terminateChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const forceTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 2_000);
  forceTimer.unref?.();
}

function summarizeFailure(piResult, verification) {
  const parts = [
    `Pi exit code: ${String(piResult.exitCode)}`,
    `Pi terminal event: ${piResult.completedEvent ?? "none"}`,
    `Pi timed out: ${String(piResult.timedOut)}`,
    `Verification exit code: ${String(verification.exitCode)}`,
  ];
  if (piResult.agentError) parts.push(`Pi error: ${piResult.agentError}`);
  if (piResult.stderrTail.trim()) parts.push(`Pi stderr:\n${truncateForPrompt(piResult.stderrTail)}`);
  if (verification.stdoutTail.trim()) parts.push(`Verification stdout:\n${truncateForPrompt(verification.stdoutTail)}`);
  if (verification.stderrTail.trim()) parts.push(`Verification stderr:\n${truncateForPrompt(verification.stderrTail)}`);
  return parts.join("\n\n");
}

function createVerificationFingerprint(result) {
  return createHash("sha256")
    .update(JSON.stringify({
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      spawnError: result.spawnError,
      stdoutTail: result.stdoutTail,
      stderrTail: result.stderrTail,
    }))
    .digest("hex");
}

function parseJsonLine(line) {
  if (!line.trim()) return undefined;
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function messageText(message) {
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

function appendTail(current, addition) {
  const combined = current + addition;
  return combined.length <= OUTPUT_TAIL_LIMIT ? combined : combined.slice(-OUTPUT_TAIL_LIMIT);
}

function truncateForPrompt(value) {
  const limit = 8_000;
  return value.length <= limit ? value : `[older output omitted]\n${value.slice(-limit)}`;
}

function transition(run, status) {
  run.status = status;
  run.updatedAt = new Date().toISOString();
}

async function persistRun(runDirectory, run) {
  const destination = join(runDirectory, "run.json");
  const temporary = join(runDirectory, `run.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(run, null, 2)}\n`, "utf8");
  await rename(temporary, destination);
}

function emptyProcessResult(error) {
  return {
    exitCode: null,
    signal: null,
    completedEvent: undefined,
    timedOut: false,
    spawnError: error instanceof Error ? error.message : String(error),
    agentError: undefined,
    finalText: "",
    stderrTail: "",
  };
}

function emptyVerificationResult(error) {
  return {
    exitCode: null,
    signal: null,
    timedOut: false,
    spawnError: error instanceof Error ? error.message : String(error),
    stdoutTail: "",
    stderrTail: "",
  };
}

function parseArguments(args) {
  const options = {
    workspace: process.cwd(),
    task: undefined,
    verify: undefined,
    runId: undefined,
    piCommand: "pi",
    provider: undefined,
    model: undefined,
    thinking: undefined,
    maxAttempts: DEFAULT_ATTEMPTS,
    attemptTimeoutMinutes: DEFAULT_ATTEMPT_TIMEOUT_MINUTES,
    verifyTimeoutMinutes: DEFAULT_VERIFY_TIMEOUT_MINUTES,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }

    const value = args[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${argument}.`);

    switch (argument) {
      case "--workspace": options.workspace = value; break;
      case "--task": options.task = value; break;
      case "--verify": options.verify = value; break;
      case "--run-id": options.runId = value; break;
      case "--pi-command": options.piCommand = value; break;
      case "--provider": options.provider = value; break;
      case "--model": options.model = value; break;
      case "--thinking": options.thinking = value; break;
      case "--max-attempts": options.maxAttempts = positiveInteger(value, argument); break;
      case "--attempt-timeout-minutes": options.attemptTimeoutMinutes = positiveNumber(value, argument); break;
      case "--verify-timeout-minutes": options.verifyTimeoutMinutes = positiveNumber(value, argument); break;
      default: throw new Error(`Unknown argument: ${argument}`);
    }
    index += 1;
  }

  return options;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function positiveNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number.`);
  return parsed;
}

function timestampId() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function print(message) {
  process.stdout.write(`${message}\n`);
}

function printHelp() {
  print(`Usage:
  node scripts/run-pi-task.mjs --task <goal> --verify <command> [options]

Required:
  --task <goal>                      Real workspace task for Pi
  --verify <command>                 Objective acceptance command

Options:
  --workspace <path>                 Default: current directory
  --pi-command <command>             Default: pi
  --provider <provider>              Optional Pi provider
  --model <model>                    Optional Pi model
  --thinking <level>                 Optional Pi thinking level
  --max-attempts <count>             Default: ${DEFAULT_ATTEMPTS}
  --attempt-timeout-minutes <count>  Default: ${DEFAULT_ATTEMPT_TIMEOUT_MINUTES}
  --verify-timeout-minutes <count>   Default: ${DEFAULT_VERIFY_TIMEOUT_MINUTES}
  --run-id <id>                      Optional stable run id

Exit codes:
  0 succeeded
  1 failed
  2 blocked`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
