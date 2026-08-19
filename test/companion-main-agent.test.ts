import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startCompanionServer } from "../src/companion-server.ts";

// The conversation-driven entry exists and validates input without touching a
// model; the full chain is covered by the gated live acceptance test.
// 对话驱动入口存在且不触碰模型就校验输入；完整链路由门控的真实验收测试覆盖。
test("the companion main-agent route rejects an empty request before any model call", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-ai-companion-"));
  t.after(async () => rm(dataDirectory, { recursive: true, force: true }));

  const server = await startCompanionServer({ port: 0, dataDirectory });
  t.after(async () => server.close());

  const rejected = await fetch(`${server.url}/api/main-agent/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "  " }),
  });
  assert.equal(rejected.status, 400);
  const body = await rejected.json() as { error?: string };
  assert.match(body.error ?? "", /at least three characters/);
});
