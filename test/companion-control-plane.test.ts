import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import { startCompanionServer, type RunningCompanionServer } from "../src/companion-server.ts";
import { mainAgentLockPath } from "../src/main-agent/prompt-lock.ts";
import { ScheduleStore } from "../src/scheduling/schedule-store.ts";
import { localDayKey } from "../src/reporting/daily-report-runner.ts";
import { createRuntimeAssembly } from "../src/core/runtime-factory.ts";
import { createScriptedAgentRegistry } from "./fixtures/scripted-adapter.ts";
import { StaticAgentRegistry } from "../src/workers/static-worker-registry.ts";
import { companionFetch } from "./helpers/companion-api.ts";
import { beginInvocation, invocationLedgerPath } from "../src/audit/invocation-ledger.ts";
import { appendMainAgentTurnRecord } from "../src/main-agent/turn-audit.ts";
import { createJournalStore } from "../src/core/sqlite-journal.ts";

async function companion(t: TestContext): Promise<{ url: string; token: string; dataDirectory: string }> {
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-ai-control-"));
  const workspacePath = await mkdtemp(join(tmpdir(), "clone-ai-control-ws-"));
  let server: RunningCompanionServer | undefined;
  t.after(async () => {
    await server?.close();
    await rm(dataDirectory, { recursive: true, force: true });
    await rm(workspacePath, { recursive: true, force: true });
  });
  server = await startCompanionServer({ port: 0, dataDirectory, workspacePath });
  return { url: server.url, token: server.token, dataDirectory };
}

