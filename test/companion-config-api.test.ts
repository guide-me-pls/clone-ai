import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  normalizeMainAgentRequestText,
  readMainAgentTurnRecords,
  reconcileInterruptedMainAgentTurns,
  recordMainAgentClientInterruption,
  startCompanionServer,
  type RunningCompanionServer,
} from "../src/companion-server.ts";
import { createJournalStore } from "../src/core/sqlite-journal.ts";
import { beginMainAgentTurn, finishMainAgentTurn, appendMainAgentTurnRecord } from "../src/main-agent/turn-audit.ts";
import { companionFetch } from "./helpers/companion-api.ts";

async function companion(t: TestContext): Promise<{ url: string; token: string; dataDirectory: string }> {
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-api-home-"));
  const workspacePath = await mkdtemp(join(tmpdir(), "clone-api-ws-"));
  let server: RunningCompanionServer | undefined;
  t.after(async () => {
    await server?.close();
    await rm(dataDirectory, { recursive: true, force: true });
    await rm(workspacePath, { recursive: true, force: true });
  });
  server = await startCompanionServer({ port: 0, dataDirectory, workspacePath });
  return { url: server.url, token: server.token, dataDirectory };
}

test("the config endpoint reports where the owner's data lives", async (t) => {
  const { url, token, dataDirectory } = await companion(t);

  const response = await companionFetch(url, token, "/api/config");
  assert.equal(response.status, 200);
  const body = await response.json() as {
    config: { locale: string };
    ui?: { locale: string; strings?: Record<string, string> };
    paths: Record<string, string>;
  };

  assert.equal(body.paths.dataDirectory, dataDirectory);
  assert.match(body.paths.providersFile, /providers\.json$/);
  assert.equal(body.config.locale, "zh-CN");
  // There is no working-directory setting: neither the config nor the public
  // paths payload exposes one.
  // 没有工作目录设置：配置与公开路径载荷都不暴露它。
  assert.equal("workspacePath" in body.config, false);
  assert.equal("workspacePath" in body.paths, false);
  assert.equal(body.ui?.locale, "zh-CN");
  assert.equal(body.ui?.strings?.["new-session"], "新请求");
  // A settings payload must never become a place a credential could appear.
  // 设置响应绝不能成为凭据可能出现的地方。
  assert.doesNotMatch(JSON.stringify(body), /sk-|api[_-]?key["']?\s*[:=]\s*["'][^"']+/i);
});

test("the model options endpoint exposes only credential-blind selectable references", async (t) => {
  const { url, token } = await companion(t);

  const response = await companionFetch(url, token, "/api/options");
  assert.equal(response.status, 200);
  const body = await response.json() as {
    mainAgentModel?: string;
    models: Array<{ id: string; provider: string; reference: string; label: string }>;
  };
  assert.ok(Array.isArray(body.models));
  for (const model of body.models) {
    // The native loop takes the model id directly; there is no provider prefix
    // to build any more. 原生循环直接使用模型 id，不再拼接 Provider 前缀。
    assert.equal(model.reference, model.id);
    assert.equal(typeof model.label, "string");
    assert.ok(model.label.length > 0);
  }
  assert.doesNotMatch(JSON.stringify(body), /sk-|api[_-]?key["']?\s*[:=]\s*["'][^"']+/i);
});

test("the mobile binding entry reports setup state without leaking credentials", async (t) => {
  const { url, token } = await companion(t);
  const statusResponse = await companionFetch(url, token, "/api/mobile/whatsapp");
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json() as {
    status: {
      configured: boolean;
      bridge: { port: number };
      tunnel: { installCommand: string };
    };
  };
  assert.equal(status.status.configured, false);
  assert.equal(status.status.bridge.port, 4318);
  assert.match(status.status.tunnel.installCommand, /cloudflared/);
  assert.doesNotMatch(JSON.stringify(status), /"(?:accessToken|appSecret)"\s*:/);

  const invalid = await companionFetch(url, token, "/api/mobile/whatsapp/binding", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ allowedNumbers: "+8613800000000" }),
  });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json() as { error: string }).error, /绑定还不完整/);
});

