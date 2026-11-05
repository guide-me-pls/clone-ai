# Work order: locate orphan recovery, Run model, and test conventions

Read-only investigation for the parent task "reclaim planning-phase orphaned Runs".
No source, test, or policy files were modified. All paths are relative to
`/Users/qihoo/study/clone-ai`.

## (a) `recoverOrphanedRuns` body and statuses handled

- Location: `src/core/runtime.ts:297-346` (method), doc comment `runtime.ts:255-296`.
- Current statuses handled: **`running` and `verifying` only**. The filter is
  `runtime.ts:305`:

  ```ts
  if (candidate.status !== "running" && candidate.status !== "verifying") continue;
  ```

  `planning` is never examined. There is no `planId` filter and **no `updatedAt`
  threshold anywhere in the method** (grep for `threshold|ORPHAN|orphan` in
  `src/core/runtime.ts` / `src/application/run-queue.ts` finds only comments,
  no constant).

Full body (verbatim, `runtime.ts:297-346`):

```ts
async recoverOrphanedRuns(): Promise<Array<{ runId: string; action: "requeued" | "failed"; reason: string }>> {
  await this.hydrate();
  if (this.#journal.readClaim === undefined || this.#journal.claimRun === undefined
    || this.#journal.appendClaimed === undefined || this.#journal.releaseClaim === undefined) return [];
  const now = Date.now();
  const recovered: Array<{ runId: string; action: "requeued" | "failed"; reason: string }> = [];

  for (const candidate of Object.values(this.#state.runs)) {
    if (candidate.status !== "running" && candidate.status !== "verifying") continue;
    const claim = await this.#journal.readClaim(candidate.id);
    if (claim !== undefined && Date.parse(claim.leaseUntil) > now) continue;
    const ownerId = `recovery-${process.pid}-${randomUUID()}`;
    const acquired = await this.#journal.claimRun({ runId: candidate.id, ownerId, leaseMs: 60_000 });
    if (acquired === undefined) continue;
    try {
      await this.refresh();
      const run = this.#state.runs[candidate.id];
      if (run === undefined || (run.status !== "running" && run.status !== "verifying")) continue;
      const external = run.planId === undefined
        ? false
        : (this.#state.plans[run.planId]?.steps ?? []).some((step) => (
          step.risk === "external_side_effect" || step.risk === "irreversible"
          || step.subagents?.some((order) => order.risk === "external_side_effect" || order.risk === "irreversible")
        ));
      const history = this.#journal.listForRun === undefined
        ? await this.#journal.list()
        : await this.#journal.listForRun(run.id);
      const dispatches = history.filter((event) => event.runId === run.id
        && (event.type === "execution.started" || event.type === "subagent.dispatched" || event.type === "subagent.resumed"));
      const unsafeReplay = dispatches.some((event) => (event.payload as { retrySafeAfterInterruption?: boolean }).retrySafeAfterInterruption !== true);
      const failed = run.status === "verifying" || external || unsafeReplay;
      const reason = run.status === "verifying"
        ? "executor died while verifying; the verdict cannot be reconstructed"
        : external
          ? "executor died with external-effect steps; a retry could duplicate the side effect"
          : unsafeReplay
            ? "executor died after a worker without a replay-safety guarantee started; inspect possible side effects before retrying"
            : "executor died; lease expired, work returned to the queue";
      const event = await this.#journal.appendClaimed({
        type: "run.status_changed", taskId: run.taskId, runId: run.id,
        payload: { status: failed ? "failed" : "queued", activeStepId: run.activeStepId, reason },
      }, { runId: run.id, ownerId });
      this.#applyEvent(event);
      recovered.push({ runId: run.id, action: failed ? "failed" : "requeued", reason });
    } finally {
      await this.#journal.releaseClaim({ runId: candidate.id, ownerId }).catch(() => undefined);
    }
  }
  return recovered;
}
```

Caller: `RunQueueConsumer.tick()` (`src/application/run-queue.ts:128`), wrapped
in try/catch so a recovery failure does not stop the queue (`run-queue.ts:127-136`).

