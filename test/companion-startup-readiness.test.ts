import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";

import { startCompanionServer, type RunningCompanionServer } from "../src/companion-server.ts";
import { createJournalStore } from "../src/core/sqlite-journal.ts";
import { companionFetch } from "./helpers/companion-api.ts";

/**
 * The window connects through the published endpoint, so readiness must not
 * wait for background maintenance. The first maintenance pass takes the
 * cross-process memory-extraction lock, and that lock has no acquisition
 * deadline: when another process holds it, a server that awaited the pass
 * before listening stays invisible forever — the live symptom was a daemon
 * alive for hours with no endpoint file and a window stuck on 正在连接.
 *
 * 窗口通过已发布的端点连接，因此就绪不得等待后台维护。首轮维护会获取跨进程的记忆提炼锁，
 * 而该锁没有获取截止时间：当别的进程持锁时，先等待维护再监听的服务器会永远不可见——
 * 现场症状就是一个存活数小时、没有端点文件、窗口停在"正在连接"的 Daemon。
 */

const PENDING_OBJECTIVE = "Prove that readiness is not gated on maintenance.";

/**
 * The test asserts the no-miner path journals its zero-candidate marker. An
 * ambient `CLONE_AI_MEMORY_MINING=all` would select the model miner, which
 * fails without an endpoint and would turn a correct pass into a test failure.
 * 该测试断言无提炼器路径会写入零候选标记。环境里的 `CLONE_AI_MEMORY_MINING=all`
 * 会选择模型提炼器；没有端点时它会失败，把一个正确的维护轮变成测试失败。
 */
function pinMiningOff(t: TestContext): void {
  const previous = process.env.CLONE_AI_MEMORY_MINING;
  process.env.CLONE_AI_MEMORY_MINING = "off";
  t.after(() => {
    if (previous === undefined) delete process.env.CLONE_AI_MEMORY_MINING;
    else process.env.CLONE_AI_MEMORY_MINING = previous;
  });
}

async function seedPendingExtraction(dataDirectory: string): Promise<void> {
  const createdAt = new Date().toISOString();
  const journal = createJournalStore(dataDirectory);
  try {
    await journal.append({
      type: "task.created",
      taskId: "task-startup",
      payload: {
        id: "task-startup",
        triggerId: "trigger-startup",
        title: "Startup readiness",
        objective: PENDING_OBJECTIVE,
        acceptanceCriteria: [],
        createdAt,
      },
    });
    await journal.append({
      type: "run.created",
      taskId: "task-startup",
      runId: "run-startup",
      payload: { id: "run-startup", taskId: "task-startup", status: "created", createdAt },
    });
    await journal.append({
      type: "memory.candidate.requested",
      runId: "run-startup",
      taskId: "task-startup",
      payload: { taskObjective: PENDING_OBJECTIVE, sourceEvidenceIds: [], outcome: "completed" },
    });
  } finally {
    (journal as { close?: () => void }).close?.();
  }
}

async function seedDeadline(dataDirectory: string): Promise<void> {
  const now = new Date();
  const journal = createJournalStore(dataDirectory);
  try {
    await journal.append({
      type: "state.commitment.recorded",
      payload: {
        id: "commit-startup",
        title: "Startup probe deadline",
        kind: "deadline",
        dueAt: new Date(now.getTime() + 3_600_000).toISOString(),
        status: "active",
        provenance: { authoredBy: "owner" },
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
    });
  } finally {
    (journal as { close?: () => void }).close?.();
  }
}

interface HeldLock {
  release(): void;
}

async function holdExtractionLock(dataDirectory: string): Promise<HeldLock> {
  const lockDirectory = join(dataDirectory, "memory-extraction-lock", ".clone");
  await mkdir(lockDirectory, { recursive: true });
  const holder = new DatabaseSync(join(lockDirectory, "workspace-execution.sqlite3"));
  holder.exec("BEGIN IMMEDIATE");
  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      holder.exec("ROLLBACK");
      holder.close();
    },
  };
}

