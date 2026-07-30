import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildDemoPlan } from "../src/planning/demo-planner.ts";
import { LocalMemoryStore } from "../src/memory/memory-store.ts";
import { AgentSettingsStore } from "../src/settings/agent-settings.ts";
import { SessionStore } from "../src/sessions/session-store.ts";

test("agent settings persist and change which child roles a plan may use", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-settings-"));
  try {
    const settings = new AgentSettingsStore(join(directory, "settings.json"));
    await settings.setEnabled("context-researcher", false);
    await settings.setEnabled("evidence-reviewer", false);
    const current = await settings.get();
    const plan = buildDemoPlan("调研并准备一份详细的发布方案", new Set(current.agents.filter((agent) => agent.enabled).map((agent) => agent.id)));
    const assigned = plan.steps.flatMap((step) => step.subagents ?? []).map((order) => order.agentId);

    assert.deepEqual(assigned, ["draft-maker"]);
    await assert.rejects(() => settings.setEnabled("direct-responder", false), /required/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Pi can only be assigned to the tool-free direct and review roles", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-settings-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));

  const settings = new AgentSettingsStore(join(directory, "settings.json"));
  await assert.rejects(
    settings.updateAgent("external-operator", { providerId: "pi" }),
    /cannot be assigned to this executor/,
  );
  await assert.rejects(
    settings.updateAgent("draft-maker", { providerId: "pi" }),
    /cannot be assigned to this executor/,
  );
  assert.equal(
    (await settings.updateAgent("evidence-reviewer", { providerId: "pi" }))
      .agents.find((agent) => agent.id === "evidence-reviewer")?.providerId,
    "pi",
  );
});

test("deleted sessions disappear from the companion list while their runtime journal can remain intact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-sessions-"));
  try {
    const sessions = new SessionStore(join(directory, "sessions.json"));
    await sessions.delete("run-1");

    assert.equal(await sessions.isDeleted("run-1"), true);
    assert.equal(await sessions.isDeleted("run-2"), false);
    assert.deepEqual([...await sessions.deletedRunIds()], ["run-1"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("local Memory is automatically deduplicated by candidate id and remains editable by its owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-memory-"));
  try {
    const memory = new LocalMemoryStore(join(directory, "memory.json"));
    const candidate = {
      id: "memory-1",
      runId: "run-1",
      sourceEvidenceIds: ["evidence-1"],
      summary: "候选流程：先核对上下文，再准备可复核交付物。",
      confidence: "low" as const,
      status: "proposed" as const,
      createdAt: "2026-07-26T00:00:00.000Z",
    };
    await memory.sync([candidate, candidate]);
    const [stored] = await memory.list();
    const updated = await memory.update(stored.id, { summary: "发布前先核对上下文，再准备可复核交付物。", status: "archived" });

    assert.equal((await memory.list()).length, 1);
    assert.equal(updated.status, "archived");
    assert.match(updated.summary, /发布前/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("active local Memory is recalled for related work, while archived or disabled Memory stays out", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-memory-recall-"));
  try {
    const memory = new LocalMemoryStore(join(directory, "memory.json"));
    const active = await memory.create("产品发布前先准备风险清单并保留回滚方案");
    const archived = await memory.create("发布采用蓝色主题");
    await memory.update(archived.id, { status: "archived" });

    const recalled = await memory.recall("准备产品发布的风险方案", "run-1");
    assert.deepEqual(recalled.map((item) => item.memory.id), [active.id]);
    assert.equal(recalled[0]?.memory.useCount, 1);
    assert.match(recalled[0]?.matchedTerms.join(" ") ?? "", /发布|风险|方案/);

    await memory.updateSettings({ enabled: false });
    assert.deepEqual(await memory.recall("产品发布风险", "run-2"), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