### Why planning is a real gap (verified, not assumed)

- A new Run is journaled as `created` then immediately `planning` by
  `acceptTrigger` (`runtime.ts:348-374`); `planId` is only set by the projected
  `plan.created` event (`src/core/run-state.ts:104`).
- Planning is done in-process by the caller (e.g. `companion-server.ts:1401`,
  `run-query.ts:217`, `kernel-tools.ts:127`) and **does not take a claim**:
  `claimRun` call sites are only orphan recovery (`runtime.ts:309`), the direct
  execution path for `queued`/`waiting_approval` (`run-query.ts:262`), review
  (`run-query.ts:386`), and the queue consumer (`run-queue.ts:180`). So a process
  that dies between `acceptTrigger` and `attachPlan` leaves a Run in `planning`
  with no claim and no planId, and no code ever revisits it.
- Transition `planning -> failed` is allowed (`run-state.ts:35`), so failing such
  a Run is a legal journal write. `planning -> queued` is also allowed, but a
  queued Run with no plan would only fail later in dispatch — relevant to the
  parent task's choice, not to this report.
- Companion server lists `planning` Runs as active (`companion-server.ts:2169`),
  so these orphans stay visible indefinitely rather than aging out.

## (b) Live-claim detection and how a Run is marked failed

### Capability gate
`runtime.ts:299-300`: recovery is a no-op returning `[]` unless the journal
implements **all four** of `readClaim`, `claimRun`, `appendClaimed`,
`releaseClaim`. The JSONL store is single-process and intentionally lacks these.

### Live-claim detection
1. `readClaim(candidate.id)` (`runtime.ts:306`) reads the mutable `run_claims`
   row. Implementation `src/core/sqlite-journal.ts:186-192` returns
   `{ runId, ownerId, leaseUntil, attempt }` or `undefined`.
2. A claim is **live** only if `Date.parse(claim.leaseUntil) > now`
   (`runtime.ts:307`). If live, the candidate is skipped: "belongs to whoever
   holds it".
3. Otherwise the recovery tries to atomically acquire the lease itself with
   `ownerId = recovery-${process.pid}-${randomUUID()}` and `leaseMs: 60_000`
   (`runtime.ts:308-310`). `claimRun` (`sqlite-journal.ts:76-108`) decides inside
   one `BEGIN IMMEDIATE` transaction: a live lease held by another owner returns
   `undefined`; an expired lease is stealable and bumps `attempt`.
4. After acquiring, it `refresh()`es and re-reads the Run (`runtime.ts:312-314`);
   a status change between the original scan and the claim aborts the recovery
   (`continue`, then the `finally` releases).
5. The write is fenced: `appendClaimed(...)` runs inside a transaction that
   re-checks `owner_id` and `lease_until > Date.now()` and throws
   `Run claim lost for <id>; refusing a stale executor's journal write.`
   (`sqlite-journal.ts:227-249`). This is what makes recovery safe against a
   second executor that stole the lease in the meantime.
6. `finally` calls `releaseClaim` (`runtime.ts:342`), which **expires** the lease
   row rather than deleting it (`sqlite-journal.ts:171-184`), preserving the
   attempt ledger.

### Marking failed + reason
- Decision (`runtime.ts:327-334`): `failed = run.status === "verifying" || external
  || unsafeReplay`; otherwise `queued`. For `planning` runs, `external` is
  currently computed as `false` because `planId === undefined`
  (`runtime.ts:315-317`) — the plan does not exist yet, so there is no step risk
  to inspect.
- The failure is written as one `run.status_changed` event with payload
  `{ status: "failed", activeStepId, reason }` (`runtime.ts:335-338`). Note
  recovery does **not** apply `redactAuditText` here, unlike `failRun`
  (`runtime.ts:407-412`).
- The event is applied locally with `this.#applyEvent(event)` (`runtime.ts:339`).
  Projection semantics (`run-state.ts:80-97`): status is replaced; when
  `payload.status === "failed"` and `payload.reason` is a string it sets
  `failureReason`; `updatedAt` is set to `event.occurredAt` (the journal append
  time, i.e. "now", **not** the old timestamp).
