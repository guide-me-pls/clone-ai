import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AuthorityPolicyEngine } from "../src/authority/policy-engine.ts";
import { StandingPolicyStore } from "../src/authority/standing-policy-store.ts";
import { declaredWriteTargets, ensureWriteScopes } from "../src/authority/write-scopes.ts";
import type { PlanStep } from "../src/core/contracts.ts";
import { createJournalStore } from "../src/core/sqlite-journal.ts";

/**
 * Writes have no workspace permission. A write step must name where it writes;
 * when it names nothing, the workspace is proposed as an explicit scope, and
 * the policy engine still decides. These cases are the difference between an
 * implicit root and a checked grant.
 * 写入没有工作区权限。写入步骤必须点名写入位置；没有点名时，工作区作为显式 Scope 提出，
 * 仍由权限引擎判定。这些用例区分"隐式根"与"受检授权"。
 */
function step(overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    id: "write",
    title: "Write the result",
    instructions: "Write the result.",
    risk: "reversible_write",
    acceptanceCriteria: ["the result exists"],
    agentId: "draft-maker",
    requiredCapabilities: ["filesystem_write"],
    ...overrides,
  };
}

test("a write step with no target gets the workspace as an explicit scope", () => {
  const [scoped] = ensureWriteScopes([step()], { workspacePath: "/Users/owner/project" });
  assert.deepEqual(scoped?.scopes, [{ domain: "files", resource: "/Users/owner/project", access: "write" }]);
});

test("an absolute target in the instructions wins over the workspace", () => {
  const [scoped] = ensureWriteScopes(
    [step({ instructions: "Write the quarterly report to /tmp/reports/q1.md." })],
    { workspacePath: "/Users/owner/project" },
  );
  assert.deepEqual(scoped?.scopes, [{ domain: "files", resource: "/tmp/reports/q1.md", access: "write" }]);
});

test("a ~/ target is expanded, de-duplicated, and URLs are not paths", () => {
  const target = join(homedir(), "notes", "a.md");
  const [scoped] = ensureWriteScopes(
    [step({ instructions: `Save to ~/notes/a.md and ~/notes/a.md; see https://example.com/docs.` })],
    { workspacePath: "/ws" },
  );
  assert.deepEqual(scoped?.scopes, [{ domain: "files", resource: target, access: "write" }]);
});

test("an existing write scope is kept exactly as declared", () => {
  const declared = { domain: "files" as const, resource: "/srv/output", access: "write" as const };
  const [scoped] = ensureWriteScopes(
    [step({ scopes: [declared] })],
    { workspacePath: "/Users/owner/project" },
  );
  assert.deepEqual(scoped?.scopes, [declared]);
});

test("a files read scope does not satisfy the write requirement", () => {
  const read = { domain: "files" as const, resource: "/Users/owner/project", access: "read" as const };
  const [scoped] = ensureWriteScopes([step({ scopes: [read] })], { workspacePath: "/Users/owner/project" });
  assert.deepEqual(scoped?.scopes, [read, { domain: "files", resource: "/Users/owner/project", access: "write" }]);
});

test("read-only and external steps are left alone", () => {
  const readOnly = ensureWriteScopes([step({ risk: "read_only" })], { workspacePath: "/ws" })[0];
  assert.equal(readOnly?.scopes, undefined);
  const external = ensureWriteScopes([step({ risk: "external_side_effect" })], { workspacePath: "/ws" })[0];
  assert.equal(external?.scopes, undefined);
});

test("declared targets are bounded and keep their order", () => {
  const text = `write to ${Array.from({ length: 12 }, (_, index) => `/tmp/out-${index}.md`).join(" ")}`;
  assert.equal(declaredWriteTargets(text).length, 8);
  assert.equal(declaredWriteTargets(text)[0], "/tmp/out-0.md");
});

test("a path before the write cue is not a write target", () => {
  // "read /etc/hosts and write a summary" names the read input, not an output.
  // "读取 /etc/hosts 并写摘要"点名的是读取输入，不是产出。
  assert.deepEqual(declaredWriteTargets("read /etc/hosts and write a summary"), []);
  assert.deepEqual(declaredWriteTargets("把结果写到 /tmp/report.md"), ["/tmp/report.md"]);
});

test("the proposed workspace scope is still denied while files are observe-only", async () => {
  const home = await mkdtemp(join(tmpdir(), "clone-write-scopes-"));
  const workspace = join(home, "project");
  await mkdir(workspace, { recursive: true });
  const data = join(home, ".clone");
  await mkdir(data, { recursive: true });
  const journal = createJournalStore(data);
  try {
    const store = new StandingPolicyStore(data, journal);
    await store.load();
    const engine = new AuthorityPolicyEngine({ config: () => store.snapshot(), home });
    const [scoped] = ensureWriteScopes([step()], { workspacePath: workspace });
    assert.ok(scoped?.scopes !== undefined);
    const denied = engine.evaluate({ run: {} as never, task: {} as never, step: scoped, approved: true });
    assert.equal(denied.outcome, "denied", "observe-only files must deny even an approved write");

    await store.setDomainLevel("files", "act_with_approval");
    const needsApproval = engine.evaluate({ run: {} as never, task: {} as never, step: scoped, approved: false });
    assert.equal(needsApproval.outcome, "approval_required");
    const approved = engine.evaluate({ run: {} as never, task: {} as never, step: scoped, approved: true });
    assert.equal(approved.outcome, "allowed");
  } finally {
    (journal as { close?: () => void }).close?.();
    await rm(home, { recursive: true, force: true });
  }
});
