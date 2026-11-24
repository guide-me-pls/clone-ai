import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { AuthorityPolicyEngine } from "../src/authority/policy-engine.ts";
import { canonicalPath, isForbiddenPath, parseScope, scopeCovers, type Scope } from "../src/authority/scope.ts";
import { StandingPolicyStore } from "../src/authority/standing-policy-store.ts";
import type { OwnerDecisionNotice, PlanStep } from "../src/core/contracts.ts";
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

test("a write without scopes is denied below 全部放行; other risks keep the risk-based default", async () => {
  const f = await fixture();
  try {
    // 全部放行 is the default and allows an unscoped write; this test pins the
    // act_auto rule, so it opts into that level.
    // 「全部放行」是默认值并允许无 Scope 写入；本测试钉住 act_auto 规则，因此显式设置它。
    await f.store.setDomainLevel("files", "act_auto");
    // There is no default folder: a write that names nowhere has nothing the
    // owner could approve.
    // 没有默认文件夹：没有点名目标的写入没有任何可供所有者批准的东西。
    const write = f.engine.evaluate({ ...ctx, step: step(undefined), approved: false });
    assert.equal(write.outcome, "denied");
    assert.match(write.reason, /names no write scope/);
    assert.equal(f.engine.evaluate({ ...ctx, step: step(undefined, "read_only"), approved: false }).outcome, "allowed");
    assert.equal(f.engine.evaluate({ ...ctx, step: step(undefined, "irreversible"), approved: false }).outcome, "approval_required");
  } finally { await f.cleanup(); }
});

test("a scoped reversible write under observe asks once; protected and other domains stay denied", async () => {
  const f = await fixture();
  try {
    // The default is act_auto for the three enforced domains; this test is the
    // explicit observe path, so it must opt in.
    // 三个已强制域的默认档位是 act_auto；本测试走显式 observe 路径，因此要显式设置。
    await f.store.setDomainLevel("files", "observe");
    await f.store.setDomainLevel("shell", "observe");
    const target = join(f.home, "Documents");
    const scope: Scope = { domain: "files", resource: target, access: "write" };
    const unapproved = f.engine.evaluate({ ...ctx, step: step([scope]), approved: false });
    assert.equal(unapproved.outcome, "approval_required");
    assert.match(unapproved.reason, /observe-only/);
    const approved = f.engine.evaluate({ ...ctx, step: step([scope]), approved: true });
    assert.equal(approved.outcome, "allowed", "the owner's one-step approval lifts the observe denial");
    // The audit reason must name the approval, not the act_auto default.
    // 审计理由必须点名所有者审批，而不是 act_auto 默认值。
    assert.match(approved.reason, /owner approved/i);
    assert.doesNotMatch(approved.reason, /act_auto/);

    const read = f.engine.evaluate({ ...ctx, step: step([{ domain: "files", resource: target, access: "read" }], "read_only"), approved: false });
    assert.equal(read.outcome, "allowed", "reads are machine-wide at every level");

    // A protected target is never approvable, even with the owner's approval.
    // 受保护目标永远不可批准，即使所有者已经批准。
    const protectedScope: Scope = { domain: "files", resource: join(f.home, ".ssh", "id_ed25519"), access: "write" };
    assert.equal(f.engine.evaluate({ ...ctx, step: step([protectedScope]), approved: true }).outcome, "denied");

    // Another domain stays hard under observe. 其他域在 observe 下仍是硬拒绝。
    const shellScope: Scope = { domain: "shell", resource: "rm", access: "exec" };
    assert.equal(f.engine.evaluate({ ...ctx, step: step([shellScope]), approved: true }).outcome, "denied");

    // An irreversible step is not the scoped reversible case. 不可逆步骤不属于带 Scope 的可逆情形。
    assert.equal(f.engine.evaluate({ ...ctx, step: step([scope], "irreversible"), approved: true }).outcome, "denied");
  } finally { await f.cleanup(); }
});