test("server mode accepts the UI token header and a fixed public webhook", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-api-server-home-"));
  const workspacePath = await mkdtemp(join(tmpdir(), "clone-api-server-ws-"));
  const token = "s".repeat(64);
  const proxySecret = "p".repeat(64);
  const server = await startCompanionServer({
    port: 0,
    host: "127.0.0.1",
    dataDirectory,
    workspacePath,
    serverMode: true,
    publicBaseUrl: "https://agent.example.com",
    token,
    proxySecret,
  });
  t.after(async () => {
    await server.close();
    await rm(dataDirectory, { recursive: true, force: true });
    await rm(workspacePath, { recursive: true, force: true });
  });
  const authorized = await fetch(`${server.url}/api/config`, {
    headers: { "x-clone-ai-token": token, "x-clone-proxy-secret": proxySecret },
  });
  assert.equal(authorized.status, 200);
  const mobile = await fetch(`${server.url}/api/mobile/whatsapp`, {
    headers: { "x-clone-ai-token": token, "x-clone-proxy-secret": proxySecret },
  });
  assert.equal(mobile.status, 200);
  const body = await mobile.json() as { status: { tunnel: { managed: boolean; webhookUrl?: string } } };
  assert.equal(body.status.tunnel.managed, true);
  assert.equal(body.status.tunnel.webhookUrl, "https://agent.example.com/webhook");
  const unauthorized = await fetch(`${server.url}/api/config`, {
    headers: { "x-clone-proxy-secret": proxySecret },
  });
  assert.equal(unauthorized.status, 401);
  const direct = await fetch(`${server.url}/api/health`);
  assert.equal(direct.status, 403);
});

test("an interrupted Main Agent turn is persisted and survives a restart", async (t) => {
  const { url, token, dataDirectory } = await companion(t);
  // A turn that started is what an interruption may close; a request rejected
  // before it started records nothing.
  // 中断可以关闭的是已经开始的回合；在开始之前被拒绝的请求不记录任何东西。
  await appendMainAgentTurnRecord(dataDirectory, {
    id: "interrupted-turn-1",
    text: "整理今天需要推进的事情",
    status: "started",
    startedAt: new Date().toISOString(),
    ownerPid: process.pid,
  });
  const response = await companionFetch(url, token, "/api/main-agent/interruptions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      turnId: "interrupted-turn-1",
      text: "整理今天需要推进的事情",
      error: "The local runtime stopped before this turn completed.",
    }),
  });
  assert.equal(response.status, 202);
  const records = await readMainAgentTurnRecords(dataDirectory);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.status, "interrupted");
  assert.equal(records[0]?.text, "整理今天需要推进的事情");
  assert.match(records[0]?.error ?? "", /stopped/);
});

test("a completed remote turn is returned without invoking the model again", async (t) => {
  const { url, token, dataDirectory } = await companion(t);
  await writeFile(join(dataDirectory, "main-agent-turns.jsonl"), [
    JSON.stringify({
      id: "whatsapp:wamid.123",
      text: "整理今天需要推进的事情",
      status: "completed",
      startedAt: "2026-11-04T03:00:00.000Z",
      completedAt: "2026-11-04T03:00:01.000Z",
      reply: "原回复",
    }),
    "",
  ].join("\n"));
  const response = await companionFetch(url, token, "/api/main-agent/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      turnId: "whatsapp:wamid.123",
      text: "一个不应执行的重复请求",
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { reply: string; deduplicated: boolean };
  assert.equal(body.reply, "原回复");
  assert.equal(body.deduplicated, true);
});

test("a terminal turn is not overwritten by a later interruption report", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-api-turn-terminal-"));
  t.after(async () => rm(dataDirectory, { recursive: true, force: true }));
  const turn = await beginMainAgentTurn({
    dataDirectory,
    text: "第一条",
    source: "cli",
    turnId: "same-turn",
  });
  await finishMainAgentTurn(turn, { status: "completed", reply: "答案" });
  const second = await recordMainAgentClientInterruption(dataDirectory, {
    turnId: "same-turn",
    text: "第二条",
    error: "再次中断",
  });
  assert.equal(second?.status, "completed");
  assert.equal(second?.reply, "答案");
  assert.equal((await readMainAgentTurnRecords(dataDirectory)).length, 1);
});