- Return value: one entry per recovered Run,
  `{ runId, action: "failed" | "requeued", reason }` (`runtime.ts:340, 345`).

## (c) Persistence model fields

### `Run` — `src/core/contracts.ts:171-181`
```ts
export interface Run {
  id: string;
  taskId: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  planId?: string;
  activeStepId?: string;
  failureReason?: string;
}
```
- `status`: union `created | planning | queued | running | waiting_approval |
  verifying | waiting_review | completed | failed | cancelled`
  (`contracts.ts:13-23`).
- `planId`: optional; absent throughout `created`/`planning` until a
  `plan.created` event (`run-state.ts:104`).
- `createdAt` / `updatedAt`: **ISO-8601 strings** (`new Date().toISOString()` at
  `runtime.ts:364-365`; later `updatedAt = event.occurredAt`, e.g.
  `run-state.ts:93,104`). They are compared in code with `Date.parse`, not
  numeric epochs. `updatedAt` advances on `run.status_changed` (`run-state.ts:93`),
  `plan.created` (`run-state.ts:104`), and subagent events
  (`run-state.ts:135,143,172,181,190,199`); for a planning Run the value is the
  occurredAt of the `planning` status event.
- **There are no claim fields on `Run`.** Claims live in a separate mutable table.

### `RunClaim` — `src/core/journal.ts:11-16`
```ts
export interface RunClaim {
  runId: string;
  ownerId: string;
  leaseUntil: string;  // ISO-8601
  attempt: number;
}
```
- Backed by SQLite table `run_claims` (`sqlite-journal.ts:58-65`):
  `run_id TEXT PRIMARY KEY, owner_id TEXT, lease_until TEXT, attempt INTEGER,
  claimed_at TEXT`. It is state, not history (comment `sqlite-journal.ts:49-54`),
  so it is not replayed and does not appear on the `Run` projection.
- Important for the parent task: a crashed planner leaves **no row at all**, so
  `readClaim` returns `undefined`; the existing "live claim" test therefore
  cannot distinguish a dead planner from a fresh one. The age check on
  `run.updatedAt` is the only available discriminator.

## (d) `test/claim-fencing.test.ts` structure and conventions

File: `test/claim-fencing.test.ts` (230 lines, 6 `test(...)` cases).

Conventions observed:
- Imports: `assert` from `node:assert/strict`; `mkdtemp, rm` from
  `node:fs/promises`; `tmpdir`; `join`; `test` from `node:test`. No `describe`
  blocks — flat top-level `test("...", [options,] async (t) => {...})`.
- Fixture: every test creates a temp dir with
  `mkdtemp(join(tmpdir(), "clone-ai-<name>-"))`, a
  `new SqliteJournalStore(join(directory, "journal.sqlite3"))`, and registers
  `t.after(async () => { journal.close(); await rm(directory, { recursive: true, force: true }); })`
  (e.g. lines 17-19, 49-51).
- Runtime construction is inline (no shared helper):
  `new CloneRuntime({ journal, policy: new DefaultPolicyEngine(), verifier: new EvidenceVerifier(), memory: new MemoryPipeline(journal) })`
  (lines 20, 52, 75). Multi-process tests open a second `SqliteJournalStore` on
  the same path and build a `makeRuntime(store)` closure (lines 90-99, 135-143,
  171-179).
- **Runs are not faked.** They are created through the real API:
  `const { run } = await runtime.acceptTrigger({ kind: "manual", summary, payload: {} })`
  then `await runtime.attachPlan(run.id, { summary: "test", steps: [{ id: "s", ... risk: "read_only", ... }] })`
  (lines 21-25 etc.). Statuses are driven by appending journal events, e.g.
  `await journal.append({ type: "run.status_changed", taskId: run.taskId, runId: run.id, payload: { status: "running", activeStepId: "s" } })`
  followed by `await runtime.refresh()` (lines 58-59, 81-83).