test("act_with_approval needs approval; act_auto allows without a policy or with one", async () => {
  const f = await fixture();
  try {
    const target = join(f.home, "Documents");
    const scope: Scope = { domain: "files", resource: target, access: "write" };
    await f.store.setDomainLevel("files", "act_with_approval");
    const docs = await f.store.addPolicy({ label: "docs", scopes: [{ domain: "files", resource: target, access: "write" }], maxAutonomy: "act_with_approval" }, NOW);
    assert.equal(f.engine.evaluate({ ...ctx, step: step([scope]), approved: false }).outcome, "approval_required");
    assert.equal(f.engine.evaluate({ ...ctx, step: step([scope]), approved: true }).outcome, "allowed");

    await f.store.setDomainLevel("files", "act_auto");
    // A lower ceiling narrows: the earlier act_with_approval policy restricts
    // this subtree even though the domain is now act_auto.
    // 更低的上限起收紧作用：即使域现在是 act_auto，先前的 act_with_approval 策略仍限制
    // 这个子树。
    assert.equal(f.engine.evaluate({ ...ctx, step: step([scope]), approved: false }).outcome, "approval_required");
    await f.store.revokePolicy(docs.id, NOW);
    const auto = await f.store.addPolicy({ label: "docs auto", scopes: [{ domain: "files", resource: target, access: "write" }], maxAutonomy: "act_auto" }, NOW);
    const decision = f.engine.evaluate({ ...ctx, step: step([{ ...scope, resource: join(target, "sub", "a.md") }]), approved: false });
    assert.equal(decision.outcome, "allowed");
    assert.deepEqual(decision.policyIds?.includes(auto.id), true);

    // Without any covering policy, act_auto still allows: the model declared
    // the exact scope, and that declaration is the judgment.
    // 没有任何覆盖策略时，act_auto 仍放行：模型点名了精确 Scope，这份声明就是判断。
    const noPolicyTarget = join(f.home, "Other", "b.md");
    const noPolicy = f.engine.evaluate({ ...ctx, step: step([{ domain: "files", resource: noPolicyTarget, access: "write" }]), approved: false });
    assert.equal(noPolicy.outcome, "allowed");
    assert.equal(noPolicy.policyIds, undefined, "nothing was consulted; no policy id is cited");

    // Autonomy never waives the risk-based gate for irreversible work. 自主档位豁免不了不可逆工作的风险闸门。
    assert.equal(f.engine.evaluate({ ...ctx, step: step([scope], "irreversible"), approved: false }).outcome, "approval_required");
  } finally { await f.cleanup(); }
});

test("the lowest covering policy ceiling wins, so an explicit restriction is never defeated", async () => {
  const f = await fixture();
  try {
    await f.store.setDomainLevel("files", "act_auto");
    const scope: Scope = { domain: "files", resource: join(f.home, "Documents", "secret", "x.md"), access: "write" };
    const broad = await f.store.addPolicy({ label: "broad", scopes: [{ domain: "files", resource: join(f.home, "Documents"), access: "write" }], maxAutonomy: "act_auto" }, NOW);
    await f.store.addPolicy({ label: "narrow", scopes: [{ domain: "files", resource: join(f.home, "Documents", "secret"), access: "write" }], maxAutonomy: "observe" }, NOW);
    const decision = f.engine.evaluate({ ...ctx, step: step([scope]), approved: false });
    assert.equal(decision.outcome, "denied", "a broad grant must not override an explicit observe-only subtree");
    assert.match(decision.reason, /only allow observing/);
    // Outside the narrow subtree the broad grant still applies. 窄子树之外，宽授权仍生效。
    const outside = f.engine.evaluate({ ...ctx, step: step([{ ...scope, resource: join(f.home, "Documents", "public", "y.md") }]), approved: false });
    assert.equal(outside.outcome, "allowed");
    assert.deepEqual(outside.policyIds?.includes(broad.id), true);
  } finally { await f.cleanup(); }
});