test("a persisted Main Agent session is still visible after reopening", async (t) => {
  const { url, token, dataDirectory } = await companion(t);
  const sessionDirectory = join(dataDirectory, "pi-sessions", "main-agent");
  await mkdir(sessionDirectory, { recursive: true });
  const entries = [
    {
      type: "message",
      id: "history-user",
      timestamp: "2026-11-03T08:00:00.000Z",
      message: { role: "user", content: "整理今天需要推进的事情" },
    },
    {
      type: "message",
      id: "history-assistant",
      timestamp: "2026-11-03T08:00:02.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "This private reasoning must not be shown." },
          { type: "text", text: "这是重启后仍应存在的历史回复。" },
        ],
      },
    },
  ];
  await writeFile(
    join(sessionDirectory, "2026-11-03T08-00-00-000Z_session.jsonl"),
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );

  const dashboard = await companionFetch(url, token, "/api/dashboard");
  const dashboardBody = await dashboard.json() as { sessions: Array<{ id: string; title: string }> };
  // The conversation is not a sidebar row; its view must still reopen. 对话不是侧栏行，但它的视图仍能重新打开。
  assert.equal(dashboardBody.sessions.some((session) => session.id === "main-agent-conversation"), false);

  const conversation = await companionFetch(url, token, "/api/sessions/main-agent-conversation");
  const conversationBody = await conversation.json() as {
    query: string;
    messages: Array<{ role: string; text: string }>;
  };
  assert.equal(conversationBody.query, "整理今天需要推进的事情");
  assert.ok(conversationBody.messages.some((message) => message.role === "person" && message.text.includes("整理今天")));
  assert.ok(conversationBody.messages.some((message) => message.role === "clone" && message.text.includes("历史回复")));
  assert.equal(conversationBody.messages.some((message) => message.text.includes("private reasoning")), false);
});

test("a turn left running by a dead owner is reconciled as interrupted", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-api-turn-recover-"));
  t.after(async () => rm(dataDirectory, { recursive: true, force: true }));
  await writeFile(
    join(dataDirectory, "main-agent-turns.jsonl"),
    `${JSON.stringify({
      id: "dead-owner-turn",
      text: "继续整理",
      status: "started",
      startedAt: new Date().toISOString(),
      ownerPid: 999_999,
    })}\n`,
    "utf8",
  );
  const records = await reconcileInterruptedMainAgentTurns(dataDirectory);
  assert.equal(records[0]?.status, "interrupted");
  assert.match(records[0]?.error ?? "", /stopped/);
});

test("the gateway inventory is loopback-only and carries no credentials", async (t) => {
  const { url, token } = await companion(t);

  const response = await companionFetch(url, token, "/api/gateways");
  assert.equal(response.status, 200);
  const body = await response.json() as {
    gateways: Array<{
      id: string;
      endpoint: string;
      installed: boolean;
      running: boolean;
      models: Array<{ id: string; compatible: boolean }>;
    }>;
  };
  assert.equal(body.gateways[0]?.id, "magpie");
  assert.equal(body.gateways[0]?.endpoint, "http://127.0.0.1:3425");
  assert.equal(typeof body.gateways[0]?.installed, "boolean");
  assert.equal(typeof body.gateways[0]?.running, "boolean");
  assert.ok(Array.isArray(body.gateways[0]?.models));
  for (const model of body.gateways[0]?.models ?? []) assert.equal(typeof model.compatible, "boolean");
  assert.doesNotMatch(JSON.stringify(body), /sk-|api[_-]?key["']?\s*[:=]\s*["'][^"']+/i);
});

