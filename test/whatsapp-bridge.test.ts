import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  allowedWhatsAppNumbers,
  extractWhatsAppTextMessages,
  isAllowedWhatsAppNumber,
  splitWhatsAppText,
  verifyWhatsAppSignature,
  whatsAppChallengeResponse,
} from "../src/mobile/whatsapp.ts";
import {
  LocalMainAgentRemote,
  MainAgentRetryableError,
  WhatsAppBridge,
  WhatsAppInboxStore,
  type WhatsAppCloudConfig,
  type WhatsAppTextSender,
} from "../src/mobile/whatsapp-bridge.ts";
import {
  parseWhatsAppEnv,
  WhatsAppBindingInputError,
  WhatsAppSetupService,
} from "../src/mobile/whatsapp-setup.ts";
import { persistCompanionEndpoint } from "../src/companion-auth.ts";

const secret = "test-app-secret";

/** Build a raw Meta webhook payload for the bridge tests. 为桥测试构造原始 Meta Webhook 负载。 */
function textPayload(input: {
  id?: string;
  from?: string;
  text?: string;
  status?: boolean;
} = {}): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{
      changes: [{
        value: {
          messages: input.status === true ? undefined : [{
            id: input.id ?? "wamid.1",
            from: input.from ?? "8613800000000",
            timestamp: "1762320000",
            type: "text",
            text: { body: input.text ?? "整理今天需要推进的事情" },
          }],
          statuses: input.status === true ? [{ id: "status-1", status: "read" }] : undefined,
        },
      }],
    }],
  });
}

function signature(body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function config(overrides: Partial<WhatsAppCloudConfig> = {}): WhatsAppCloudConfig {
  return {
    accessToken: "token",
    phoneNumberId: "phone",
    verifyToken: "verify",
    appSecret: secret,
    allowedNumbers: allowedWhatsAppNumbers(["+86 138 0000 0000"]),
    graphVersion: "v23.0",
    host: "127.0.0.1",
    port: 4318,
    ...overrides,
  };
}

test("WhatsApp verification accepts only the exact verify token", () => {
  const ok = whatsAppChallengeResponse(
    new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "verify", "hub.challenge": "42" }),
    "verify",
  );
  assert.deepEqual(ok, { status: 200, body: "42" });
  const wrong = whatsAppChallengeResponse(
    new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "nope", "hub.challenge": "42" }),
    "verify",
  );
  assert.equal(wrong.status, 403);
});

test("WhatsApp signature verification is constant-time and fails closed", () => {
  const body = textPayload();
  assert.equal(verifyWhatsAppSignature({ rawBody: body, signatureHeader: signature(body), appSecret: secret }), true);
  assert.equal(verifyWhatsAppSignature({ rawBody: body, signatureHeader: "sha256=00", appSecret: secret }), false);
  assert.equal(verifyWhatsAppSignature({ rawBody: `${body} `, signatureHeader: signature(body), appSecret: secret }), false);
  assert.equal(verifyWhatsAppSignature({ rawBody: body, signatureHeader: undefined, appSecret: secret }), false);
});

test("WhatsApp extraction ignores groups, media, and delivery statuses", () => {
  const text = extractWhatsAppTextMessages(JSON.parse(textPayload()));
  assert.equal(text.messages.length, 1);
  assert.equal(text.messages[0]?.from, "8613800000000");

  const status = extractWhatsAppTextMessages(JSON.parse(textPayload({ status: true })));
  assert.equal(status.messages.length, 0);
  assert.equal(status.ignored, 1);

  const group = extractWhatsAppTextMessages({
    entry: [{ changes: [{ value: { messages: [{ id: "g", from: "1", type: "text", text: { body: "hi" }, group_id: "g1" }] } }] }],
  });
  assert.equal(group.messages.length, 0);

  const media = extractWhatsAppTextMessages({
    entry: [{ changes: [{ value: { messages: [{ id: "m", from: "1", type: "image", image: { id: "x" } }] } }] }],
  });
  assert.equal(media.messages.length, 0);
});

test("WhatsApp allowlist normalizes punctuation and country prefixes", () => {
  const allowed = allowedWhatsAppNumbers(["+86 138-0000-0000"]);
  assert.equal(isAllowedWhatsAppNumber("8613800000000", allowed), true);
  assert.equal(isAllowedWhatsAppNumber("8613900000000", allowed), false);
});

test("long WhatsApp replies are split below the Cloud API limit and numbered", () => {
  const paragraphs = Array.from({ length: 40 }, (_, index) => `第 ${index + 1} 段：${"内容".repeat(120)}`);
  const parts = splitWhatsAppText(paragraphs.join("\n\n"), 500);
  assert.ok(parts.length > 1);
  for (const [index, part] of parts.entries()) {
    assert.ok(part.length <= 500, `part ${index} is ${part.length} characters`);
    assert.match(part, new RegExp(`\\(${index + 1}/${parts.length}\\)$`));
  }
  assert.deepEqual(splitWhatsAppText("短回复", 500), ["短回复"]);
});