test("health is public; approve without a bearer is 401", async (t) => {
  const { url, token } = await companion(t);

  const health = await fetch(`${url}/api/health`);
  assert.equal(health.status, 200);
  const body = await health.json() as {
    ok: boolean;
    journal: string;
    queue: { inFlight: number };
    runs: { byStatus: Record<string, number>; terminalCount: number; averageDurationMs: number | null };
  };
  assert.equal(body.ok, true);
  assert.equal(body.journal, "ok");
  assert.equal(typeof body.queue.inFlight, "number");
  assert.equal(typeof body.runs.byStatus.completed, "number");
  assert.equal(body.runs.terminalCount, 0);
  assert.equal(body.runs.averageDurationMs, null);

  const unauthenticated = await fetch(`${url}/api/runs/missing/approve`, { method: "POST" });
  assert.equal(unauthenticated.status, 401);

  const page = await fetch(`${url}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), new RegExp(`CLONE_AI_TOKEN="${token}"`));
});

test("the audit API exposes shared Agent invocations and their visible output", async (t) => {
  const { url, token, dataDirectory } = await companion(t);
  const handle = await beginInvocation({
    prompt: "审计一次 Agent 调用",
    surface: "cli",
    workspacePath: dataDirectory,
    dataDirectory,
    auditHome: dataDirectory,
    caller: { kind: "codex", sessionId: "thread-audit" },
    environment: { HOME: dataDirectory },
  });
  handle.note({ modelId: "deepseek-v4.1", effort: "high" });
  await handle.complete({ reply: "这是可见输出。", newRuns: [{ id: "run-visible", status: "completed" }] });

  const listed = await companionFetch(url, token, "/api/invocations");
  const body = await listed.json() as { records: Array<{ id: string; caller: { kind: string }; status: string; reply?: string }>; total: number };
  assert.equal(body.records[0]?.id, handle.id);
  assert.equal(body.records[0]?.caller.kind, "codex");
  assert.equal(body.records[0]?.status, "completed");
  assert.equal(body.records[0]?.reply, "这是可见输出。");
  assert.equal(body.total, 1);

  const detail = await companionFetch(url, token, `/api/invocations/${handle.id}`);
  assert.equal(detail.status, 200);
  assert.equal((await detail.json() as { record: { newRuns: unknown[] } }).record.newRuns.length, 1);
});

test("invocations can be searched, hidden and restored through the audit API", async (t) => {
  const { url, token, dataDirectory } = await companion(t);
  const location = { dataDirectory, auditHome: dataDirectory, environment: { HOME: dataDirectory } };
  const meeting = await beginInvocation({
    prompt: "整理今天的会议记录",
    surface: "cli",
    workspacePath: dataDirectory,
    dataDirectory,
    auditHome: dataDirectory,
    caller: { kind: "claude-code", sessionId: "thread-meeting" },
    environment: { HOME: dataDirectory },
  });
  await meeting.complete({ reply: "会议记录已整理。", newRuns: [{ id: "run-meeting-42", status: "completed" }] });
  const palace = await beginInvocation({
    prompt: "重建故宫 3D 模型",
    surface: "desktop",
    workspacePath: dataDirectory,
    dataDirectory,
    auditHome: dataDirectory,
    caller: { kind: "codex", sessionId: "thread-palace" },
    environment: { HOME: dataDirectory },
  });
  await palace.complete({ reply: "模型已完成。" });

  const searched = await companionFetch(url, token, `/api/invocations?q=${encodeURIComponent("会议")}`);
  const found = await searched.json() as { records: Array<{ id: string }>; total: number };
  assert.deepEqual(found.records.map((record) => record.id), [meeting.id]);
  assert.equal(found.total, 1);

  const hidden = await companionFetch(url, token, "/api/invocations/delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: [meeting.id] }),
  });
  assert.equal(hidden.status, 200);
  assert.equal((await hidden.json() as { changed: number }).changed, 1);

  const visible = await companionFetch(url, token, "/api/invocations");
  const visibleBody = await visible.json() as { records: Array<{ id: string }>; total: number };
  assert.deepEqual(visibleBody.records.map((record) => record.id), [palace.id]);
  assert.equal(visibleBody.total, 1);

  const withDeleted = await companionFetch(url, token, "/api/invocations?includeDeleted=1");
  const withDeletedBody = await withDeleted.json() as { records: Array<{ id: string; deleted?: boolean }>; total: number };
  assert.equal(withDeletedBody.total, 2);
  assert.equal(withDeletedBody.records.find((record) => record.id === meeting.id)?.deleted, true);

  const detail = await companionFetch(url, token, `/api/invocations/${meeting.id}`);
  assert.equal(detail.status, 200, "a hidden record stays readable for restore");

  const restored = await companionFetch(url, token, "/api/invocations/restore", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: [meeting.id] }),
  });
  assert.equal(restored.status, 200);
  const afterRestore = await companionFetch(url, token, "/api/invocations");
  assert.equal((await afterRestore.json() as { total: number }).total, 2);

  // Padded ids are trimmed; an unknown id is not a change; an oversized id is refused.
  // 带空白的 id 会被裁剪；未知 id 不算变更；超长 id 会被拒绝。
  const padded = await companionFetch(url, token, "/api/invocations/delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: [` ${palace.id} `] }),
  });
  assert.equal((await padded.json() as { changed: number }).changed, 1);
  const afterPadded = await companionFetch(url, token, "/api/invocations");
  assert.deepEqual(
    ((await afterPadded.json() as { records: Array<{ id: string }> }).records).map((record) => record.id),
    [meeting.id],
  );
  await companionFetch(url, token, "/api/invocations/restore", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: [palace.id] }),
  });

  const stale = await companionFetch(url, token, "/api/invocations/delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: ["does-not-exist"] }),
  });
  assert.equal((await stale.json() as { changed: number }).changed, 0);

  const oversized = await companionFetch(url, token, "/api/invocations/delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: ["A".repeat(500)] }),
  });
  assert.equal(oversized.status, 400);

  const invalid = await companionFetch(url, token, "/api/invocations/delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: [] }),
  });
  assert.equal(invalid.status, 400);

  // The test runner sets NODE_TEST_CONTEXT, so beginInvocation's explicit
  // auditHome and the server's default both resolve to <dataDirectory>/audit;
  // neither touches the owner's home.
  // 测试运行器会设置 NODE_TEST_CONTEXT，因此 beginInvocation 的显式 auditHome 与服务器的
  // 默认解析都指向 <dataDirectory>/audit；两者都不会写所有者主目录。
  const raw = await readFile(invocationLedgerPath(location), "utf8");
  assert.match(raw, /整理今天的会议记录/);
});

test("a non-loopback Origin is refused even with a valid bearer", async (t) => {
  const { url, token } = await companion(t);
  const response = await fetch(`${url}/api/config`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: "http://example.com",
    },
  });
  assert.equal(response.status, 403);
});

test("an uncertain scheduled occurrence is visible and requires an explicit resolution", async (t) => {
  const { url, token, dataDirectory } = await companion(t);
  const store = new ScheduleStore(join(dataDirectory, "schedules.json"));
  await store.addDaily({ query: "检查不确定的定时结果", time: "08:00" });
  await store.claimDue(new Date(2035, 0, 2, 9, 0));
  const occurrence = (await store.listOccurrences())[0]!;
  await store.beginOccurrence(occurrence.id, "interrupted-dispatch");
  await store.recoverAbandonedOccurrences(() => false);

  const listed = await companionFetch(url, token, "/api/schedules");
  const body = await listed.json() as { occurrences: Array<{ id: string; status: string }> };
  assert.equal(body.occurrences.find((item) => item.id === occurrence.id)?.status, "unknown");

  const path = `/api/schedules/occurrences/${encodeURIComponent(occurrence.id)}/resolve`;
  const anonymous = await fetch(`${url}${path}`, { method: "POST" });
  assert.equal(anonymous.status, 401);
  const invalid = await companionFetch(url, token, path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resolution: "automatic" }),
  });
  assert.equal(invalid.status, 400);
  const resolved = await companionFetch(url, token, path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resolution: "dismiss" }),
  });
  assert.equal(resolved.status, 200);
  assert.equal((await store.listOccurrences())[0]?.status, "dismissed");
});

test("an uncertain daily email is visible and can only be dismissed after confirmation", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-ai-report-api-"));
  const workspacePath = await mkdtemp(join(tmpdir(), "clone-ai-report-api-ws-"));
  let server: RunningCompanionServer | undefined;
  t.after(async () => { await server?.close(); await rm(dataDirectory, { recursive: true, force: true }); await rm(workspacePath, { recursive: true, force: true }); });
  const day = localDayKey(new Date());
  await mkdir(join(dataDirectory, "reporting"), { recursive: true });
  await writeFile(join(dataDirectory, "reporting.json"), JSON.stringify({ enabled: true, smtp: { host: "127.0.0.1", port: 1, from: "a@b", to: "c@d" } }));
  await writeFile(join(dataDirectory, "reporting", "last-sent.json"), JSON.stringify({ day, status: "dispatching" }));
  server = await startCompanionServer({ port: 0, dataDirectory, workspacePath });
  const { url, token } = server;
  const listed = await companionFetch(url, token, "/api/schedules");
  const body = await listed.json() as { reportDeliveries: Array<{ day: string; status: string }> };
  assert.deepEqual(body.reportDeliveries, [{ day, status: "unknown" }]);
  const endpoint = `/api/reporting/deliveries/${day}/resolve`;
  const missingConfirmation = await companionFetch(url, token, endpoint, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resolution: "dismiss" }),
  });
  assert.equal(missingConfirmation.status, 400);
  const confirmed = await companionFetch(url, token, endpoint, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resolution: "dismiss", confirmChecked: true }),
  });
  assert.equal(confirmed.status, 200);
  const after = await companionFetch(url, token, "/api/schedules");
  assert.deepEqual((await after.json() as { reportDeliveries: unknown[] }).reportDeliveries, []);
});

test("a corrupt email marker is surfaced without blocking the rest of the desktop", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-ai-report-corrupt-api-"));
  const workspacePath = await mkdtemp(join(tmpdir(), "clone-ai-report-corrupt-ws-"));
  let server: RunningCompanionServer | undefined;
  t.after(async () => { await server?.close(); await rm(dataDirectory, { recursive: true, force: true }); await rm(workspacePath, { recursive: true, force: true }); });
  await mkdir(join(dataDirectory, "reporting"), { recursive: true });
  await writeFile(join(dataDirectory, "reporting.json"), JSON.stringify({ enabled: true, smtp: { host: "127.0.0.1", port: 1, from: "a@b", to: "c@d" } }));
  await writeFile(join(dataDirectory, "reporting", "last-sent.json"), "malformed");
  server = await startCompanionServer({ port: 0, dataDirectory, workspacePath });
  const response = await companionFetch(server.url, server.token, "/api/schedules");
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { reportError: boolean }).reportError, true);
});

test("the owner can review unverified criteria through the authenticated API", async (t) => {
  const { url, token, dataDirectory } = await companion(t);
  const assembly = await createRuntimeAssembly({ dataDirectory, workspacePath: dataDirectory });
  let runId: string;
  try {
    const { run } = await assembly.runtime.acceptTrigger({ kind: "query", summary: "整理个人简报", payload: {} });
    runId = run.id;
    await assembly.runtime.attachPlan(runId, {
      summary: "准备简报",
      steps: [{ id: "brief", title: "简报", instructions: "整理简报", risk: "read_only", acceptanceCriteria: ["内容准确"], agentId: "evidence-reviewer", requiredCapabilities: ["review"] }],
    });
    assert.equal((await assembly.runtime.execute(runId, createScriptedAgentRegistry())).status, "waiting_review");
  } finally {
    assembly.close();
  }

  const session = await companionFetch(url, token, `/api/sessions/${runId}`);
  const view = await session.json() as {
    status: string;
    verification: { unverifiedCriteria: string[] };
    reviews?: Array<{ runId: string; title: string; verification: { unverifiedCriteria: string[] } }>;
  };
  assert.equal(view.status, "waiting_review");
  assert.ok(view.verification.unverifiedCriteria.some((item) => item.includes("内容准确")));
  // The task record owns the review card and its run id. 任务记录拥有复核卡与它的 Run id。
  assert.equal(view.reviews?.length, 1);
  assert.equal(view.reviews?.[0]?.runId, runId);
  assert.ok(view.reviews?.[0]?.verification.unverifiedCriteria.some((item) => item.includes("内容准确")));
  const conversation = await (await companionFetch(url, token, "/api/sessions/main-agent-conversation")).json() as {
    approvals: unknown[];
    reviews?: unknown[];
  };
  assert.deepEqual(conversation.approvals, []);
  assert.deepEqual(conversation.reviews ?? [], []);
  const path = `/api/runs/${runId}/review`;
  assert.equal((await fetch(`${url}${path}`, { method: "POST" })).status, 401);
  const invalid = await companionFetch(url, token, path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "auto" }) });
  assert.equal(invalid.status, 400);
  const accepted = await companionFetch(url, token, path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "accept" }) });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json() as { status: string }).status, "completed");
  const repeated = await companionFetch(url, token, path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "accept" }) });
  assert.equal(repeated.status, 409);
});

test("a second Main Agent query is 409 while the session lock is held", async (t) => {
  const { url, token, dataDirectory } = await companion(t);
  const path = mainAgentLockPath(dataDirectory);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${process.pid}\n`, "utf8");

  const response = await companionFetch(url, token, "/api/main-agent/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hello there" }),
  });
  assert.equal(response.status, 409);
  assert.match((await response.json() as { error: string }).error, /already answering/);
});

