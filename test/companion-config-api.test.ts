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

test("software installation endpoints require an explicit owner acknowledgement", async (t) => {
  const { url, token } = await companion(t);
  for (const path of ["/api/agents/pi/install", "/api/agents/install-missing"]) {
    const response = await companionFetch(url, token, path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(response.status, 400);
    assert.match((await response.json() as { error: string }).error, /acknowledge|confirm/i);
  }
});

test("the config endpoint reports where the owner's data lives", async (t) => {
  const { url, token, dataDirectory } = await companion(t);

  const response = await companionFetch(url, token, "/api/config");
  assert.equal(response.status, 200);
  const body = await response.json() as {
    config: { workspacePath: string; locale: string };
    ui?: { locale: string; strings?: Record<string, string> };
    paths: Record<string, string>;
  };

  assert.equal(body.paths.dataDirectory, dataDirectory);
  assert.match(body.paths.providersFile, /providers\.json$/);
  assert.equal(body.config.locale, "zh-CN");
  assert.equal(body.ui?.locale, "zh-CN");
  assert.equal(body.ui?.strings?.["new-session"], "新建任务");
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
    assert.equal(model.reference, model.id);
    assert.equal(model.provider, "magpie");
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
  await recordMainAgentClientInterruption(dataDirectory, {
    turnId: "same-turn",
    text: "第一条",
    error: "连接中断",
  });
  const second = await recordMainAgentClientInterruption(dataDirectory, {
    turnId: "same-turn",
    text: "第二条",
    error: "再次中断",
  });
  assert.equal(second.text, "第一条");
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
  assert.ok(dashboardBody.sessions.some((session) => session.id === "main-agent-conversation"));

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

test("the owner can change the workspace and locale through the API", async (t) => {
  const { url, token } = await companion(t);

  const updated = await companionFetch(url, token, "/api/config", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspacePath: "/tmp/another-project", locale: "en" }),
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json() as { config: { locale: string } }).config.locale, "en");

  // The change is durable, not just echoed back.
  // 变更是持久的，而不只是被回显。
  const reread = await (await companionFetch(url, token, "/api/config")).json() as { config: { workspacePath: string; locale: string } };
  assert.equal(reread.config.workspacePath, "/tmp/another-project");
  assert.equal(reread.config.locale, "en");
  assert.equal((await (await companionFetch(url, token, "/api/config")).json() as { ui: { strings: Record<string, string> } }).ui.strings["new-session"], "New task");

  const empty = await companionFetch(url, token, "/api/config", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(empty.status, 400);
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

test("a third-party agent is added, listed, and removed without touching source", async (t) => {
  const { url, token } = await companion(t);

  const before = await (await companionFetch(url, token, "/api/settings/providers")).json() as { providers: Array<{ id: string }>; userDefined: unknown[] };
  assert.equal(before.userDefined.length, 0);
  assert.ok(before.providers.some((provider) => provider.id === "claude-code"), "built-ins are listed");

  const created = await companionFetch(url, token, "/api/settings/providers", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "opencode", command: "opencode", args: ["run", "{{prompt}}"], env: ["ANTHROPIC_API_KEY"] }),
  });
  assert.equal(created.status, 200);

  const after = await (await companionFetch(url, token, "/api/settings/providers")).json() as { providers: Array<{ id: string }> };
  assert.ok(after.providers.some((provider) => provider.id === "opencode"));

  const removed = await companionFetch(url, token, "/api/settings/providers/opencode", { method: "DELETE" });
  assert.equal(removed.status, 200);
  const final = await (await companionFetch(url, token, "/api/settings/providers")).json() as { userDefined: unknown[] };
  assert.equal(final.userDefined.length, 0);
});

test("the API refuses a provider declaration that carries a credential value", async (t) => {
  const { url, token } = await companion(t);

  const response = await companionFetch(url, token, "/api/settings/providers", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "leaky", command: "leaky", env: ["ANTHROPIC_API_KEY=sk-not-a-real-key"] }),
  });

  // Rejected at the boundary: config stores variable names, never values.
  // 在边界处拒绝：配置只存变量名，绝不存值。
  assert.equal(response.status, 400);
  assert.match((await response.json() as { error: string }).error, /variable names only/);

  const stored = await (await companionFetch(url, token, "/api/settings/providers")).json() as { userDefined: unknown[] };
  assert.equal(stored.userDefined.length, 0);
});

test("unrestricted worker execution requires an explicit API acknowledgement", async (t) => {
  const { url, token } = await companion(t);
  const provider = { id: "test-agent", command: "test-agent", hostAccess: "unrestricted" };
  const endpoint = "/api/settings/providers";
  const withoutAcknowledgement = await companionFetch(url, token, endpoint, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(provider),
  });
  assert.equal(withoutAcknowledgement.status, 400);
  const accepted = await companionFetch(url, token, endpoint, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...provider, acknowledgeUnrestrictedHostAccess: true }),
  });
  assert.equal(accepted.status, 200);
  const configured = await (await companionFetch(url, token, endpoint)).json() as { providers: Array<{ id: string; hostAccess?: string }> };
  assert.equal(configured.providers.find((item) => item.id === "test-agent")?.hostAccess, "unrestricted");
  const agents = await (await companionFetch(url, token, "/api/agents")).json() as { providers: Array<{ id: string; executionBlocked: boolean }> };
  assert.equal(agents.providers.find((item) => item.id === "test-agent")?.executionBlocked, false);
});

test("a built-in provider with prefix wildcards can be explicitly authorized", async (t) => {
  const { url, token } = await companion(t);
  const current = await (await companionFetch(url, token, "/api/settings/providers")).json() as { providers: Array<Record<string, unknown>> };
  const provider = current.providers.find((item) => item.id === "claude-code")!;
  const updated = await companionFetch(url, token, "/api/settings/providers", {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...provider, hostAccess: "unrestricted", acknowledgeUnrestrictedHostAccess: true }),
  });
  assert.equal(updated.status, 200);
  const listed = await (await companionFetch(url, token, "/api/agents")).json() as { providers: Array<{ id: string; executionBlocked: boolean }> };
  assert.equal(listed.providers.find((item) => item.id === "claude-code")?.executionBlocked, false);
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

test("installed agents are reported generically, including user-declared ones", async (t) => {
  const { url, token } = await companion(t);

  await companionFetch(url, token, "/api/settings/providers", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "opencode", command: "opencode-not-installed", args: ["run"] }),
  });

  const agents = await (await companionFetch(url, token, "/api/agents")).json() as { providers: Array<{ id: string; installed: boolean }> };
  const opencode = agents.providers.find((provider) => provider.id === "opencode");
  assert.ok(opencode, "a user-declared agent must appear in the agent list");
  // A missing command is reported, not thrown: the GUI stays usable.
  // 命令缺失是被报告而不是抛出：GUI 仍然可用。
  assert.equal(opencode.installed, false);
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

test("a one-character main-agent request is not rejected as too short", () => {
  // Validation is the contract under test; the live model call is covered by
  // the gated integration suite.
  // 这里测试校验契约；真实模型调用由门控集成测试覆盖。
  assert.equal(normalizeMainAgentRequestText("?"), "?");
  assert.equal(normalizeMainAgentRequestText("  ?  "), "?");
  assert.equal(normalizeMainAgentRequestText(" \n\t "), "");
  assert.equal(normalizeMainAgentRequestText(undefined), "");
});