test("the owner can change the locale, but there is no workspace setting", async (t) => {
  const { url, token } = await companion(t);

  const removed = await companionFetch(url, token, "/api/config", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspacePath: "/tmp/another-project" }),
  });
  assert.equal(removed.status, 400);
  assert.match((await removed.json() as { error: string }).error, /working-directory setting was removed/);

  const updated = await companionFetch(url, token, "/api/config", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ locale: "en" }),
  });
  assert.equal(updated.status, 200);
  const updatedBody = await updated.json() as { config: { locale: string }; restartRequired?: boolean };
  assert.equal(updatedBody.config.locale, "en");
  assert.equal(updatedBody.restartRequired, undefined);

  // The change is durable, not just echoed back.
  // 变更是持久的，而不只是被回显。
  const reread = await (await companionFetch(url, token, "/api/config")).json() as {
    config: { locale: string };
    paths: Record<string, string>;
  };
  assert.equal(reread.config.locale, "en");
  assert.equal("workspacePath" in reread.config, false);
  assert.equal("workspacePath" in reread.paths, false);
  assert.equal((await (await companionFetch(url, token, "/api/config")).json() as { ui: { strings: Record<string, string> } }).ui.strings["new-session"], "New request");

  const empty = await companionFetch(url, token, "/api/config", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(empty.status, 400);
});

test("the owner can persist an endpoint, and the key is never read back", async (t) => {
  const { url, token } = await companion(t);

  const saved = await companionFetch(url, token, "/api/config", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mainAgentBaseUrl: "http://127.0.0.1:3425/", mainAgentApiKey: "sk-test-should-never-return" }),
  });
  assert.equal(saved.status, 200);
  const body = await saved.json() as { config: { mainAgentBaseUrl?: string; hasMainAgentApiKey?: boolean; mainAgentApiKey?: string } };
  // The trailing slash is normalised; the key is acknowledged, not echoed.
  // 末尾斜杠被规范化；密钥只被确认存在，不回显。
  assert.equal(body.config.mainAgentBaseUrl, "http://127.0.0.1:3425");
  assert.equal(body.config.hasMainAgentApiKey, true);
  assert.equal(body.config.mainAgentApiKey, undefined);
  assert.doesNotMatch(JSON.stringify(body), /sk-test-should-never-return/);

  // A later full read must not leak it either.
  // 之后的一次完整读取也不得泄漏它。
  const reread = await (await companionFetch(url, token, "/api/config")).json();
  assert.doesNotMatch(JSON.stringify(reread), /sk-test-should-never-return/);
  assert.equal((reread as { config: { hasMainAgentApiKey?: boolean } }).config.hasMainAgentApiKey, true);

  // Only an explicit clear removes it, so re-saving a URL cannot drop the key.
  // 只有显式清除才会移除它，因此重存地址不会丢掉密钥。
  const cleared = await companionFetch(url, token, "/api/config", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mainAgentApiKey: "" }),
  });
  assert.equal((await cleared.json() as { config: { hasMainAgentApiKey?: boolean } }).config.hasMainAgentApiKey, undefined);
});

test("an endpoint without a scheme is refused before it can fail every turn", async (t) => {
  const { url, token } = await companion(t);
  const response = await companionFetch(url, token, "/api/config", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mainAgentBaseUrl: "127.0.0.1:3425" }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json() as { error: string }).error, /http:\/\/ or https:\/\//);
});

test("the owner can set and clear the Main Agent model in config.json", async (t) => {
  const { url, token } = await companion(t);

  const updated = await companionFetch(url, token, "/api/config", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mainAgentModel: "anthropic/claude-sonnet-4-5" }),
  });
  assert.equal(updated.status, 200);
  assert.equal(
    (await updated.json() as { config: { mainAgentModel?: string } }).config.mainAgentModel,
    "anthropic/claude-sonnet-4-5",
  );

  const cleared = await companionFetch(url, token, "/api/config", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mainAgentModel: "  " }),
  });
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json() as { config: { mainAgentModel?: string } }).config.mainAgentModel, undefined);
});