test("a prompt in another conversation is not blocked by the main conversation lock", async (t) => {
  const { url, token, dataDirectory } = await companion(t);
  const path = mainAgentLockPath(dataDirectory);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${process.pid}\n`, "utf8");
  // An unreachable endpoint keeps the test offline while proving the request
  // passed the lock: it fails at the model call, not with the busy 409.
  // 不可达端点让测试保持离线，同时证明请求越过了锁：它失败在模型调用，而不是忙碌的 409。
  await writeFile(join(dataDirectory, "config.json"), JSON.stringify({
    version: 1,
    mainAgentBaseUrl: "http://127.0.0.1:9",
    mainAgentModel: "test-model",
  }), "utf8");

  const response = await companionFetch(url, token, "/api/main-agent/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hello there", conversationId: "conversation-other" }),
  });
  assert.notEqual(response.status, 409);
  const body = await response.json() as { error?: string };
  assert.doesNotMatch(body.error ?? "", /already answering/);
});

test("a conversation id that could escape a path is refused", async (t) => {
  const { url, token } = await companion(t);
  const response = await companionFetch(url, token, "/api/main-agent/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hello there", conversationId: "../outside" }),
  });
  assert.equal(response.status, 400);
});

test("the sidebar shows tasks, not one session per conversational turn", async (t) => {
  const { url, token, dataDirectory } = await companion(t);
  const assembly = await createRuntimeAssembly({ dataDirectory });
  try {
    // A greeting: the Main Agent answers with a one-step direct_response plan. 打招呼：Main Agent 用一个 direct_response 单步计划作答。
    const chat = await assembly.runtime.acceptTrigger({ kind: "query", summary: "你好", payload: {} });
    await assembly.runtime.attachPlan(chat.run.id, {
      summary: "直接回答",
      steps: [{ id: "reply", title: "直接回答", instructions: "回答", risk: "read_only", acceptanceCriteria: ["已回答"], agentId: "direct-responder", requiredCapabilities: ["direct_response"] }],
    });
    // A real task, which must stay visible. 真正的任务必须保留。
    const task = await assembly.runtime.acceptTrigger({ kind: "query", summary: "写一份周报", payload: {} });
    await assembly.runtime.attachPlan(task.run.id, {
      summary: "写周报",
      steps: [{ id: "draft", title: "起草", instructions: "起草", risk: "reversible_write", acceptanceCriteria: ["草稿存在"], agentId: "draft-maker", requiredCapabilities: ["drafting"] }],
    });

    const response = await companionFetch(url, token, "/api/dashboard");
    assert.equal(response.status, 200);
    const body = await response.json() as { sessions: Array<{ id: string; title: string }> };
    const ids = body.sessions.map((session) => session.id);
    assert.equal(ids.includes(chat.run.id), false, "a conversational turn must not become a sidebar session");
    assert.equal(ids.includes(task.run.id), true, "a real task stays in the sidebar");
    // The run is still a durable fact; only its presentation changed. Run 仍是持久事实，只改变呈现。
    assert.ok(await assembly.runtime.getRun(chat.run.id));
  } finally {
    assembly.close();
  }
});

test("sidebar previews are plain text, one line, never raw markdown", async () => {
  const { plainText } = await import("../src/companion-server.ts");
  const preview = plainText("**本周周报** 已完成：\n\n- 进展 ✅\n- 阻塞：`部署` 等确认\n\n## 下周\n1. 收尾");
  assert.equal(preview.includes("**"), false);
  assert.equal(preview.includes("`"), false);
  assert.equal(preview.includes("#"), false);
  assert.match(preview, /本周周报 已完成/);
  assert.equal(plainText("----").length >= 0, true);
  // Long text is cut by the caller, which slices to a sidebar width. 长文本由调用方按侧栏宽度截断。
  assert.equal(plainText("  多   空格  "), "多 空格");
});