test("the default 全部放行 lets a declared scope through and waives the external gate", async () => {
  const f = await fixture();
  try {
    const directory = join(f.home, "Documents");
    const write: Scope = { domain: "files", resource: join(directory, "out.md"), access: "write" };
    const read: Scope = { domain: "files", resource: join(directory, "in.md"), access: "read" };
    const shell: Scope = { domain: "shell", resource: "git", access: "exec" };
    const network: Scope = { domain: "network", resource: "example.com", access: "read" };

    // No policies.json exists: the missing-domain default is 全部放行. The model
    // needs no owner-authored policy, and a write need not name a target.
    // 不存在 policies.json：缺省域为「全部放行」。模型无需所有者策略，写入也不必点名目标。
    assert.equal(f.engine.evaluate({ ...ctx, step: step([write]), approved: false }).outcome, "allowed");
    assert.equal(f.engine.evaluate({ ...ctx, step: step([read], "read_only"), approved: false }).outcome, "allowed");
    assert.equal(f.engine.evaluate({ ...ctx, step: step([shell], "read_only"), approved: false }).outcome, "allowed");
    assert.equal(f.engine.evaluate({ ...ctx, step: step([network], "read_only"), approved: false }).outcome, "allowed");
    assert.equal(f.engine.evaluate({ ...ctx, step: step(undefined), approved: false }).outcome, "allowed", "an unscoped write is allowed at 全部放行");

    const decision = f.engine.evaluate({ ...ctx, step: step([write]), approved: false });
    assert.match(decision.reason, /全部放行/);
    assert.equal(decision.policyIds, undefined, "no policy was consulted");
    assert.deepEqual(decision.unrestrictedDomains, ["files", "shell", "network"]);

    // The external/irreversible gate is waived when every scope is at 全部放行.
    // 当每个 Scope 都是「全部放行」时，外部/不可逆闸门被豁免。
    const external = f.engine.evaluate({ ...ctx, step: step([network], "external_side_effect"), approved: false });
    assert.equal(external.outcome, "allowed");
    assert.equal(external.riskWaived, true);
    const irreversible = f.engine.evaluate({ ...ctx, step: step([write], "irreversible"), approved: false });
    assert.equal(irreversible.outcome, "allowed");
    assert.equal(irreversible.riskWaived, true);
    // Without a scope there is no domain to justify the waiver. 没有 Scope 就没有可据以
    // 豁免的域。
    assert.equal(f.engine.evaluate({ ...ctx, step: step(undefined, "external_side_effect"), approved: false }).outcome, "approval_required");

    // The hard boundaries are unchanged. 硬边界不变。
    const ssh: Scope = { domain: "files", resource: join(f.home, ".ssh", "config"), access: "write" };
    assert.equal(f.engine.evaluate({ ...ctx, step: step([ssh]), approved: false }).outcome, "denied");
  } finally { await f.cleanup(); }
});

test("全部放行 with a narrowing write policy withholds the domain-wide grant", async () => {
  const f = await fixture();
  try {
    await f.store.setDomainLevel("files", "allow_all");
    await f.store.addPolicy({ label: "restrict docs", scopes: [{ domain: "files", resource: join(f.home, "Documents"), access: "write" }], maxAutonomy: "observe" }, NOW);
    // An unscoped write cannot be judged against the narrowing policy, so it
    // must fail instead of receiving `/` and walking around the restriction.
    // 未声明目标的写入无法对照收紧策略，因此必须失败，而不是拿到 `/` 绕过限制。
    assert.equal(f.engine.evaluate({ ...ctx, step: step(undefined), approved: false }).outcome, "denied");
    const narrowed = f.engine.evaluate({ ...ctx, step: step([{ domain: "files", resource: join(f.home, "Documents", "x.md"), access: "write" }]), approved: false });
    assert.equal(narrowed.outcome, "denied");
    assert.equal(narrowed.unrestrictedDomains, undefined, "files cannot be a whole-domain grant while a narrowing policy exists");
    // A target outside the narrowing policy is still allowed by 全部放行.
    // 收紧策略之外的路径仍由「全部放行」允许。
    const outside = f.engine.evaluate({ ...ctx, step: step([{ domain: "files", resource: join(f.home, "Other", "y.md"), access: "write" }]), approved: false });
    assert.equal(outside.outcome, "allowed");
    assert.equal(outside.unrestrictedDomains?.includes("files"), false);
  } finally { await f.cleanup(); }
});

