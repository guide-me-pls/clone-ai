import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createBuiltInProviderRegistry } from "../src/workers/provider-catalog.ts";
import { createConfiguredAgentRegistry } from "../src/workers/configured-worker-registry.ts";
import { ProviderRegistry, type ProviderDefinition } from "../src/workers/provider-registry.ts";
import type { ExecutionAssignment, ExecutionEvent, RuntimeAdapter, RuntimeCapabilities } from "../src/core/contracts.ts";
import { WorkerSettingsStore, defaultWorkerProfiles } from "../src/config/worker-settings.ts";
import { WorkerRegistry } from "../src/workers/worker-registry.ts";

/**
 * Stands in for a third-party coding agent the project has never heard of. It lives entirely
 * outside src/: if this test passes, integrating a provider never requires
 * editing the Kernel, the settings type, or a dispatch branch.
 * 代表项目从未听说过的第三方 Coding Agent。它完全位于 src/ 之外：本测试通过即意味着
 * 接入一个 Provider 从不需要修改 Kernel、设置类型或分发分支。
 */
const acmeProvider: ProviderDefinition = {
  id: "acme-agent",
  label: "Acme Agent",
  createAdapter: ({ agentId, workCapabilities }) => new StubAdapter(agentId, workCapabilities),
};

class StubAdapter implements RuntimeAdapter {
  readonly providerId = "acme-agent";
  readonly id: string;
  readonly #work: string[];

  constructor(id: string, work: string[]) {
    this.id = id;
    this.#work = work;
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    return { resume: false, cancellation: false, approvalCallback: false, parallelAssignments: true, work: [...this.#work] };
  }

  async *execute(_input: ExecutionAssignment): AsyncIterable<ExecutionEvent> {
    yield { type: "completed", summary: "stub" };
  }
}

test("a third-party provider becomes selectable by registration alone", async () => {
  const providers = createBuiltInProviderRegistry().register(acmeProvider);

  const settings = defaultWorkerProfiles().map((agent) => (
    agent.id === "context-researcher" ? { ...agent, providerId: "acme-agent" } : agent
  ));
  const registry = await createConfiguredAgentRegistry(settings, {
    dataDirectory: join(tmpdir(), "clone-ai-provider-plugin"),
    providers,
  });

  const adapter = registry.get("context-researcher");
  assert.equal(adapter?.providerId, "acme-agent");
  assert.equal((await adapter!.capabilities()).work.includes("research"), true);
});

test("an unknown provider fails with the list of registered ones", async () => {
  const providers = createBuiltInProviderRegistry();
  const settings = defaultWorkerProfiles().map((agent) => (
    agent.id === "context-researcher" ? { ...agent, providerId: "not-installed" } : agent
  ));

  await assert.rejects(
    createConfiguredAgentRegistry(settings, { dataDirectory: ".", providers }),
    /Unknown execution provider "not-installed".*codex-cli/s,
  );
});


test("settings validate provider ids against the registry, not a closed union", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-settings-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const providers = createBuiltInProviderRegistry().register(acmeProvider);
  const store = new WorkerSettingsStore(join(directory, "settings.json"), providers);

  const updated = await store.updateAgent("context-researcher", { providerId: "acme-agent" });
  assert.equal(updated.agents.find((agent) => agent.id === "context-researcher")?.providerId, "acme-agent");

  // Reading back keeps the third-party choice, proving normalize() consults
  // the registry rather than a hardcoded set.
  // 回读仍保留第三方选择，证明 normalize() 查的是 Registry 而不是写死的集合。
  const reloaded = await store.get();
  assert.equal(reloaded.agents.find((agent) => agent.id === "context-researcher")?.providerId, "acme-agent");

  await assert.rejects(
    store.updateAgent("context-researcher", { providerId: "never-registered" }),
    /Unknown execution provider/,
  );
});

test("a saved provider that is no longer registered falls back to the default", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-settings-drop-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "settings.json");

  const withPlugin = new WorkerSettingsStore(path, createBuiltInProviderRegistry().register(acmeProvider));
  await withPlugin.updateAgent("context-researcher", { providerId: "acme-agent" });

  // Settings can outlive a plugin being uninstalled; that must not break the
  // runtime, it must fall back.
  // 设置可能比插件的安装存活得更久；这不能让 Runtime 崩溃，而应当回退。
  const withoutPlugin = new WorkerSettingsStore(path, createBuiltInProviderRegistry());
  const reloaded = await withoutPlugin.get();
  assert.equal(reloaded.agents.find((agent) => agent.id === "context-researcher")?.providerId, "claude-code");
});

test("registering the same provider id twice is refused", () => {
  const providers = new ProviderRegistry().register(acmeProvider);
  assert.throws(() => providers.register(acmeProvider), /already registered/);
});

test("listing an untrusted provider does not execute its version command", { skip: process.platform === "win32" }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-provider-probe-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const marker = join(directory, "executed.txt");
  const executable = join(directory, "untrusted-provider");
  await writeFile(executable, `#!/bin/sh\nprintf executed > '${marker}'\nprintf '1.0\\n'\n`, "utf8");
  await chmod(executable, 0o700);
  await writeFile(join(directory, "providers.json"), JSON.stringify({ providers: [{ id: "untrusted", command: executable }] }), "utf8");
  const providers = await new WorkerRegistry(directory).list();
  assert.equal(providers.find((provider) => provider.id === "untrusted")?.installed, true);
  await assert.rejects(readFile(marker), /ENOENT/);
});