test("a run's full trace is ordered, readable, and keeps raw data one level down", async (t) => {
  const { url, token, dataDirectory } = await companion(t);
  const assembly = await createRuntimeAssembly({ dataDirectory });
  try {
    const { run } = await assembly.runtime.acceptTrigger({ kind: "query", summary: "整理周报", payload: {} });
    await assembly.runtime.attachPlan(run.id, {
      summary: "整理周报",
      steps: [{ id: "draft", title: "起草", instructions: "起草", risk: "reversible_write", acceptanceCriteria: ["草稿存在"], agentId: "draft-maker", requiredCapabilities: ["drafting"] }],
    });
    const response = await companionFetch(url, token, `/api/runs/${run.id}/trace`);
    assert.equal(response.status, 200);
    const body = await response.json() as { items: Array<{ sequence: number; label: string; detail: string; payload: string }> };
    assert.ok(body.items.length >= 4);
    assert.deepEqual(body.items.map((item) => item.sequence), [...body.items.map((item) => item.sequence)].sort((a, b) => a - b));
    const labels = body.items.map((item) => item.label);
    assert.ok(labels.includes("收到请求"));
    assert.ok(labels.includes("生成执行计划"));
    const plan = body.items.find((item) => item.label === "生成执行计划")!;
    assert.match(plan.detail, /1 个步骤：起草/);
    assert.ok(body.items.every((item) => typeof item.payload === "string" && item.payload.length > 0));

    const missing = await companionFetch(url, token, "/api/runs/nope/trace");
    assert.equal(missing.status, 404);
  } finally {
    assembly.close();
  }
});