test("全部放行 records a standing-policy approval before an external step runs", async () => {
  const { CloneRuntime } = await import("../src/core/runtime.ts");
  const { EvidenceVerifier } = await import("../src/core/verification.ts");
  const { MemoryPipeline } = await import("../src/memory/memory-pipeline.ts");
  const { checkJournalInvariants } = await import("../src/core/invariants.ts");
  const { createScriptedAgentRegistry } = await import("./fixtures/scripted-adapter.ts");
  const f = await fixture();
  try {
    const runtime = new CloneRuntime({ journal: f.journal, policy: f.engine, verifier: new EvidenceVerifier(), memory: new MemoryPipeline(f.journal) });
    const { run } = await runtime.acceptTrigger({ kind: "query", summary: "external", payload: {} });
    await runtime.attachPlan(run.id, {
      summary: "s",
      steps: [{
        id: "send",
        title: "Send an external request",
        instructions: "Call example.com.",
        risk: "external_side_effect",
        acceptanceCriteria: ["x"],
        agentId: "draft-maker",
        requiredCapabilities: ["drafting"],
        scopes: [{ domain: "network", resource: "example.com", access: "write" }],
      }],
    });
    const result = await runtime.execute(run.id, createScriptedAgentRegistry());
    assert.notEqual(result.status, "waiting_approval", "全部放行 does not prompt");
    const events = await f.journal.list();
    const approval = events.find((event) => event.type === "approval.granted");
    assert.equal((approval?.payload as { grantedBy?: string } | undefined)?.grantedBy, "standing_policy");
    const approvalSequence = approval?.sequence ?? Number.POSITIVE_INFINITY;
    const started = events.find((event) => event.type === "execution.started");
    assert.ok((started?.sequence ?? 0) > approvalSequence, "the policy approval precedes execution");
    assert.deepEqual(checkJournalInvariants(events), []);
  } finally { await f.cleanup(); }
});

test("the Runtime notifies the owner for an approval and for a review", async () => {
  const { CloneRuntime } = await import("../src/core/runtime.ts");
  const { MemoryPipeline } = await import("../src/memory/memory-pipeline.ts");
  const { createScriptedAgentRegistry } = await import("./fixtures/scripted-adapter.ts");
  const f = await fixture();
  try {
    await f.store.setDomainLevel("files", "observe");
    const notices: OwnerDecisionNotice[] = [];
    const runtime = new CloneRuntime({
      journal: f.journal,
      policy: f.engine,
      verifier: { verify: async () => ({ runId: "x", passed: false, needsReview: true, summary: "x", checkedEvidenceIds: [], createdAt: new Date().toISOString() }) } as never,
      memory: new MemoryPipeline(f.journal),
      // A throwing notifier must never change the run's outcome.
      // 抛错的通知器绝不能改变 Run 的结果。
      ownerDecisionNotifier: (notice) => { notices.push(notice); throw new Error("notification failed"); },
    });
    const { run } = await runtime.acceptTrigger({ kind: "query", summary: "写入报告", payload: {} });
    await runtime.attachPlan(run.id, {
      summary: "s",
      steps: [{
        id: "write",
        title: "写入报告",
        instructions: "Write the report.",
        risk: "reversible_write",
        acceptanceCriteria: ["x"],
        agentId: "draft-maker",
        requiredCapabilities: ["drafting"],
        scopes: [{ domain: "files", resource: join(f.home, "Documents", "out.md"), access: "write" }],
      }],
    });
    const first = await runtime.execute(run.id, createScriptedAgentRegistry());
    assert.equal(first.status, "waiting_approval");
    assert.equal(notices.length, 1);
    assert.equal(notices[0]?.kind, "approval");
    assert.match(notices[0]?.detail ?? "", /observe-only/i);

    // The review path: the final verification asks the owner.
    // 复核路径：最终验证把决定交给所有者。
    const { CloneRuntime: Runtime2 } = await import("../src/core/runtime.ts");
    const g = await fixture();
    try {
      const reviews: OwnerDecisionNotice[] = [];
      const verifier = {
        verify: async (input: { run: { id: string } }) => ({
          runId: input.run.id, passed: false, needsReview: true, summary: "结果需要你复核", checkedEvidenceIds: [], createdAt: new Date().toISOString(),
        }),
      };
      const reviewRuntime = new Runtime2({
        journal: g.journal,
        policy: g.engine,
        verifier: verifier as never,
        memory: new MemoryPipeline(g.journal),
        ownerDecisionNotifier: (notice) => reviews.push(notice),
      });
      const { run: reviewRun } = await reviewRuntime.acceptTrigger({ kind: "query", summary: "读一下", payload: {} });
      await reviewRuntime.attachPlan(reviewRun.id, {
        summary: "s",
        steps: [{ id: "read", title: "读取", instructions: "Read.", risk: "read_only", acceptanceCriteria: ["x"], agentId: "draft-maker", requiredCapabilities: ["drafting"] }],
      });
      const result = await reviewRuntime.execute(reviewRun.id, createScriptedAgentRegistry());
      assert.equal(result.status, "waiting_review");
      assert.equal(reviews.length, 1);
      assert.equal(reviews[0]?.kind, "review");
    } finally { await g.cleanup(); }
  } finally { await f.cleanup(); }
});

