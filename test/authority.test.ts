import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { AuthorityPolicyEngine } from "../src/authority/policy-engine.ts";
import { canonicalPath, isForbiddenPath, parseScope, scopeCovers, type Scope } from "../src/authority/scope.ts";
import { StandingPolicyStore } from "../src/authority/standing-policy-store.ts";
import type { PlanStep } from "../src/core/contracts.ts";
import { createJournalStore } from "../src/core/sqlite-journal.ts";

const NOW = new Date("2026-11-03T00:00:00.000Z");

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "clone-authority-"));
  await mkdir(join(home, "Documents"), { recursive: true });
  await mkdir(join(home, ".ssh"), { recursive: true });
  const data = join(home, ".clone");
  await mkdir(data, { recursive: true });
  const journal = createJournalStore(data);
  const store = new StandingPolicyStore(data, journal);
  await store.load();
  const engine = new AuthorityPolicyEngine({ config: () => store.snapshot(), now: () => NOW, home });
  return { home, data, journal, store, engine, cleanup: async () => { (journal as { close?: () => void }).close?.(); await rm(home, { recursive: true, force: true }); } };
}

function step(scopes: Scope[] | undefined, risk: PlanStep["risk"] = "reversible_write"): PlanStep {
  return { id: "s1", title: "t", instructions: "i", risk, acceptanceCriteria: ["x"], agentId: "a", requiredCapabilities: ["drafting"], ...(scopes === undefined ? {} : { scopes }) };
}
const ctx = { run: {} as never, task: {} as never };

test("a step without scopes keeps the risk-based default", async () => {
  const f = await fixture();
  try {
    assert.equal(f.engine.evaluate({ ...ctx, step: step(undefined), approved: false }).outcome, "allowed");
    assert.equal(f.engine.evaluate({ ...ctx, step: step(undefined, "irreversible"), approved: false }).outcome, "approval_required");
  } finally { await f.cleanup(); }
});

test("writes are denied while a domain is observe-only, reads are not", async () => {
  const f = await fixture();
  try {
    const target = join(f.home, "Documents");
    const write = f.engine.evaluate({ ...ctx, step: step([{ domain: "files", resource: target, access: "write" }]), approved: true });
    assert.equal(write.outcome, "denied");
    const read = f.engine.evaluate({ ...ctx, step: step([{ domain: "files", resource: target, access: "read" }], "read_only"), approved: false });
    assert.equal(read.outcome, "approval_required", "no policy covers it yet");
  } finally { await f.cleanup(); }
});

test("act_with_approval needs approval; act_auto with a covering policy does not", async () => {
  const f = await fixture();
  try {
    const target = join(f.home, "Documents");
    const scope: Scope = { domain: "files", resource: target, access: "write" };
    await f.store.setDomainLevel("files", "act_with_approval");
    await f.store.addPolicy({ label: "docs", scopes: [{ domain: "files", resource: target, access: "write" }], maxAutonomy: "act_with_approval" }, NOW);
    assert.equal(f.engine.evaluate({ ...ctx, step: step([scope]), approved: false }).outcome, "approval_required");
    assert.equal(f.engine.evaluate({ ...ctx, step: step([scope]), approved: true }).outcome, "allowed");

    await f.store.setDomainLevel("files", "act_auto");
    const auto = await f.store.addPolicy({ label: "docs auto", scopes: [{ domain: "files", resource: target, access: "write" }], maxAutonomy: "act_auto" }, NOW);
    const decision = f.engine.evaluate({ ...ctx, step: step([{ ...scope, resource: join(target, "sub", "a.md") }]), approved: false });
    assert.equal(decision.outcome, "allowed");
    assert.deepEqual(decision.policyIds?.includes(auto.id), true);
    // Autonomy never waives the risk-based gate for irreversible work. 自主档位豁免不了不可逆工作的风险闸门。
    assert.equal(f.engine.evaluate({ ...ctx, step: step([scope], "irreversible"), approved: false }).outcome, "approval_required");
  } finally { await f.cleanup(); }
});

test("revoked and expired policies stop applying on the next evaluation", async () => {
  const f = await fixture();
  try {
    const target = join(f.home, "Documents");
    const scope: Scope = { domain: "files", resource: target, access: "write" };
    await f.store.setDomainLevel("files", "act_auto");
    const policy = await f.store.addPolicy({ label: "p", scopes: [scope], maxAutonomy: "act_auto" }, NOW);
    assert.equal(f.engine.evaluate({ ...ctx, step: step([scope]), approved: false }).outcome, "allowed");
    await f.store.revokePolicy(policy.id, NOW);
    assert.equal(f.engine.evaluate({ ...ctx, step: step([scope]), approved: false }).outcome, "approval_required");

    await f.store.addPolicy({ label: "old", scopes: [scope], maxAutonomy: "act_auto", validUntil: "2026-01-01T00:00:00.000Z" }, NOW);
    assert.equal(f.engine.evaluate({ ...ctx, step: step([scope]), approved: false }).outcome, "approval_required");
  } finally { await f.cleanup(); }
});