test("a derived task belongs to the conversation, and hiding the chat hides it too", async (t) => {
  const { url, token, dataDirectory } = await companion(t);
  const assembly = await createRuntimeAssembly({ dataDirectory });
  try {
    const { run } = await assembly.runtime.acceptTrigger({ kind: "query", summary: "总结今天的工作", payload: { source: "main-agent" } });
    await assembly.runtime.attachPlan(run.id, {
      summary: "总结今天的工作",
      steps: [{ id: "scan", title: "扫描", instructions: "扫描", risk: "read_only", acceptanceCriteria: ["完成"], agentId: "draft-maker", requiredCapabilities: ["drafting"] }],
    });
    // The chat summary is projected from the Main Agent's own turn ledger. 对话摘要来自主 Agent 的回合账本。
    await writeFile(join(dataDirectory, "main-agent-turns.jsonl"), `${JSON.stringify({
      id: "turn-1", text: "总结今天的工作", status: "completed",
      startedAt: "2026-11-04T09:00:00.000Z", completedAt: "2026-11-04T09:00:05.000Z", reply: "已提交计划。",
    })}\n`, "utf8");

    const before = await (await companionFetch(url, token, "/api/dashboard")).json() as {
      sessions: Array<{ id: string; conversationId?: string; kind?: string }>;
      deletedConversations: unknown[];
    };
    // Conversations are not rows when their task is a row: the run names the
    // conversation that spawned it, and the task represents the request.
    // 任务已成为行时对话不再单独成行：Run 携带派生它的对话，任务代表这次请求。
    assert.equal(before.sessions.some((session) => session.kind === "conversation" && session.id === "main-agent-conversation"), false);
    const child = before.sessions.find((session) => session.id === run.id);
    assert.equal(child?.conversationId, "main-agent-conversation", "the run is a task of the conversation that spawned it");
    const runView = await (await companionFetch(url, token, `/api/sessions/${run.id}`)).json() as { dispatchedBy?: string };
    assert.equal(runView.dispatchedBy, "main-agent-conversation", "the task record names the Main Agent that dispatched it");
    assert.deepEqual(before.deletedConversations, []);

    const hidden = await companionFetch(url, token, "/api/sessions/main-agent-conversation", { method: "DELETE" });
    assert.equal(hidden.status, 204);
    const afterDelete = await (await companionFetch(url, token, "/api/dashboard")).json() as {
      sessions: Array<{ id: string }>;
      deletedConversations: Array<{ id: string; childCount: number }>;
    };
    assert.equal(afterDelete.sessions.some((session) => session.id === run.id), false, "the child is hidden with its chat");
    assert.equal(afterDelete.deletedConversations.length, 1);
    assert.equal(afterDelete.deletedConversations[0]?.childCount, 1);
    const gone = await companionFetch(url, token, "/api/sessions/main-agent-conversation");
    assert.equal(gone.status, 404);

    const restored = await companionFetch(url, token, "/api/sessions/main-agent-conversation/restore", { method: "POST" });
    assert.equal(restored.status, 204);
    const afterRestore = await (await companionFetch(url, token, "/api/dashboard")).json() as { sessions: Array<{ id: string }> };
    assert.ok(afterRestore.sessions.some((session) => session.id === run.id), "restoring the chat restores its task");
  } finally {
    assembly.close();
  }
});

test("a conversation row owns its dispatched runs and aggregates their status", async (t) => {
  const { url, token, dataDirectory } = await companion(t);
  const assembly = await createRuntimeAssembly({ dataDirectory });
  try {
    const at = "2026-11-04T09:00:00.000Z";
    await writeFile(join(dataDirectory, "main-agent-turns.jsonl"), `${JSON.stringify({
      id: "turn-x", text: "整理资料", status: "completed",
      startedAt: at, completedAt: at, reply: "已整理。", conversationId: "conversation-x",
    })}\n`, "utf8");
    const first = await assembly.runtime.acceptTrigger({
      kind: "query", summary: "派发一", payload: { source: "main-agent", conversationId: "conversation-x" },
    });
    await assembly.runtime.attachPlan(first.run.id, {
      summary: "派发一",
      steps: [{ id: "send", title: "发送", instructions: "发送到外部", risk: "external_side_effect", acceptanceCriteria: ["receipt"], agentId: "draft-maker", requiredCapabilities: ["drafting"] }],
    });
    const paused = await assembly.runtime.execute(first.run.id, new StaticAgentRegistry([]));
    assert.equal(paused.status, "waiting_approval");
    const second = await assembly.runtime.acceptTrigger({
      kind: "query", summary: "派发二", payload: { source: "main-agent", conversationId: "conversation-x" },
    });
    await assembly.runtime.attachPlan(second.run.id, {
      summary: "派发二",
      steps: [{ id: "draft", title: "起草", instructions: "起草", risk: "reversible_write", acceptanceCriteria: ["草稿"], agentId: "draft-maker", requiredCapabilities: ["drafting"] }],
    });

    const dashboard = await (await companionFetch(url, token, "/api/dashboard")).json() as {
      sessions: Array<{
        id: string; kind?: string; status: string; title: string;
        childCount?: number; parentId?: string; conversationId?: string;
      }>;
    };
    const conversation = dashboard.sessions.find((session) => session.id === "conversation-x");
    assert.equal(conversation?.kind, "conversation", "the conversation is a row");
    assert.equal(conversation?.title, "整理资料", "the first request names the thread");
    assert.equal(conversation?.childCount, 2, "both dispatched runs belong to it");
    assert.equal(conversation?.status, "waiting_approval", "a waiting child colors the parent row");
    const children = dashboard.sessions.filter((session) => session.parentId === "conversation-x");
    assert.deepEqual(new Set(children.map((child) => child.id)), new Set([first.run.id, second.run.id]));
    assert.ok(children.every((child) => child.conversationId === "conversation-x"));
    assert.equal(
      dashboard.sessions.filter((session) => session.id === "conversation-x").length,
      1,
      "the conversation is not duplicated beside its children",
    );
  } finally {
    assembly.close();
  }
});