test("a corrupt policies.json (syntax or semantics) fails closed even though a missing one defaults to 全部放行", async () => {
  const f = await fixture();
  try {
    const scope: Scope = { domain: "files", resource: join(f.home, "Documents", "x.md"), access: "write" };
    // Invalid JSON, an invalid level that would otherwise be silently dropped,
    // and a non-array policies field that would otherwise drop every narrowing
    // policy: all must leave the live snapshot at observe.
    // 非法 JSON、本会被悄悄丢掉的非法档位、本会丢掉所有收紧策略的非数组 policies：
    // 都必须让运行中的快照停在 observe。
    for (const contents of [
      "{ not json",
      '{"version":1,"domains":{"files":"Observe"},"policies":[]}',
      '{"version":1,"domains":{},"policies":{"a":{}}}',
    ]) {
      await writeFile(join(f.data, "policies.json"), contents, "utf8");
      assert.equal(f.store.snapshot().domains.files, "observe");
      assert.equal(f.engine.evaluate({ ...ctx, step: step([scope]), approved: false }).outcome, "approval_required");
    }
  } finally { await f.cleanup(); }
});

test("revoked and expired policies stop applying on the next evaluation", async () => {
  const f = await fixture();
  try {
    const target = join(f.home, "Documents");
    const scope: Scope = { domain: "files", resource: target, access: "write" };
    await f.store.setDomainLevel("files", "act_auto");
    // A policy with a lower ceiling narrows the act_auto default. Revoking it
    // must return the scope to the default on the very next evaluation.
    // 上限更低的策略会收紧 act_auto 默认值；撤销后，下一次评估必须回到默认档位。
    const policy = await f.store.addPolicy({ label: "restrict", scopes: [scope], maxAutonomy: "observe" }, NOW);
    assert.equal(f.engine.evaluate({ ...ctx, step: step([scope]), approved: false }).outcome, "denied");
    await f.store.revokePolicy(policy.id, NOW);
    assert.equal(f.engine.evaluate({ ...ctx, step: step([scope]), approved: false }).outcome, "allowed");

    await f.store.addPolicy({ label: "old", scopes: [scope], maxAutonomy: "observe", validUntil: "2026-01-01T00:00:00.000Z" }, NOW);
    assert.equal(f.engine.evaluate({ ...ctx, step: step([scope]), approved: false }).outcome, "allowed", "an expired policy no longer narrows the default");
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
    // The whole clone home is protected, not only the journal and policies:
    // config.json holds the endpoint key and mcp.json holds server credentials.
    // 整个 clone home 都受保护，不只是 Journal 与策略：config.json 保存端点密钥，
    // mcp.json 保存服务器凭据。
    assert.equal(isForbiddenPath(join(f.data, "config.json"), f.home), true);
    assert.equal(isForbiddenPath(join(f.data, "mcp.json"), f.home), true);
    // The Kernel's isolated sandbox inside it remains usable. 其中由 Kernel 创建的
    // 隔离沙箱仍可用。
    assert.equal(isForbiddenPath(join(f.data, "isolated-workspaces", "run-1", "a.txt"), f.home), false);
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
    await f.store.setDomainLevel("files", "observe");
    const target = join(f.home, "Documents");
    const scope: Scope = { domain: "files", resource: target, access: "write" };
    assert.equal(f.engine.evaluate({ ...ctx, step: step([scope]), approved: false }).outcome, "approval_required");
    await other.setDomainLevel("files", "act_with_approval");
    // The observe carve-out would make the two outcome assertions below pass
    // even if the snapshot never reloaded, so assert the level itself.
    // observe 豁免会让下面两个结果断言即使在快照未重载时也通过，因此直接断言档位。
    assert.equal(f.store.snapshot().domains.files, "act_with_approval");
    assert.equal(f.engine.evaluate({ ...ctx, step: step([scope]), approved: true }).outcome, "allowed");
  } finally { await f.cleanup(); }
});