test("memory candidates can be listed and promoted through the API", async (t) => {
  // Write the proposed candidate before the server starts, so its journal
  // instance loads it from disk.
  // 在 Server 启动前写入提案候选，使其 Journal 实例从磁盘加载到它。
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-api-memory-"));
  const workspacePath = await mkdtemp(join(tmpdir(), "clone-api-memory-ws-"));
  let server: RunningCompanionServer | undefined;
  t.after(async () => {
    await server?.close();
    await rm(dataDirectory, { recursive: true, force: true });
    await rm(workspacePath, { recursive: true, force: true });
  });
  // Seed through the same seam the daemon uses, so the fixture lands in
  // whichever journal the server will actually read.
  // 通过 Daemon 使用的同一 seam 写入，使夹具数据落在服务端真正会读的那本 Journal 里。
  const journal = createJournalStore(dataDirectory);
  await journal.append({
    type: "evidence.recorded",
    runId: "run-1",
    payload: {
      id: "ev-1", runId: "run-1", stepId: "s1", producedBy: "worker", kind: "artifact",
      summary: "deliverable produced", createdAt: new Date().toISOString(),
    },
  });
  await journal.append({
    type: "memory.candidate.proposed",
    runId: "run-1",
    payload: {
      id: "c-1", runId: "run-1", sourceEvidenceIds: ["ev-1"],
      summary: "用户偏好：发布前必须完成风险评审", confidence: "high", status: "proposed",
      createdAt: new Date().toISOString(), type: "preference", sensitivity: "private",
    },
  });
  // Release the seeding handle before the server opens its own: the fixture is
  // written, and holding the database open would block cleanup on Windows.
  // 在服务端打开自己的句柄之前先释放播种用的句柄：夹具已写入，而押着数据库会在
  // Windows 上阻碍清理。
  (journal as { close?: () => void }).close?.();
  server = await startCompanionServer({ port: 0, dataDirectory, workspacePath });
  const url = server.url;
  const token = server.token;

  const listed = await (await companionFetch(url, token, "/api/memory/candidates")).json() as { candidates: Array<{ id: string }> };
  assert.deepEqual(listed.candidates.map((item) => item.id), ["c-1"]);

  const promoted = await companionFetch(url, token, "/api/memory/candidates/c-1/promote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(promoted.status, 201);
  const body = await promoted.json() as { memory: { id: string; summary: string } };
  assert.match(body.memory.summary, /发布前必须完成风险评审/);

  const after = await (await companionFetch(url, token, "/api/memory/candidates")).json() as { candidates: unknown[] };
  assert.equal(after.candidates.length, 0);
});

test("starting the server retires legacy objective-restatement candidates once", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-api-memory-cleanup-"));
  const workspacePath = await mkdtemp(join(tmpdir(), "clone-api-memory-cleanup-ws-"));
  let server: RunningCompanionServer | undefined;
  t.after(async () => {
    await server?.close();
    await rm(dataDirectory, { recursive: true, force: true });
    await rm(workspacePath, { recursive: true, force: true });
  });
  const objective = "只读审查 knowledge-base 项目的 RAG 实现，优先复用已有审查结果并给出可验证的优化建议。";
  const createdAt = new Date().toISOString();
  const journal = createJournalStore(dataDirectory);
  await journal.append({
    type: "task.created",
    taskId: "task-legacy",
    payload: { id: "task-legacy", triggerId: "trigger-legacy", title: "Review", objective, acceptanceCriteria: [], createdAt },
  });
  await journal.append({
    type: "run.created",
    runId: "run-legacy",
    taskId: "task-legacy",
    payload: { id: "run-legacy", taskId: "task-legacy", status: "completed", createdAt, updatedAt: createdAt },
  });
  await journal.append({
    type: "memory.candidate.proposed",
    runId: "run-legacy",
    payload: {
      id: "c-legacy", runId: "run-legacy", sourceEvidenceIds: ["ev-1"], summary: `候选流程：${objective}`,
      confidence: "low", status: "proposed", createdAt,
    },
  });
  await journal.append({
    type: "memory.candidate.proposed",
    runId: "run-legacy",
    payload: {
      id: "c-durable", runId: "run-legacy", sourceEvidenceIds: ["ev-1"], summary: "发布前先跑完整测试；这次跳过测试导致了一次回归。",
      confidence: "high", status: "proposed", createdAt, type: "procedure",
    },
  });
  (journal as { close?: () => void }).close?.();

  server = await startCompanionServer({ port: 0, dataDirectory, workspacePath });
  // The first maintenance pass starts after the endpoint is published, so the
  // one-time legacy cleanup can still be in flight when startup returns. Wait
  // for the journaled decision instead of assuming readiness implies it.
  // 首轮维护在端点发布之后才开始，因此启动返回时一次性旧候选清理可能仍在进行。等待它写入
  // Journal 的决定，而不是假定"就绪"意味着它已经完成。
  const cleanupDeadline = Date.now() + 5_000;
  while (true) {
    const probe = createJournalStore(dataDirectory);
    try {
      const rejected = (await probe.list()).some((event) => event.type === "memory.candidate.rejected"
        && (event.payload as { candidateId?: string }).candidateId === "c-legacy");
      if (rejected) break;
    } finally {
      (probe as { close?: () => void }).close?.();
    }
    assert.ok(Date.now() < cleanupDeadline, "the legacy restatement cleanup did not run");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const listed = await (await companionFetch(server.url, server.token, "/api/memory/candidates")).json() as { candidates: Array<{ id: string }> };
  assert.deepEqual(listed.candidates.map((item) => item.id), ["c-durable"], "the objective copy must not reach the owner's review list");

  // The dashboard and attention list are separate read surfaces; neither may
  // keep presenting a rejected work-order copy as current.
  // Dashboard 与注意力列表是独立的读取面；两者都不得把被拒绝的工作单复制继续当作当前候选。
  const dashboard = await (await companionFetch(server.url, server.token, "/api/dashboard")).json() as { memories?: Array<{ summary: string }> };
  assert.equal((dashboard.memories ?? []).some((memory) => memory.summary.includes("候选流程")), false);
  const attention = await (await companionFetch(server.url, server.token, "/api/attention")).json() as {
    items: Array<{ title?: string; detail?: string }>;
  };
  assert.equal(attention.items.some((item) => `${item.title ?? ""}${item.detail ?? ""}`.includes("候选流程")), false);

  // The decision is journaled, not merely hidden from the API.
  // 该决定写入 Journal，而不仅仅是从 API 隐藏。
  const reopened = createJournalStore(dataDirectory);
  try {
    const rejected = (await reopened.list()).filter((event) => event.type === "memory.candidate.rejected");
    assert.deepEqual(rejected.map((event) => (event.payload as { candidateId?: string }).candidateId), ["c-legacy"]);
  } finally {
    (reopened as { close?: () => void }).close?.();
  }
});

test("connector declarations round-trip through the API and reject credential values", async (t) => {
  const { url, token } = await companion(t);

  const empty = await (await companionFetch(url, token, "/api/connectors")).json() as { connectors: unknown[] };
  assert.deepEqual(empty.connectors, []);

  const created = await companionFetch(url, token, "/api/connectors", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connectors: [{ id: "local-files", enabled: true, target: "/notes" }] }),
  });
  assert.equal(created.status, 200);
  const stored = await (await companionFetch(url, token, "/api/connectors")).json() as { connectors: Array<{ id: string }> };
  assert.deepEqual(stored.connectors.map((item) => item.id), ["local-files"]);

  // The same rule as providers: a config file must never hold a credential.
  // 与 Provider 同一条规则：配置文件绝不能存放凭据。
  const leaky = await companionFetch(url, token, "/api/connectors", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connectors: [{ id: "leaky", enabled: true, env: ["TOKEN=sk-not-real"] }] }),
  });
  assert.equal(leaky.status, 400);
  assert.match((await leaky.json() as { error: string }).error, /variable names only/);
});