test("the WhatsApp inbox deduplicates message ids across restarts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-whatsapp-inbox-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "inbox.sqlite3");
  const store = new WhatsAppInboxStore(path);
  const message = { id: "wamid.same", from: "8613800000000", text: "hello", group: false };
  assert.equal(store.insert(message), true);
  assert.equal(store.insert(message), false);
  const claimed = store.claimNext();
  assert.equal(claimed?.id, "wamid.same");
  assert.equal(store.claimNext(), undefined);
  store.close();

  const reopened = new WhatsAppInboxStore(path);
  assert.equal(reopened.claimNext()?.id, "wamid.same", "an interrupted processing row must be retried");
  reopened.close();
});

test("a duplicate webhook executes the Main Agent once and sends one reply", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-whatsapp-bridge-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const store = new WhatsAppInboxStore(join(directory, "inbox.sqlite3"));
  t.after(() => store.close());
  const replies: Array<{ to: string; text: string }> = [];
  const sender: WhatsAppTextSender = {
    async sendText(to, text) {
      replies.push({ to, text });
    },
  };
  let calls = 0;
  const bridge = new WhatsAppBridge({
    config: config(),
    store,
    sender,
    mainAgent: {
      async ask() {
        calls += 1;
        return "今天先完成最重要的一件事。";
      },
    },
  });
  const body = textPayload({ id: "wamid.once" });
  assert.equal(bridge.receiveWebhook(body, signature(body)).status, 200);
  assert.equal(bridge.receiveWebhook(body, signature(body)).status, 200);
  await bridge.waitForIdle();
  assert.equal(calls, 1);
  assert.deepEqual(replies, [{ to: "8613800000000", text: "今天先完成最重要的一件事。" }]);
  assert.equal(store.counts().completed, 1);
});

test("unknown numbers are rejected before reaching the Main Agent", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-whatsapp-blocked-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const store = new WhatsAppInboxStore(join(directory, "inbox.sqlite3"));
  t.after(() => store.close());
  let calls = 0;
  const bridge = new WhatsAppBridge({
    config: config(),
    store,
    sender: { async sendText() {} },
    mainAgent: {
      async ask() {
        calls += 1;
        return "should not run";
      },
    },
  });
  const body = textPayload({ id: "wamid.blocked", from: "8613900000000" });
  assert.equal(bridge.receiveWebhook(body, signature(body)).status, 200);
  await bridge.waitForIdle();
  assert.equal(calls, 0);
  assert.equal(store.counts().completed, 0);
  assert.equal(store.counts().pending, 0);
});

test("an invalid signature never persists a message", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-whatsapp-signature-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const store = new WhatsAppInboxStore(join(directory, "inbox.sqlite3"));
  t.after(() => store.close());
  const bridge = new WhatsAppBridge({
    config: config(),
    store,
    sender: { async sendText() {} },
    mainAgent: { async ask() { return "no"; } },
  });
  const body = textPayload({ id: "wamid.forged" });
  assert.equal(bridge.receiveWebhook(body, "sha256=" + "0".repeat(64)).status, 401);
  assert.equal(store.counts().pending, 0);
});

test("a failed Main Agent turn is recorded and the owner is told, not marked complete", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-whatsapp-failure-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const store = new WhatsAppInboxStore(join(directory, "inbox.sqlite3"));
  t.after(() => store.close());
  const sent: string[] = [];
  const bridge = new WhatsAppBridge({
    config: config(),
    store,
    sender: { async sendText(_to, text) { sent.push(text); } },
    mainAgent: {
      async ask() {
        throw new Error("Clone AI Desktop 当前离线");
      },
    },
  });
  const body = textPayload({ id: "wamid.failure" });
  assert.equal(bridge.receiveWebhook(body, signature(body)).status, 200);
  await bridge.waitForIdle();
  assert.equal(store.counts().failed, 1);
  assert.equal(store.counts().completed, 0);
  assert.match(sent[0] ?? "", /没有安全完成/);
  assert.match(sent[0] ?? "", /不会假装任务已经执行/);
});

test("an offline Mac keeps the message queued and tells the owner it was not executed", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-whatsapp-retry-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const store = new WhatsAppInboxStore(join(directory, "inbox.sqlite3"));
  t.after(() => store.close());
  const sent: string[] = [];
  const bridge = new WhatsAppBridge({
    config: config(),
    store,
    sender: { async sendText(_to, text) { sent.push(text); } },
    mainAgent: {
      async ask() {
        throw new MainAgentRetryableError("Clone AI Desktop 当前离线");
      },
    },
  });
  t.after(() => bridge.stop());
  const body = textPayload({ id: "wamid.offline" });
  assert.equal(bridge.receiveWebhook(body, signature(body)).status, 200);
  await bridge.waitForIdle();
  assert.equal(store.counts().pending, 1);
  assert.equal(store.counts().failed, 0);
  assert.equal(store.counts().completed, 0);
  assert.match(sent[0] ?? "", /保存在本机队列/);
  assert.match(sent[0] ?? "", /不会谎报任务完成/);
});