test("the Runtime turns a scoped write under observe into a waiting approval, then allows it", async () => {
  const { CloneRuntime } = await import("../src/core/runtime.ts");
  const { EvidenceVerifier } = await import("../src/core/verification.ts");
  const { MemoryPipeline } = await import("../src/memory/memory-pipeline.ts");
  const { createScriptedAgentRegistry } = await import("./fixtures/scripted-adapter.ts");
  const f = await fixture();
  try {
    await f.store.setDomainLevel("files", "observe");
    const runtime = new CloneRuntime({ journal: f.journal, policy: f.engine, verifier: new EvidenceVerifier(), memory: new MemoryPipeline(f.journal) });
    const target = join(f.home, "Documents", "out.md");
    const { run } = await runtime.acceptTrigger({ kind: "query", summary: "write", payload: {} });
    await runtime.attachPlan(run.id, {
      summary: "s",
      steps: [{
        id: "write",
        title: "Write the file",
        instructions: "Write the file.",
        risk: "reversible_write",
        acceptanceCriteria: ["x"],
        agentId: "draft-maker",
        requiredCapabilities: ["drafting", "filesystem_write"],
        scopes: [{ domain: "files", resource: target, access: "write" }],
      }],
    });
    const first = await runtime.execute(run.id, createScriptedAgentRegistry());
    assert.equal(first.status, "waiting_approval", "observe asks instead of failing");
    await runtime.grantApproval(run.id, "write");
    const second = await runtime.execute(run.id, createScriptedAgentRegistry());
    assert.notEqual(second.status, "waiting_approval", "the approval lets the step run");

    const decisions = (await f.journal.list())
      .filter((event) => event.type === "policy.decided")
      .map((event) => (event.payload as { decision: { outcome: string } }).decision.outcome);
    assert.deepEqual(decisions.slice(0, 2), ["approval_required", "allowed"]);
  } finally { await f.cleanup(); }
});