test("protected locations cannot be opened by policy, approval, or symlink", async () => {
  const f = await fixture();
  try {
    await f.store.setDomainLevel("files", "act_auto");
    await f.store.addPolicy({ label: "whole home", scopes: [{ domain: "files", resource: f.home, access: "write" }], maxAutonomy: "act_auto" }, NOW);
    const ssh: Scope = { domain: "files", resource: join(f.home, ".ssh", "id_ed25519"), access: "read" };
    assert.equal(f.engine.evaluate({ ...ctx, step: step([ssh], "read_only"), approved: true }).outcome, "denied");

    await symlink(join(f.home, ".ssh"), join(f.home, "Documents", "link"));
    const viaLink: Scope = { domain: "files", resource: join(f.home, "Documents", "link", "id_ed25519"), access: "read" };
    assert.equal(isForbiddenPath(viaLink.resource, f.home), true);
    assert.equal(f.engine.evaluate({ ...ctx, step: step([viaLink], "read_only"), approved: true }).outcome, "denied");
    assert.equal(isForbiddenPath(join(f.data, "policies.json"), f.home), true);
  } finally { await f.cleanup(); }
});

test("unenforced domains are never grantable", async () => {
  const f = await fixture();
  try {
    const mail: Scope = { domain: "mail", resource: "*", access: "write" };
    assert.equal(f.engine.evaluate({ ...ctx, step: step([mail]), approved: true }).outcome, "denied");
  } finally { await f.cleanup(); }
});

test("scope coverage: subtree, access implication, hosts and commands", async () => {
  const f = await fixture();
  try {
    const dir = join(f.home, "Documents");
    assert.equal(scopeCovers({ domain: "files", resource: dir, access: "write" }, { domain: "files", resource: join(dir, "a"), access: "read" }, f.home), true);
    assert.equal(scopeCovers({ domain: "files", resource: dir, access: "read" }, { domain: "files", resource: join(dir, "a"), access: "write" }, f.home), false);
    assert.equal(scopeCovers({ domain: "files", resource: dir, access: "read" }, { domain: "files", resource: `${dir}-other`, access: "read" }, f.home), false);
    assert.equal(scopeCovers({ domain: "network", resource: "example.com", access: "read" }, { domain: "network", resource: "EXAMPLE.com", access: "read" }, f.home), true);
    assert.equal(scopeCovers({ domain: "shell", resource: "git", access: "exec" }, { domain: "shell", resource: "git status", access: "exec" }, f.home), true);
    assert.equal(scopeCovers({ domain: "shell", resource: "git", access: "exec" }, { domain: "shell", resource: "gitk", access: "exec" }, f.home), false);
    assert.equal(canonicalPath("~/x", f.home), join(await import("node:fs/promises").then((m) => m.realpath(f.home)), "x"));
  } finally { await f.cleanup(); }
});

test("policy edits are journaled and malformed scopes are rejected", async () => {
  const f = await fixture();
  try {
    await f.store.setDomainLevel("files", "prepare");
    const events = await f.journal.list();
    assert.equal(events.filter((event) => event.type === "authority.changed").length, 1);
    assert.throws(() => parseScope({ domain: "files", resource: "relative/path", access: "read" }));
    assert.throws(() => parseScope({ domain: "nope", resource: "/x", access: "read" }));
    await assert.rejects(f.store.addPolicy({ label: "", scopes: [], maxAutonomy: "act_auto" }));
  } finally { await f.cleanup(); }
});

test("an edit made by another process (the CLI) is seen by the next evaluation", async () => {
  const f = await fixture();
  try {
    const other = new StandingPolicyStore(f.data);
    await other.load();
    const target = join(f.home, "Documents");
    const scope: Scope = { domain: "files", resource: target, access: "write" };
    assert.equal(f.engine.evaluate({ ...ctx, step: step([scope]), approved: true }).outcome, "denied");
    await other.setDomainLevel("files", "act_with_approval");
    assert.equal(f.engine.evaluate({ ...ctx, step: step([scope]), approved: true }).outcome, "allowed");
  } finally { await f.cleanup(); }
});

test("the Runtime fails a run whose step reaches a protected location, and records the verdict", async () => {
  const { CloneRuntime } = await import("../src/core/runtime.ts");
  const { EvidenceVerifier } = await import("../src/core/verification.ts");
  const { MemoryPipeline } = await import("../src/memory/memory-pipeline.ts");
  const { createScriptedAgentRegistry } = await import("./fixtures/scripted-adapter.ts");
  const f = await fixture();
  try {
    await f.store.setDomainLevel("files", "act_auto");
    const runtime = new CloneRuntime({ journal: f.journal, policy: f.engine, verifier: new EvidenceVerifier(), memory: new MemoryPipeline(f.journal) });
    const { run } = await runtime.acceptTrigger({ kind: "query", summary: "s", payload: {} });
    await runtime.attachPlan(run.id, {
      summary: "s",
      steps: [{ ...step([{ domain: "files", resource: join(f.home, ".ssh", "id_rsa"), access: "read" }], "read_only"), agentId: "operator", requiredCapabilities: ["general"] }],
    });
    const result = await runtime.execute(run.id, createScriptedAgentRegistry());
    assert.equal(result.status, "failed");
    const decided = (await f.journal.list()).find((event) => event.type === "policy.decided");
    assert.equal((decided?.payload as { decision: { outcome: string; scopeVerdicts?: unknown[] } }).decision.outcome, "denied");
    assert.equal(((decided?.payload as { decision: { scopeVerdicts?: unknown[] } }).decision.scopeVerdicts ?? []).length, 1);
    await assert.rejects(runtime.attachPlan((await runtime.acceptTrigger({ kind: "query", summary: "x", payload: {} })).run.id, {
      summary: "s", steps: [{ ...step([{ domain: "files", resource: "relative", access: "read" } as Scope]), agentId: "operator", requiredCapabilities: ["general"] }],
    }), /absolute/);
  } finally { await f.cleanup(); }
});