test("the situation endpoint reports what the twin knows, with no credential content", async (t) => {
  const { url, token } = await companion(t);

  const response = await companionFetch(url, token, "/api/situation");
  assert.equal(response.status, 200);
  const body = await response.json() as { text: string; overdue: unknown[]; activeGoals: unknown[] };

  assert.equal(typeof body.text, "string");
  assert.ok(Array.isArray(body.overdue));
  assert.ok(Array.isArray(body.activeGoals));
  assert.doesNotMatch(JSON.stringify(body), /sk-|api[_-]?key["']?\s*[:=]\s*["'][^"']+/i);
});

test("the streaming endpoint validates input before opening a stream", async (t) => {
  const { url, token } = await companion(t);

  const response = await companionFetch(url, token, "/api/main-agent/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "  " }),
  });

  // Rejected as JSON with a status the client can still read; once the stream
  // is open a status code is no longer available to report a refusal.
  // 以 JSON 和客户端仍可读取的状态码拒绝；流一旦打开，状态码就无法再用来报告拒绝。
  assert.equal(response.status, 400);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  assert.match((await response.json() as { error: string }).error, /enter a request/i);
});

test("the owner can set a gateway-declared effort the fallback list omits", async (t) => {
  const { url, token } = await companion(t);
  // `ultra` is declared by openai/gpt-6.1-terra but is not in the known
  // fallback list. The gateway is the authority for a model's levels, so the
  // setting must accept it instead of refusing a level the model advertises.
  // `ultra` 由 openai/gpt-6.1-terra 声明，但不在已知兜底列表里。模型档位以网关为
  // 权威，因此设置必须接受它，而不是拒绝模型宣称支持的档位。
  const set = await companionFetch(url, token, "/api/config", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mainAgentEffort: " ultra " }),
  });
  assert.equal(set.status, 200);
  assert.equal((await set.json() as { config: { mainAgentEffort?: string } }).config.mainAgentEffort, "ultra");

  const cleared = await companionFetch(url, token, "/api/config", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mainAgentEffort: "" }),
  });
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json() as { config: { mainAgentEffort?: string } }).config.mainAgentEffort, undefined);

  // A value that is not a name at all is still refused as JSON.
  // 根本不像名称的值仍以 JSON 拒绝。
  const notAName = await companionFetch(url, token, "/api/config", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mainAgentEffort: 42 }),
  });
  assert.equal(notAName.status, 400);
  assert.match((await notAName.json() as { error: string }).error, /mainAgentEffort/);
});