- Claims are driven directly:
  `await journal.claimRun({ runId: run.id, ownerId: "old", leaseMs: 1 })`
  (line 60). Journal methods are monkey-patched on the instance to simulate
  races: `journal.renewClaim = async () => false` (line 37);
  `journal.claimRun = async (input) => {...}` (lines 63-66).
- Before assertions the runtime is refreshed so the projection sees events
  appended by another store/process (`await other.refresh()`, lines 131, 189).
- Recovery assertions inspect the typed return value:
  `assert.deepEqual(await runtime.recoverOrphanedRuns(), [])` (line 67);
  `assert.equal(recovered[0]?.action, "failed")` and
  `assert.match(recovered[0]?.reason ?? "", /side effect|replay|retry/i)`
  (lines 85-86); then the projected state
  `assert.equal(runtime.getRun(run.id).status, "failed")` (line 87).
- Assertion style otherwise: `assert.equal`, `assert.deepEqual`, `assert.match`,
  `assert.rejects(..., /status|cancel/i)` (lines 184-188), `assert.ok`. Duration
  guard via `{ timeout: 10_000 }` as the second argument, and polling loops
  (`for (let i = 0; i < 30 && !cancelled; i += 1) await sleep(100)`).
- Worker fakes implement `RuntimeAdapter` with `capabilities()` and an
  `async *execute()` generator yielding `ExecutionEvent`s, plus optional
  `cancel()` (lines 31-36, 109-119, 214-218).
- No helper module is shared by this file; `test/helpers/` only contains
  `companion-api.ts`, and `test/fixtures/scripted-adapter.ts` is used by other
  tests (e.g. `sqlite-journal.test.ts:8`).

Relevant pattern for aging `updatedAt` in a future regression test:
- Journal stores stamp `occurredAt = new Date().toISOString()` internally
  (`sqlite-journal.ts:194-208`, `appendTransactional` ~`228-232`), so an event
  cannot be backdated through the public API.
- The established raw-access pattern is a second `DatabaseSync` connection to
  the same file: `import { DatabaseSync } from "node:sqlite"` and
  `new DatabaseSync(path)` (`test/sqlite-journal.test.ts:5,111`). A test can
  `UPDATE journal_events SET occurred_at = ? WHERE run_id = ? AND type =
  'run.status_changed'` to age a planning Run, or implement a small in-memory
  `JournalStore` whose `append` returns a chosen `occurredAt`.
- `CloneRuntimeOptions` has no clock/`now` injection (`runtime.ts:54-99`).

## (e) Exact test and typecheck commands

From `package.json` (`scripts`):
- `npm test` → `node --experimental-strip-types --test test/*.test.ts`
- `npm run typecheck` → `tsc --noEmit`
- Single file (not a package script; follows the same shape):
  `node --experimental-strip-types --test test/claim-fencing.test.ts`
- Related gate command (AGENTS.md checklist): `npm run gate` →
  `node --experimental-strip-types benchmark/gate.ts`
- Engine: `"node": ">=24"`.

## Summary of the constraints the parent implementation must honor

1. The recovery loop must add `candidate.status === "planning"` as a candidate
   only when `planId === undefined`, `readClaim(candidate.id)` has no live
   lease, and `Date.parse(candidate.updatedAt)` is older than a **named,
   explicit threshold constant**.
2. Planning Runs normally have **no claim row**, so the threshold — not claim
   liveness — is the only protection for a live planner; the claim path still
   fences the eventual write.
3. A planning orphan has no plan, so the existing `external`/`unsafeReplay`
   classification cannot apply; `planning -> failed` is the legal terminal
   transition (`run-state.ts:35`) and `failureReason` will be projected from the
   `reason` payload (`run-state.ts:92`).
4. Tests should follow the temp-dir + real `SqliteJournalStore` + real
   `acceptTrigger` convention, and age `updatedAt` via a raw `DatabaseSync`
   connection or a stub journal because stores stamp their own `occurredAt`.