test("a paused run is offered for phone approval and the request is journaled", async (t) => {
  const { url, token, dataDirectory } = await companion(t);
  const assembly = await createRuntimeAssembly({ dataDirectory });
  try {
    const { run } = await assembly.runtime.acceptTrigger({ kind: "query", summary: "发送周报", payload: {} });
    await assembly.runtime.attachPlan(run.id, {
      summary: "发送周报",
      steps: [{ id: "send", title: "发送", instructions: "发送到外部", risk: "external_side_effect", acceptanceCriteria: ["receipt"], agentId: "draft-maker", requiredCapabilities: ["drafting"] }],
    });
    const executed = await assembly.runtime.execute(run.id, new StaticAgentRegistry([]));
    assert.equal(executed.status, "waiting_approval");

    const pending = await (await companionFetch(url, token, "/api/approvals/pending")).json() as {
      approvals: Array<{ runId: string; stepId: string; title: string }>;
    };
    const match = pending.approvals.find((approval) => approval.runId === run.id);
    assert.ok(match, "the paused run must be offered");
    assert.equal(match.stepId, "send");
    assert.equal(match.title, "发送周报");

    const recorded = await companionFetch(url, token, "/api/approvals/requested", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: run.id, stepId: "send", codeId: "code-1", expiresAt: "2026-11-05T10:10:00.000Z" }),
    });
    assert.equal(recorded.status, 200);
    const event = (await assembly.journal.list()).find((item) => item.type === "approval.requested");
    assert.equal((event?.payload as { channel: string }).channel, "whatsapp");
    assert.equal((event?.payload as { stepId: string }).stepId, "send");

    const missing = await companionFetch(url, token, "/api/approvals/requested", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "nope", stepId: "send" }),
    });
    assert.equal(missing.status, 404);
  } finally {
    assembly.close();
  }
});

test("an approval names the step it was issued for, and a mismatch is refused", async (t) => {
  // A WhatsApp approval code describes one step. The route approved whatever was
  // active, so a stale code could approve a step it never described.
  // WhatsApp 审批码描述的是某一步。路由放行当时活动的那一步，因此过期审批码可能批准它从未描述的步骤。
  const { url, token, dataDirectory } = await companion(t);
  const assembly = await createRuntimeAssembly({ dataDirectory, workspacePath: dataDirectory });
  let runId: string;
  try {
    const { run } = await assembly.runtime.acceptTrigger({ kind: "query", summary: "准备发布", payload: {} });
    runId = run.id;
    await assembly.runtime.attachPlan(runId, {
      summary: "发布",
      steps: [{ id: "publish", title: "发布", instructions: "发送公告", risk: "external_side_effect", acceptanceCriteria: ["已发送"], agentId: "evidence-reviewer", requiredCapabilities: ["review"] }],
    });
    const result = await assembly.runtime.execute(runId, createScriptedAgentRegistry());
    assert.equal(result.status, "waiting_approval");
  } finally {
    assembly.close();
  }
  const path = `/api/runs/${runId}/approve`;
  const wrong = await companionFetch(url, token, path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stepId: "some-other-step" }),
  });
  assert.equal(wrong.status, 409);
  assert.match((await wrong.json() as { error: string }).error, /issued for step/);
});