async function waitForReady(started: Promise<RunningCompanionServer>, what: string): Promise<RunningCompanionServer> {
  let readinessTimeout: NodeJS.Timeout | undefined;
  let outcome: "ready" | "timeout";
  try {
    outcome = await Promise.race([
      started.then(() => "ready" as const),
      new Promise<"timeout">((resolve) => {
        readinessTimeout = setTimeout(() => resolve("timeout"), 4_000);
      }),
    ]);
  } finally {
    clearTimeout(readinessTimeout);
  }
  assert.equal(outcome, "ready", `${what}: startCompanionServer did not publish readiness`);
  return started;
}

test("readiness is published while the first maintenance pass waits on the extraction lock", { timeout: 15_000 }, async (t) => {
  pinMiningOff(t);
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-ai-startup-readiness-"));
  const workspacePath = await mkdtemp(join(tmpdir(), "clone-ai-startup-readiness-ws-"));
  await seedPendingExtraction(dataDirectory);
  const holder = await holdExtractionLock(dataDirectory);

  let closed = false;
  const started = startCompanionServer({ port: 0, dataDirectory, workspacePath });
  t.after(async () => {
    holder.release();
    const running = await started.catch(() => undefined);
    if (running !== undefined && !closed) await running.close();
    await rm(dataDirectory, { recursive: true, force: true });
    await rm(workspacePath, { recursive: true, force: true });
  });

  const server = await waitForReady(started, "readiness");
  const health = await fetch(`${server.url}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json() as { ok: boolean }).ok, true);

  // Readiness must not have skipped the pass: once the lock is free, the
  // pending extraction still runs and journals its marker.
  // 就绪不得跳过维护：锁释放后，待处理的提炼仍会运行并写入标记。
  holder.release();
  const maintenanceDeadline = Date.now() + 5_000;
  while (true) {
    const probe = createJournalStore(dataDirectory);
    try {
      const extracted = (await probe.list()).some((event) => event.type === "memory.candidate.extracted"
        && event.runId === "run-startup");
      if (extracted) break;
    } finally {
      (probe as { close?: () => void }).close?.();
    }
    assert.ok(Date.now() < maintenanceDeadline, "the first maintenance pass did not run after readiness");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await server.close();
  closed = true;
});

test("opportunity cards stay current and close() returns while the extraction lock is held", { timeout: 15_000 }, async (t) => {
  pinMiningOff(t);
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-ai-startup-cards-"));
  const workspacePath = await mkdtemp(join(tmpdir(), "clone-ai-startup-cards-ws-"));
  await seedPendingExtraction(dataDirectory);
  await seedDeadline(dataDirectory);
  const holder = await holdExtractionLock(dataDirectory);

  let closed = false;
  const started = startCompanionServer({ port: 0, dataDirectory, workspacePath });
  t.after(async () => {
    holder.release();
    const running = await started.catch(() => undefined);
    if (running !== undefined && !closed) await running.close();
    await rm(dataDirectory, { recursive: true, force: true });
    await rm(workspacePath, { recursive: true, force: true });
  });

  const server = await waitForReady(started, "lock held");

  // The scan runs before the extraction drain, so the owner's first paint gets
  // the due deadline even while another process holds the extraction lock.
  // 机会扫描先于提炼排空，因此即使别的进程持有提炼锁，所有者首屏也能看到到期承诺。
  const cardDeadline = Date.now() + 3_000;
  while (true) {
    const listed = await (await companionFetch(server.url, server.token, "/api/opportunities")).json() as {
      opportunities?: Array<{ title?: string }>;
    };
    if ((listed.opportunities ?? []).some((card) => (card.title ?? "").includes("Startup probe deadline"))) break;
    assert.ok(Date.now() < cardDeadline, "the opportunity scan did not run while the extraction lock was held");
    await new Promise((resolve) => setTimeout(resolve, 40));
  }

  // Shutdown must not wait for the lock either: close() aborts the wait and the
  // pass unwinds before the journal is closed.
  // 关停同样不得等待该锁：close() 中止等待，维护轮在 Journal 关闭前解除。
  const closeStarted = Date.now();
  await server.close();
  closed = true;
  assert.ok(Date.now() - closeStarted < 2_000, "close() waited for the extraction lock");
});