test("a one-character main-agent request is not rejected as too short", () => {
  // Validation is the contract under test; the live model call is covered by
  // the gated integration suite.
  // 这里测试校验契约；真实模型调用由门控集成测试覆盖。
  assert.equal(normalizeMainAgentRequestText("?"), "?");
  assert.equal(normalizeMainAgentRequestText("  ?  "), "?");
  assert.equal(normalizeMainAgentRequestText(" \n\t "), "");
  assert.equal(normalizeMainAgentRequestText(undefined), "");
});

test("the Main Agent and worker concurrency pins can be set and cleared", async (t) => {
  const { url, token } = await companion(t);
  const set = await companionFetch(url, token, "/api/config", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ maxConcurrentMainAgents: 2, maxConcurrentWorkers: 3 }),
  });
  assert.equal(set.status, 200);
  const setConfig = (await set.json() as { config: { maxConcurrentMainAgents?: number; maxConcurrentWorkers?: number } }).config;
  assert.equal(setConfig.maxConcurrentMainAgents, 2);
  assert.equal(setConfig.maxConcurrentWorkers, 3);

  // 0 means auto, and a lone 0 is a valid update that clears the pin.
  // 0 表示自动；单独一个 0 是合法的更新，会清除固定值。
  const clear = await companionFetch(url, token, "/api/config", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ maxConcurrentMainAgents: 0 }),
  });
  assert.equal(clear.status, 200);
  const cleared = (await clear.json() as { config: Record<string, unknown> }).config;
  assert.equal("maxConcurrentMainAgents" in cleared, false);
  assert.equal(cleared.maxConcurrentWorkers, 3);
});