test("each task has its own conversation and its own history", async (t) => {
  const { url, token, dataDirectory } = await companion(t);
  const at = new Date().toISOString();
  await appendMainAgentTurnRecord(dataDirectory, {
    id: "turn-a",
    text: "整理资料",
    status: "completed",
    startedAt: at,
    completedAt: at,
    reply: "已整理。",
    conversationId: "conversation-a",
  });
  await appendMainAgentTurnRecord(dataDirectory, {
    id: "turn-b",
    text: "写周报",
    status: "completed",
    startedAt: at,
    completedAt: at,
    reply: "已写完。",
    conversationId: "conversation-b",
  });

  const dashboardResponse = await companionFetch(url, token, "/api/dashboard");
  assert.equal(dashboardResponse.status, 200);
  const dashboard = await dashboardResponse.json() as { sessions: Array<{ id: string; kind?: string }> };
  // A request that dispatched no task is still a row: the twin answered it, and
  // the owner must be able to reopen it. The main conversation is not a row.
  // 没有派发任务的请求仍然是一行：分身回答了它，所有者必须能重新打开。主对话不是一行。
  const conversationRows = dashboard.sessions.filter((session) => session.kind === "conversation");
  assert.deepEqual(new Set(conversationRows.map((session) => session.id)), new Set(["conversation-a", "conversation-b"]));
  assert.equal(conversationRows.some((session) => session.id === "main-agent-conversation"), false);

  const viewResponse = await companionFetch(url, token, "/api/sessions/conversation-a");
  assert.equal(viewResponse.status, 200);
  const view = await viewResponse.json() as {
    id: string;
    kind?: string;
    messages: Array<{ role: string; text: string }>;
    turns?: Array<{ kind: string; input: string; reply?: string; status: string }>;
  };
  assert.equal(view.id, "conversation-a");
  assert.equal(view.kind, "conversation");
  assert.ok(view.messages.some((message) => message.role === "person" && message.text === "整理资料"));
  assert.ok(view.messages.some((message) => message.role === "clone" && message.text === "已整理。"));
  // The other task's turn is not part of this transcript. 另一个任务的回合不属于这份转录。
  assert.ok(!view.messages.some((message) => message.text.includes("写周报")));

  const otherView = await (await companionFetch(url, token, "/api/sessions/conversation-b")).json() as {
    messages: Array<{ text: string }>;
  };
  assert.ok(otherView.messages.some((message) => message.text === "写周报"));
  assert.ok(!otherView.messages.some((message) => message.text.includes("整理资料")));
  // The dispatch log is scoped the same way: one turn for this conversation.
  // 派发日志同样按对话限定：这个对话只有一个回合。
  assert.deepEqual(view.turns?.map((turn) => turn.input), ["整理资料"]);
  assert.equal(view.turns?.[0]?.reply, "已整理。");
  assert.equal(view.turns?.[0]?.status, "completed");
  assert.ok(view.turns?.every((turn) => !turn.input.includes("写周报")));
});

test("the conversation log is bounded and counts the turns it omitted", async (t) => {
  // The pane shows the newest turns; returning the whole history made one
  // session poll grow without bound.
  // 面板显示最近的回合；返回全部历史会让一次会话轮询无界增长。
  const { url, token, dataDirectory } = await companion(t);
  const at = new Date().toISOString();
  for (let index = 0; index < 61; index += 1) {
    await appendMainAgentTurnRecord(dataDirectory, {
      id: `turn-${index}`,
      text: `第 ${index} 轮`,
      status: "completed",
      startedAt: at,
      completedAt: at,
      reply: `回复 ${index}`,
      conversationId: "conversation-cap",
    });
  }
  const response = await companionFetch(url, token, "/api/sessions/conversation-cap");
  assert.equal(response.status, 200);
  const view = await response.json() as { turns?: Array<{ input: string }>; turnsOmitted?: number };
  assert.equal(view.turns?.length, 60);
  assert.equal(view.turnsOmitted, 1);
  assert.equal(view.turns?.[0]?.input, "第 1 轮");
  assert.equal(view.turns?.[59]?.input, "第 60 轮");
});

test("a spawned run that is no longer visible is reported as hidden, not as a dead link", async (t) => {
  const { url, token, dataDirectory } = await companion(t);
  const at = new Date().toISOString();
  await appendMainAgentTurnRecord(dataDirectory, {
    id: "turn-spawn",
    text: "派发一个任务",
    status: "completed",
    startedAt: at,
    completedAt: at,
    reply: "已派发。",
    conversationId: "conversation-spawn",
  });
  const journal = createJournalStore(dataDirectory);
  try {
    await journal.append({
      type: "main_agent.turn_started",
      payload: { schemaVersion: 1, turnId: "turn-spawn", conversationId: "conversation-spawn", source: "companion", input: "派发一个任务", startedAt: at },
    });
    await journal.append({
      type: "main_agent.turn_completed",
      payload: { schemaVersion: 1, turnId: "turn-spawn", conversationId: "conversation-spawn", status: "completed", reply: "已派发。", startedAt: at, completedAt: at, spawnedRunIds: ["run-missing"] },
    });
  } finally {
    (journal as { close?: () => void }).close?.();
  }
  const response = await companionFetch(url, token, "/api/sessions/conversation-spawn");
  assert.equal(response.status, 200);
  const view = await response.json() as { turns?: Array<{ spawnedRuns: Array<{ id: string; hidden?: boolean }> }> };
  assert.deepEqual(view.turns?.[0]?.spawnedRuns, [{ id: "run-missing", hidden: true }]);
});

test("the main conversation does not absorb another task's turns", async (t) => {
  const { url, token, dataDirectory } = await companion(t);
  const taskAt = new Date(Date.now() - 60_000).toISOString();
  const mainAt = new Date().toISOString();
  await appendMainAgentTurnRecord(dataDirectory, {
    id: "task-secret-turn",
    text: "任务A的秘密",
    status: "completed",
    startedAt: taskAt,
    completedAt: taskAt,
    reply: "任务A完成",
    conversationId: "conversation-a",
  });
  await appendMainAgentTurnRecord(dataDirectory, {
    id: "main-turn",
    text: "主对话的问题",
    status: "completed",
    startedAt: mainAt,
    completedAt: mainAt,
    reply: "主对话的回答",
  });

  const mainView = await (await companionFetch(url, token, "/api/sessions/main-agent-conversation")).json() as {
    messages: Array<{ text: string }>;
  };
  const mainTexts = mainView.messages.map((message) => message.text);
  assert.ok(mainTexts.includes("主对话的问题"));
  assert.ok(mainTexts.includes("主对话的回答"));
  assert.ok(!mainTexts.some((text) => text.includes("任务A")), "another task's turn must not enter the main thread");

  const taskView = await (await companionFetch(url, token, "/api/sessions/conversation-a")).json() as {
    messages: Array<{ text: string }>;
  };
  assert.ok(taskView.messages.some((message) => message.text === "任务A的秘密"));
  assert.ok(!taskView.messages.some((message) => message.text.includes("主对话的问题")));
});