test("a queued message resumes after the local runtime comes back", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-whatsapp-resume-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const store = new WhatsAppInboxStore(join(directory, "inbox.sqlite3"));
  t.after(() => store.close());
  const sent: string[] = [];
  let calls = 0;
  const bridge = new WhatsAppBridge({
    config: config(),
    store,
    sender: { async sendText(_to, text) { sent.push(text); } },
    mainAgent: {
      async ask() {
        calls += 1;
        if (calls === 1) throw new MainAgentRetryableError("Clone AI Desktop 当前离线");
        return "恢复后的回复";
      },
    },
  });
  t.after(() => bridge.stop());
  const body = textPayload({ id: "wamid.resume" });
  assert.equal(bridge.receiveWebhook(body, signature(body)).status, 200);
  await bridge.waitForIdle();
  assert.equal(store.counts().pending, 1);
  // The bridge backs off about one second before retrying; poll instead of
  // asserting a single fixed sleep so a loaded machine does not flake.
  // 桥会退避约一秒再重试；这里轮询而不是固定睡一次，避免机器繁忙时抖动。
  const deadline = Date.now() + 5_000;
  while (store.counts().completed === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    await bridge.waitForIdle();
  }
  assert.equal(store.counts().completed, 1);
  assert.equal(sent.filter((text) => text === "恢复后的回复").length, 1);
  assert.equal(sent.filter((text) => text.includes("保存在本机队列")).length, 1);
});

test("the bridge calls the loopback companion with the WhatsApp turn id", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-whatsapp-companion-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  let received: { authorization?: string; body?: Record<string, unknown> } = {};
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    received = {
      ...(typeof request.headers.authorization === "string" ? { authorization: request.headers.authorization } : {}),
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ reply: "来自 Companion 的回复", newRuns: [] }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  t.after(async () => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server did not bind");
  await writeFile(join(directory, "companion.token"), "local-token\n", { mode: 0o600 });
  await persistCompanionEndpoint(directory, `http://127.0.0.1:${address.port}`);
  const remote = new LocalMainAgentRemote(directory);
  assert.equal(await remote.ask("你好", "whatsapp:wamid.http"), "来自 Companion 的回复");
  assert.equal(received.authorization, "Bearer local-token");
  assert.deepEqual(received.body, { text: "你好", turnId: "whatsapp:wamid.http" });
});

test("a missing desktop runtime is a retryable state, not a completed turn", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-whatsapp-offline-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  await assert.rejects(
    new LocalMainAgentRemote(directory).ask("你好", "whatsapp:wamid.offline"),
    MainAgentRetryableError,
  );
});

test("WhatsApp env parsing preserves values without exposing unrelated shell data", () => {
  const parsed = parseWhatsAppEnv([
    "# private",
    "WHATSAPP_PHONE_NUMBER_ID=123",
    "WHATSAPP_VERIFY_TOKEN='quoted-token'",
    "INVALID-KEY=ignored",
    "",
  ].join("\n"));
  assert.deepEqual(parsed, {
    WHATSAPP_PHONE_NUMBER_ID: "123",
    WHATSAPP_VERIFY_TOKEN: "quoted-token",
  });
});

test("the binding UI can save secrets without ever reading them back", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-whatsapp-setup-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const service = new WhatsAppSetupService(directory);
  const status = await service.saveBinding({
    accessToken: "access-token",
    phoneNumberId: "phone-id",
    verifyToken: "verify-token",
    appSecret: "app-secret",
    allowedNumbers: "+86 138 0000 0000",
  });
  assert.equal(status.configured, true);
  assert.equal(status.phoneNumberId, "phone-id");
  assert.equal(status.verifyToken, "verify-token");
  assert.deepEqual(status.allowedNumbers, ["+86 138 0000 0000"]);
  const serialized = JSON.stringify(status);
  assert.doesNotMatch(serialized, /access-token|app-secret/);
  await service.stopBridge();
  const env = await readFile(join(directory, "whatsapp.env"), "utf8");
  assert.match(env, /WHATSAPP_ACCESS_TOKEN=access-token/);
  assert.match(env, /WHATSAPP_APP_SECRET=app-secret/);
  assert.equal((await stat(join(directory, "whatsapp.env"))).mode & 0o777, 0o600);
});

test("saving an incomplete binding is an input error, not a partial file", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-whatsapp-incomplete-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const service = new WhatsAppSetupService(directory);
  await assert.rejects(
    service.saveBinding({ allowedNumbers: "+8613800000000" }),
    WhatsAppBindingInputError,
  );
  await assert.rejects(readFile(join(directory, "whatsapp.env"), "utf8"), /ENOENT/);
});

test("server deployment exposes a fixed webhook without requiring cloudflared", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-whatsapp-server-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const status = await new WhatsAppSetupService(directory, "https://agent.example.com").status();
  assert.equal(status.tunnel.managed, true);
  assert.equal(status.tunnel.running, true);
  assert.equal(status.tunnel.webhookUrl, "https://agent.example.com/webhook");
});
