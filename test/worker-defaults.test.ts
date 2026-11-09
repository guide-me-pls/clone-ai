import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { defaultWorkerProfiles, WorkerSettingsStore } from "../src/config/worker-settings.ts";
import { builtInProviders } from "../src/workers/provider-catalog.ts";

const NATIVE_ENV = {
  CLONE_AI_NATIVE_MODEL: "360/anthropic/claude-sonnet-5-5",
  CLONE_AI_NATIVE_BASE_URL: "http://127.0.0.1:3425",
};

test("native is the default for eligible roles only when the endpoint is configured", () => {
  const native = defaultWorkerProfiles(NATIVE_ENV);
  for (const role of ["direct", "research", "draft", "review"] as const) {
    assert.equal(native.find((agent) => agent.role === role)?.providerId, "native", role);
  }
  assert.equal(native.find((agent) => agent.role === "external")?.providerId, "codex-cli");

  const fallback = defaultWorkerProfiles({});
  assert.equal(fallback.find((agent) => agent.role === "draft")?.providerId, "codex-cli");
  assert.equal(fallback.find((agent) => agent.role === "external")?.providerId, "codex-cli");
});

test("a missing settings file gets the native defaults, while saved choices still win", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-worker-defaults-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));

  const missing = new WorkerSettingsStore(join(directory, "missing.json"), builtInProviders, NATIVE_ENV);
  const missingSettings = await missing.get();
  assert.equal(missingSettings.agents.find((agent) => agent.role === "draft")?.providerId, "native");

  const file = join(directory, "settings.json");
  await writeFile(file, JSON.stringify({
    agents: [{ id: "draft-maker", providerId: "claude-code", enabled: true }],
  }), "utf8");
  const store = new WorkerSettingsStore(file, builtInProviders, NATIVE_ENV);
  const settings = await store.get();
  assert.equal(settings.agents.find((agent) => agent.id === "draft-maker")?.providerId, "claude-code");
  assert.equal(settings.agents.find((agent) => agent.id === "context-researcher")?.providerId, "native");
});