test("a paused task record carries its own approval and step", async (t) => {
  const { url, token, dataDirectory } = await companion(t);
  const assembly = await createRuntimeAssembly({ dataDirectory });
  let runId: string;
  try {
    const { run } = await assembly.runtime.acceptTrigger({ kind: "query", summary: "发送周报", payload: {} });
    runId = run.id;
    await assembly.runtime.attachPlan(runId, {
      summary: "发送周报",
      steps: [{ id: "send", title: "发送", instructions: "发送到外部", risk: "external_side_effect", acceptanceCriteria: ["receipt"], agentId: "draft-maker", requiredCapabilities: ["drafting"] }],
    });
    assert.equal((await assembly.runtime.execute(runId, new StaticAgentRegistry([]))).status, "waiting_approval");
  } finally {
    assembly.close();
  }

  const view = await (await companionFetch(url, token, `/api/sessions/${runId}`)).json() as {
    status: string;
    approvals: Array<{ runId: string; stepId: string; title?: string; description: string }>;
  };
  assert.equal(view.status, "waiting_approval");
  assert.equal(view.approvals.length, 1, "the task record owns the decision");
  assert.equal(view.approvals[0]!.runId, runId);
  assert.equal(view.approvals[0]!.stepId, "send");
  assert.match(String(view.approvals[0]!.title), /发送/);
  assert.match(view.approvals[0]!.description, /外部/);

  // The conversation is not a decision inbox. 对话不是决定收件箱。
  const conversation = await (await companionFetch(url, token, "/api/sessions/main-agent-conversation")).json() as {
    approvals: unknown[];
    reviews?: unknown[];
  };
  assert.deepEqual(conversation.approvals, []);
  assert.deepEqual(conversation.reviews ?? [], []);
});

test("a hidden conversation does not accept a new turn", async (t) => {
  const { url, token, dataDirectory } = await companion(t);
  const at = new Date().toISOString();
  await appendMainAgentTurnRecord(dataDirectory, {
    id: "hidden-turn",
    text: "隐藏前的问题",
    status: "completed",
    startedAt: at,
    completedAt: at,
    reply: "隐藏前的回答",
    conversationId: "conversation-hidden",
  });
  const deleted = await companionFetch(url, token, "/api/sessions/conversation-hidden", { method: "DELETE" });
  assert.equal(deleted.status, 204);
  const response = await companionFetch(url, token, "/api/main-agent/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "隐藏后的问题", conversationId: "conversation-hidden" }),
  });
  assert.equal(response.status, 409);
  assert.match((await response.json() as { error: string }).error, /hidden/i);
});

test("a bare run id is refused as a conversation id", async (t) => {
  const { url, token } = await companion(t);
  const response = await companionFetch(url, token, "/api/main-agent/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hello", conversationId: "3f7c2c26-1f6b-4c3e-9f4d-2a1b3c4d5e6f" }),
  });
  assert.equal(response.status, 400);
});

test("a new request is routed to an existing or a new Main Agent", async (t) => {
  const { url, token, dataDirectory } = await companion(t);
  const at = new Date().toISOString();
  await appendMainAgentTurnRecord(dataDirectory, {
    id: "route-turn",
    text: "整理报告",
    status: "completed",
    startedAt: at,
    completedAt: at,
    reply: "已整理。",
    conversationId: "conversation-a",
  });

  const continued = await companionFetch(url, token, "/api/main-agent/route", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "继续刚才的报告", context: { kind: "conversation", id: "conversation-a" } }),
  });
  assert.equal(continued.status, 200);
  const continuedBody = await continued.json() as { decision: string; conversationId: string; source: string };
  assert.equal(continuedBody.decision, "continue");
  assert.equal(continuedBody.conversationId, "conversation-a");
  assert.equal(continuedBody.source, "rule");

  const fresh = await companionFetch(url, token, "/api/main-agent/route", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "做一个完全不同的东西" }),
  });
  assert.equal(fresh.status, 200);
  const freshBody = await fresh.json() as { decision: string; conversationId: string };
  assert.equal(freshBody.decision, "new");
  assert.match(freshBody.conversationId, /^conversation-/);
  assert.notEqual(freshBody.conversationId, "conversation-a");

  const invalid = await companionFetch(url, token, "/api/main-agent/route", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hello", context: { kind: "other", id: "x" } }),
  });
  assert.equal(invalid.status, 400);

  const journal = createJournalStore(dataDirectory);
  try {
    const routed = (await journal.list()).filter((event) => event.type === "conversation.routed");
    assert.equal(routed.length, 2);
  } finally {
    (journal as { close?: () => void }).close?.();
  }
});
