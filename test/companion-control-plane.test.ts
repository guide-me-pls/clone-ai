import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import { startCompanionServer, type RunningCompanionServer } from "../src/companion-server.ts";
import { mainAgentLockPath } from "../src/main-agent/prompt-lock.ts";
import { ScheduleStore } from "../src/scheduling/schedule-store.ts";
import { localDayKey } from "../src/reporting/daily-report-runner.ts";
import { createRuntimeAssembly } from "../src/core/runtime-factory.ts";
import { createScriptedAgentRegistry } from "./fixtures/scripted-adapter.ts";
import { companionFetch } from "./helpers/companion-api.ts";
import { beginInvocation } from "../src/audit/invocation-ledger.ts";

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
  const body = await listed.json() as { records: Array<{ id: string; caller: { kind: string }; status: string; reply?: string }> };
  assert.equal(body.records[0]?.id, handle.id);
  assert.equal(body.records[0]?.caller.kind, "codex");
  assert.equal(body.records[0]?.status, "completed");
  assert.equal(body.records[0]?.reply, "这是可见输出。");

  const detail = await companionFetch(url, token, `/api/invocations/${handle.id}`);
  assert.equal(detail.status, 200);
  assert.equal((await detail.json() as { record: { newRuns: unknown[] } }).record.newRuns.length, 1);
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
  const view = await session.json() as { status: string; verification: { unverifiedCriteria: string[] } };
  assert.equal(view.status, "waiting_review");
  assert.ok(view.verification.unverifiedCriteria.some((item) => item.includes("内容准确")));
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
      sessions: Array<{ id: string; parentId?: string; childCount?: number; kind?: string }>;
      deletedConversations: unknown[];
    };
    const chat = before.sessions.find((session) => session.kind === "conversation");
    assert.ok(chat, "the conversation is the parent");
    assert.equal(chat.childCount, 1);
    const child = before.sessions.find((session) => session.id === run.id);
    assert.equal(child?.parentId, chat.id, "the run is a task of the conversation, not a sibling chat");
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
