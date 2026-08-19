import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createBuiltInProviderRegistry } from "../src/adapters/built-in-providers.ts";
import { createConfiguredAgentRegistry } from "../src/adapters/configured-agent-registry.ts";
import { ProviderRegistry, type ProviderDefinition } from "../src/adapters/provider-registry.ts";
import type { ExecutionAssignment, ExecutionEvent, RuntimeAdapter, RuntimeCapabilities } from "../src/core/contracts.ts";
import { AgentSettingsStore, defaultAgentSettings } from "../src/settings/agent-settings.ts";

/**
 * Stands in for a third-party coding agent such as opencode. It lives entirely
 * outside src/: if this test passes, integrating a provider never requires
 * editing the Kernel, the settings type, or a dispatch branch.
 * 代表 opencode 之类的第三方 Coding Agent。它完全位于 src/ 之外：本测试通过即意味着
 * 接入一个 Provider 从不需要修改 Kernel、设置类型或分发分支。
 */
const opencodeProvider: ProviderDefinition = {
  id: "opencode",
  label: "opencode",
  createAdapter: ({ agentId, workCapabilities }) => new StubAdapter(agentId, workCapabilities),
};

class StubAdapter implements RuntimeAdapter {
  readonly providerId = "opencode";
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
  const providers = createBuiltInProviderRegistry().register(opencodeProvider);

  const settings = defaultAgentSettings().map((agent) => (
    agent.id === "context-researcher" ? { ...agent, providerId: "opencode" } : agent
  ));
  const registry = createConfiguredAgentRegistry(settings, {
    dataDirectory: join(tmpdir(), "clone-ai-provider-plugin"),
    providers,
  });

  const adapter = registry.get("context-researcher");
  assert.equal(adapter?.providerId, "opencode");
  assert.equal((await adapter!.capabilities()).work.includes("research"), true);
});

test("an unknown provider fails with the list of registered ones", () => {
  const providers = createBuiltInProviderRegistry();
  const settings = defaultAgentSettings().map((agent) => (
    agent.id === "context-researcher" ? { ...agent, providerId: "not-installed" } : agent
  ));

  assert.throws(
    () => createConfiguredAgentRegistry(settings, { dataDirectory: ".", providers }),
    /Unknown execution provider "not-installed".*codex-cli/s,
  );
});

test("a provider states its own role limits instead of the registry hardcoding them", () => {
  const providers = createBuiltInProviderRegistry();

  // Pi declares supportedRoles; the restriction and its reason travel with it.
  // Pi 声明了 supportedRoles；限制及其原因随该 Provider 一起传递。
  assert.equal(providers.supportsRole("pi", "review"), true);
  assert.equal(providers.supportsRole("pi", "external"), false);
  assert.equal(providers.supportsRole("opencode", "external"), false, "unregistered providers support nothing");

  const settings = defaultAgentSettings().map((agent) => (
    agent.id === "external-operator" ? { ...agent, providerId: "pi" } : agent
  ));
  assert.throws(
    () => createConfiguredAgentRegistry(settings, { dataDirectory: ".", providers }),
    /tool-free direct and review roles/,
  );
});

test("settings validate provider ids against the registry, not a closed union", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-settings-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const providers = createBuiltInProviderRegistry().register(opencodeProvider);
  const store = new AgentSettingsStore(join(directory, "settings.json"), providers);

  const updated = await store.updateAgent("context-researcher", { providerId: "opencode" });
  assert.equal(updated.agents.find((agent) => agent.id === "context-researcher")?.providerId, "opencode");

  // Reading back keeps the third-party choice, proving normalize() consults
  // the registry rather than a hardcoded set.
  // 回读仍保留第三方选择，证明 normalize() 查的是 Registry 而不是写死的集合。
  const reloaded = await store.get();
  assert.equal(reloaded.agents.find((agent) => agent.id === "context-researcher")?.providerId, "opencode");

  await assert.rejects(
    store.updateAgent("context-researcher", { providerId: "never-registered" }),
    /Unknown execution provider/,
  );
});

test("a saved provider that is no longer registered falls back to the default", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-settings-drop-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "settings.json");

  const withPlugin = new AgentSettingsStore(path, createBuiltInProviderRegistry().register(opencodeProvider));
  await withPlugin.updateAgent("context-researcher", { providerId: "opencode" });

  // Settings can outlive a plugin being uninstalled; that must not break the
  // runtime, it must fall back.
  // 设置可能比插件的安装存活得更久；这不能让 Runtime 崩溃，而应当回退。
  const withoutPlugin = new AgentSettingsStore(path, createBuiltInProviderRegistry());
  const reloaded = await withoutPlugin.get();
  assert.equal(reloaded.agents.find((agent) => agent.id === "context-researcher")?.providerId, "claude-code");
});

test("registering the same provider id twice is refused", () => {
  const providers = new ProviderRegistry().register(opencodeProvider);
  assert.throws(() => providers.register(opencodeProvider), /already registered/);
});
