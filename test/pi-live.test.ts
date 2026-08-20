import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runQuery } from "../src/application/run-query.ts";
import { JsonlJournalStore } from "../src/core/journal.ts";
import { defaultWorkerProfiles } from "../src/config/worker-settings.ts";
import { findContinuationFlags } from "../src/main-agent/fresh-session-policy.ts";

// Drives a real local Pi process end to end. It costs a model call, so it is
// opt-in:
//   CLONE_AI_PI_LIVE=1 node --experimental-strip-types --test test/pi-live.test.ts
// 驱动真实的本地 Pi 进程走完全程。它会产生模型调用费用，因此需显式开启（见上面的命令）。
const enabled = process.env.CLONE_AI_PI_LIVE === "1";

test("live: an explicit Pi request runs a real worker and lands a verified run", { skip: !enabled }, async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-pi-live-home-"));
  const workspacePath = await mkdtemp(join(tmpdir(), "clone-pi-live-ws-"));
  t.after(async () => {
    await rm(dataDirectory, { recursive: true, force: true });
    await rm(workspacePath, { recursive: true, force: true });
  });

  // An acceptance condition that genuinely fails first: the file is absent
  // until the worker writes it, so success cannot be a false positive.
  // 一个起初确实不满足的验收条件：文件在 Worker 写入之前并不存在，因此成功不可能是误报。
  await mkdir(join(workspacePath, "docs"), { recursive: true });
  await writeFile(join(workspacePath, "README.md"), "# demo\n\nA sample project.\n", "utf8");
  const target = join(workspacePath, "docs", "summary.md");
  await assert.rejects(readFile(target, "utf8"), "the deliverable must not exist beforehand");

  // Only Pi is enabled, and the request names it, so nothing else can serve it.
  // 只启用 Pi，且请求点名了它，因此没有别的 Worker 能顶替。
  const profiles = defaultWorkerProfiles().map((profile) => (
    profile.id === "draft-maker"
      ? { ...profile, id: "pi", providerId: "pi", enabled: true }
      : { ...profile, enabled: false }
  ));

  const result = await runQuery(
    dataDirectory,
    "请使用 pi 阅读 README.md，并把要点写入 docs/summary.md",
    {},
    { agents: profiles },
    { workspacePath },
  );

  assert.equal(result.routing?.selectedAgentId, "pi", `routing said: ${JSON.stringify(result)}`);
  assert.equal(result.routing?.source, "explicit");
  assert.equal(result.status, "completed", `run did not complete: ${JSON.stringify(result)}`);

  // The deliverable is a fact on disk, checked independently of what Pi said.
  // 交付物是磁盘上的事实，独立于 Pi 的说法进行检查。
  const produced = await readFile(target, "utf8");
  assert.ok(produced.trim().length > 0, "the worker must have written real content");

  const events = await new JsonlJournalStore(join(dataDirectory, "journal.jsonl")).list();
  const decision = events.find((event) => event.type === "dispatch.decided");
  assert.ok(decision, "the decision must be journaled");
  assert.equal((decision.payload as { selectedAgentId: string }).selectedAgentId, "pi");
  assert.equal((decision.payload as { sessionPolicy: string }).sessionPolicy, "fresh");

  const evidence = events.filter((event) => event.type === "evidence.recorded");
  assert.ok(evidence.length > 0, "the workspace diff must have produced evidence");
});

test("the shipped Pi recipe starts a fresh session every time", async () => {
  const recipe = JSON.parse(
    await readFile(new URL("../src/workers/providers.json", import.meta.url), "utf8"),
  ) as { providers: Array<{ id: string; args?: string[] }> };
  const pi = recipe.providers.find((provider) => provider.id === "pi");

  assert.ok(pi, "the built-in catalog must still ship a Pi recipe");
  // A resumed conversation would make the Kernel's memory context redundant
  // and tie two tasks together that the owner kept separate.
  // 续接对话会让 Kernel 的记忆上下文变得多余，也会把所有者刻意分开的两个任务绑在一起。
  assert.deepEqual(findContinuationFlags(pi.args ?? []), []);
});