test("a Kernel denial is an appeal: the owner approval or an AI allow overrides it", async () => {
  const { CloneRuntime } = await import("../src/core/runtime.ts");
  const { EvidenceVerifier } = await import("../src/core/verification.ts");
  const { MemoryPipeline } = await import("../src/memory/memory-pipeline.ts");
  const { checkJournalInvariants } = await import("../src/core/invariants.ts");
  const { createScriptedAgentRegistry } = await import("./fixtures/scripted-adapter.ts");
  const f = await fixture();
  try {
    // An unenforced domain is denied by the engine; the appeal keeps the same
    // runtime path as a protected location without naming the owner's keys.
    // 未实现强制的域会被引擎拒绝；这条上诉走与受保护位置相同的运行时路径，但不点名
    // 所有者的密钥。
    const runtime = new CloneRuntime({ journal: f.journal, policy: f.engine, verifier: new EvidenceVerifier(), memory: new MemoryPipeline(f.journal) });
    const { run } = await runtime.acceptTrigger({ kind: "query", summary: "s", payload: {} });
    await runtime.attachPlan(run.id, {
      summary: "s",
      steps: [{ ...step([{ domain: "mail", resource: "inbox", access: "read" }], "read_only"), agentId: "draft-maker", requiredCapabilities: ["drafting"] }],
    });
    const first = await runtime.execute(run.id, createScriptedAgentRegistry());
    assert.equal(first.status, "waiting_approval", "a hard denial is an appeal, not a dead end");
    const decided = (await f.journal.list()).find((event) => event.type === "policy.decided");
    assert.equal((decided?.payload as { decision: { outcome: string; scopeVerdicts?: unknown[] } }).decision.outcome, "denied");
    assert.equal(((decided?.payload as { decision: { scopeVerdicts?: unknown[] } }).decision.scopeVerdicts ?? []).length, 1);

    await runtime.grantApproval(run.id, "s1");
    const second = await runtime.execute(run.id, createScriptedAgentRegistry());
    assert.notEqual(second.status, "waiting_approval");
    const events = await f.journal.list();
    assert.equal(events.some((event) => event.type === "approval.granted" && (event.payload as { grantedBy?: string }).grantedBy === "user"), true);
    assert.deepEqual(checkJournalInvariants(events), []);

    await assert.rejects(runtime.attachPlan((await runtime.acceptTrigger({ kind: "query", summary: "x", payload: {} })).run.id, {
      summary: "s", steps: [{ ...step([{ domain: "files", resource: "relative", access: "read" } as Scope]), agentId: "operator", requiredCapabilities: ["general"] }],
    }), /absolute/);
  } finally { await f.cleanup(); }

  const g = await fixture();
  try {
    const runtime = new CloneRuntime({
      journal: g.journal,
      policy: g.engine,
      verifier: new EvidenceVerifier(),
      memory: new MemoryPipeline(g.journal),
      // An AI ALLOW executes the denied step and records who allowed it.
      // AI 放行会执行被拒步骤，并记录是谁允许的。
      policyJudge: async () => ({ decision: "allow", reason: "The owner asked for this calendar read." }),
    });
    const { run } = await runtime.acceptTrigger({ kind: "query", summary: "读取日历", payload: {} });
    await runtime.attachPlan(run.id, {
      summary: "s",
      steps: [{
        id: "read",
        title: "读取日历",
        instructions: "Read today's calendar.",
        risk: "read_only",
        acceptanceCriteria: ["x"],
        agentId: "draft-maker",
        requiredCapabilities: ["drafting"],
        scopes: [{ domain: "calendar", resource: "primary", access: "read" }],
      }],
    });
    const result = await runtime.execute(run.id, createScriptedAgentRegistry());
    assert.notEqual(result.status, "waiting_approval", "the judge's ALLOW executes without the owner");
    const events = await g.journal.list();
    assert.equal(events.some((event) => event.type === "approval.granted" && (event.payload as { grantedBy?: string }).grantedBy === "model_judge"), true);
    assert.deepEqual(checkJournalInvariants(events), []);
  } finally { await g.cleanup(); }

  const h = await fixture();
  try {
    const runtime = new CloneRuntime({
      journal: h.journal,
      policy: h.engine,
      verifier: new EvidenceVerifier(),
      memory: new MemoryPipeline(h.journal),
      policyJudge: async () => ({ decision: "deny", reason: "The request does not justify this app action." }),
    });
    const { run } = await runtime.acceptTrigger({ kind: "query", summary: "s", payload: {} });
    await runtime.attachPlan(run.id, {
      summary: "s",
      steps: [{ ...step([{ domain: "apps", resource: "com.example.app", access: "write" }], "read_only"), agentId: "draft-maker", requiredCapabilities: ["drafting"] }],
    });
    const result = await runtime.execute(run.id, createScriptedAgentRegistry());
    assert.equal(result.status, "failed");
    assert.match(runtime.getRun(run.id).failureReason ?? "", /AI judge denied/);
  } finally { await h.cleanup(); }
});

test("two stores writing the same file cannot resurrect a revoked policy", async (t) => {
  // The CLI and the daemon share policies.json. Each mutator used to compute the
  // next config from its own in-memory copy before enqueuing, so an interleaved
  // write put a revoked policy back as active.
  // CLI 与守护进程共享 policies.json。变更方法过去在入队前基于各自的内存副本算出下一份配置，
  // 因此交错写入会把已撤销的策略重新写成生效。
  const root = await mkdtemp(join(tmpdir(), "clone-authority-cas-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "policies.json");
  const first = new StandingPolicyStore(root);
  const second = new StandingPolicyStore(root);

  const policy = await first.addPolicy({ label: "desktop reads", scopes: [{ domain: "files", resource: "/tmp/a", access: "read" }], maxAutonomy: "act_auto" });
  await second.load();
  await second.revokePolicy(policy.id);

  // The first store still holds a copy where the policy is active. 第一个实例仍持有一份策略生效的副本。
  const added = await first.addPolicy({ label: "second", scopes: [{ domain: "files", resource: "/tmp/b", access: "read" }], maxAutonomy: "act_auto" });
  assert.ok(added.id);

  const disk = JSON.parse(await readFile(file, "utf8")) as { policies: Array<{ id: string; revokedAt?: string }> };
  const revoked = disk.policies.find((item) => item.id === policy.id);
  assert.equal(revoked?.revokedAt !== undefined, true, "the revocation must survive a later write from another instance");
});
