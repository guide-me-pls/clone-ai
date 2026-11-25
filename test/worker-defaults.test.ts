import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { defaultWorkerProfiles, WorkerSettingsStore } from "../src/config/worker-settings.ts";
import { builtInProviders } from "../src/workers/provider-catalog.ts";
import { workCapabilitiesForRole } from "../src/workers/capabilities.ts";

const NATIVE_ENV = {
  CLONE_AI_NATIVE_MODEL: "anthropic/claude-sonnet-5-5",
  CLONE_AI_NATIVE_BASE_URL: "http://127.0.0.1:3425",
};

test("the default roster is one required general worker", () => {
  const profiles = defaultWorkerProfiles();

  assert.equal(profiles.length, 1);
  assert.equal(profiles[0]?.id, "worker");
  assert.equal(profiles[0]?.role, "general");
  assert.equal(profiles[0]?.providerId, "native");
  assert.equal(profiles[0]?.required, true);
  assert.equal(profiles[0]?.enabled, true);
  // Every local kind of work routes to it; what one step may do is decided by
  // the step's risk and scopes, not by the roster.
  // 所有本地工作都路由到它；某一步实际能做什么由步骤风险与 Scope 决定，而不是名单。
  const capabilities = workCapabilitiesForRole("general");
  for (const capability of ["direct_response", "research", "review", "drafting", "filesystem_read", "filesystem_write"]) {
    assert.ok(capabilities.includes(capability), `missing ${capability}`);
  }
  assert.equal(capabilities.includes("external_action"), false, "no local worker can perform an external action");
});

test("an old four-role settings file normalizes to the one worker", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-worker-defaults-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "settings.json");
  await writeFile(path, JSON.stringify({
    agents: [
      { id: "direct-responder", title: "直接执行器", role: "direct", description: "", purpose: "", providerId: "claude-code", enabled: true, required: true },
      { id: "context-researcher", title: "上下文研究员", role: "research", description: "", purpose: "", providerId: "claude-code", enabled: true },
      { id: "draft-maker", title: "草拟与交付 Agent", role: "draft", description: "", purpose: "", providerId: "claude-code", enabled: true },
      { id: "evidence-reviewer", title: "证据复核员", role: "review", description: "", purpose: "", providerId: "claude-code", enabled: true },
    ],
  }), "utf8");

  const store = new WorkerSettingsStore(path, builtInProviders, NATIVE_ENV);
  const settings = await store.get();

  // The removed provider falls back to native; the four ids are gone, and the
  // old per-role enable/disable state no longer means anything.
  // 已移除的 Provider 回退到 native；四个旧 ID 消失，旧的按角色启停也不再有任何意义。
  assert.equal(settings.agents.length, 1);
  assert.equal(settings.agents[0]?.id, "worker");
  assert.equal(settings.agents[0]?.providerId, "native");
  assert.equal(settings.agents[0]?.enabled, true);
});

test("the required worker cannot be disabled", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-worker-required-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const store = new WorkerSettingsStore(join(directory, "settings.json"), builtInProviders, NATIVE_ENV);

  await assert.rejects(() => store.setEnabled("worker", false), /executor is required/);
});
