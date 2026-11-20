# Optimization results

**English** · [简体中文](optimization-results.zh-CN.md)

This file records **what actually worked**, one entry per verified improvement,
newest first. Each entry states the claim, the evidence that supports it (a
command, numbers, a result file), and where the work is described in full.

A negative optimization — one whose eval showed no gain, a regression, or that
was reverted — is **not** recorded here. Its trade-off entry remains in
[`docs/architecture/trade-offs.md`](../architecture/trade-offs.md) as the record
of the decision and its reversal. The reasoning and the execution chain stay in
[`optimizations.md`](optimizations.md); this file only keeps the outcomes worth
citing.

See [`AGENTS.md`](../../AGENTS.md) rule 6.

## 2026-11-20 — A verification failure names its cause once

- **Claim:** a failed verification now says whether a promised path is missing,
  a directory, unreadable, or outside the roots this step may verify, and the
  composite summary carries exactly one "Verification failed." prefix.
- **Evidence:** the lane's regression is red before and green after; the
  worktree suite is **952/952**, typecheck 0, gate PASS after the one stale
  test-contract update; on main the targeted cases are **18/18**, the full suite
  **956/956**, typecheck exit 0, gate **PASS**. Landed as `78006a9` after the
  protected-path approval. The four lane runs cost ~408 s / 52 model calls /
  410,701 tokens.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-20--a-verification-failure-says-why-once);
  [execution chain](optimizations.md#2026-11-20--a-verification-failure-says-why-once).


## 2026-11-19 — A provider-blocked answer is reported as a failure

- **Claim:** a response with `content_filter` or another defined finish reason
  outside `stop/end_turn/stop_sequence/completed` is no longer stored as a
  completed answer; the turn fails with the finish reason and the owner sees a
  Chinese summary and next step. `length`/`max_tokens` keep the truncation
  failure, and a normal `stop` still completes.
- **Evidence:** the loop cases are red on the old code (content_filter and an
  unknown value both complete) and green after; the display test is red on the
  old mapping. `test/agent-loop.test.ts` **31/31**, `test/failure-display.test.ts`
  **2/2**, `npm test` **951/951**, typecheck exit 0, gate **PASS**.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-19--a-provider-stop-is-a-failure-not-a-completed-answer);
  [execution chain](optimizations.md#2026-11-19--a-provider-stop-is-a-failure-not-a-completed-answer).

## 2026-11-19 — A failed trace carries its step instructions

- **Claim:** `FailedTrace.plan` now carries each step's redacted instructions,
  acceptance criteria, required capabilities, scopes and subagent count, so the
  repair lane can reproduce a plan- or verification-level failure from the trace
  alone.
- **Evidence:** `test/failed-traces.test.ts` is red on the old exported shape
  (no `instructions`) and green after; the file is **3/3**; `npm test`
  **946/946**, typecheck exit 0, gate **PASS**. The gap was recorded by the
  verifier lane's failed run `8464295d`.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-19--a-failed-trace-carries-the-steps-instructions);
  [execution chain](optimizations.md#2026-11-19--a-failed-trace-carries-the-steps-instructions).

## 2026-11-19 — A first-send no_progress shows the summary and next step

- **Claim:** the failed SSE event carries `errorSummary` and `errorGuidance`, and
  the first-send failure card renders them with the raw error collapsed. A
  first-send no-progress stop shows "已停止以免空转" and its next step instead of
  only the raw English loop error.
- **Evidence:** the new server case scripts five identical `get_run_status`
  calls and is red on the old payload (no `errorSummary`), green after;
  `test/companion-main-agent.test.ts` **8/8**, `test/ui-structure.test.ts`
  **28/28**; in the shared tree `npm test` **945/946** — the one failure is
  another session's untracked `.claude/launch.json`, and moving it aside gives
  **946/946**; typecheck exit 0, gate **PASS**.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-19--a-first-send-failure-shows-the-owner-facing-reason-not-the-raw-loop-error);
  [execution chain](optimizations.md#2026-11-19--a-first-send-failure-shows-the-owner-facing-reason).

## 2026-11-19 — The sidebar holds one row per conversation, not one per run

- **Claim:** a conversation's dispatched runs no longer appear in the sidebar.
  The list is conversations (main pinned, then today/earlier) plus one row per
  task waiting on the owner; a running, completed, or conversation-less run has
  no row. The same runs are still one click away in 设置 → 审计与轨迹, and the
  conversation keeps a one-line 依据 naming how many were dispatched.
- **Evidence:** the sidebar sandbox renders a fixture with a running task, a
  waiting task, a main-conversation task and a scheduled run: the three
  non-waiting runs produce **0** `data-test-session` rows (before: 1 each), the
  waiting task produces exactly **1** under `session-group-needs`, and the count
  drops from conversations + runs to conversations + waiting tasks.
  `test/ui-structure.test.ts` finds no `session-children`, no `data-child-group`,
  no `autoBlock` and no `data-log-run` in the source, and the turn log carries
  no 产物 block. `npm run typecheck` exit 0, `npm run gate` PASS, baseline
  unchanged, `npm test` **943/944** (the one failure is a concurrent chat's
  `.claude/launch.json`, not this change).
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-19--the-sidebar-is-conversations-only-run-detail-lives-in-the-audit);
  [execution chain](optimizations.md#2026-11-19--the-sidebar-lists-conversations-a-turns-runs-are-read-in-the-audit).

## 2026-11-19 — A clone home has one runtime, so the window attaches instead of waiting

- **Claim:** a packaged window no longer shows "launchd 没有在 60 秒内发布端点"
  while a daemon is alive. `npm run desktop:dev` boots the resident LaunchAgent
  out for its session, and a second companion on the same home refuses to start
  before it hydrates the journal, claims the turn ledger or overwrites the
  endpoint.
- **Evidence:** `node --experimental-strip-types --test test/companion-singleton.test.ts`
  — before the change **3/3 failed** (a second sidecar started in a separate
  process, a second server started in the same process, a dead owner's lock
  blocked nothing); after **3/3 pass**, the child exits nonzero with
  `Another Clone AI runtime (pid …) already owns <home>`, the endpoint file is
  byte-identical, and the stale lock is reclaimed. Live observation before the
  fix: launchd pid 46832 and dev sidecar 53933 both alive, endpoint and
  turn-owner file both naming 53933. `npm run typecheck` exit 0, `npm run gate`
  PASS (baseline unchanged); `npm test` 940/944 with four failures in files a
  concurrent session was editing, none of them reading this change. Live after
  the fix: the LaunchAgent was absent while the dev session ran, one sidecar
  owned the endpoint and turn ledger (`/api/health` 200), and stopping the
  driver restored the job and started a new daemon.
- **Links:** [trade-off](../architecture/trade-offs.md#2026-11-19--one-runtime-per-clone-home-dev-mode-takes-the-launchagent-down-a-second-sidecar-refuses-to-start),
  [execution chain](optimizations.md#2026-11-19--dev-mode-and-launchd-no-longer-run-two-sidecars-on-one-clone-home).

## 2026-11-19 — A declared effort level reaches the provider instead of a 400

- **Claim:** a level the gateway declares for a model is no longer refused by
  clone-ai's own validation. `360/openai/gpt-6.1-terra` declares
  `none, low, medium, high, xhigh, max, ultra`; `ultra` previously returned
  HTTP 400 from `POST /api/main-agent/stream` and `PATCH /api/config`, so the
  composer and Settings pickers offered a choice the server rejected. After the
  change the name is trimmed, bounded at 64 characters, and forwarded as
  `reasoning_effort`; only a value that is not a name (a non-string, empty, or
  over-long) is refused.
- **Evidence:** live gateway `curl 127.0.0.1:3425/v1/models` shows eleven
  models declaring 3–7 levels each; `reasoning_effort` set to
  `off`/`ultra`/`medium`/`xhigh`/`minimal` across three models returned 200
  every time. `test/companion-main-agent.test.ts` asserts the fake provider
  receives `reasoning_effort: "ultra"`; `test/companion-config-api.test.ts`
  stores and clears `ultra` through `PATCH /api/config` and still refuses `42`.
  `npm test` **934/934**, `npm run typecheck` exit 0, `npm run gate` PASS,
  baseline unchanged.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-19--reasoning-effort-is-whatever-the-gateway-declares-not-a-fixed-seven);
  [execution chain](optimizations.md#2026-11-19--the-effort-picker-and-the-server-disagree-on-level-names-the-lane-could-not-start-so-the-owner-approved-a-patch).

## 2026-11-19 — A failed run's lesson must cite the failure

- **Claim:** a procedure mined from a failed run is accepted only when it cites
  evidence that records the failure. The recorded memory `mem-81aab49b-a11` —
  a task restatement citing a successful directory listing — is refused, while
  the task's durable preference ("以后所有报告默认使用简体中文") is kept on
  **2/3** failed-run samples and **3/3** completed-run samples. A memory file
  no longer repeats its summary as the first line of its content.
- **Evidence:** `npm run gate` **PASS**, memory **31/31** with five new cases;
  the first full `npm test` was **930/931** (the one failure was a new
  English-only comment, fixed); typecheck exit 0. Real model, 3 samples per
  outcome on the recorded run: before, **3/3** failed-run samples (the stored
  memory plus two probes) produced a task-restating procedure; after, **0 kept
  lessons** in both outcomes, with the durable preference kept **3/3** on the
  completed outcome and **2/3** on the failed one —
  `benchmark/results/memory-failure-lesson-2026-11-19T09-11-25-790Z.json`.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-19--a-failed-runs-lesson-must-cite-the-failure);
  [execution chain](optimizations.md#2026-11-19--a-failed-runs-lesson-must-cite-the-failure).

## 2026-11-19 — The internal base is the machine root

- **Claim:** the runtime's internal base is `/` when no explicit
  `CLONE_AI_WORKSPACE` is set; a task's relative paths and the verifier start
  from the machine, and the execution lock stays under the clone home instead of
  creating `/.clone`.
- **Evidence:** `test/clone-home.test.ts` pins the `/` default, the explicit and
  environment overrides, and `workspaceLockFile` under the clone home;
  `test/workspace-lock-abort.test.ts` uses an explicit lock file and asserts no
  `workspace/.clone`. `npm test` **927/927**, typecheck exit 0, gate **PASS**.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-19--the-internal-base-is-the-machine-root-not-a-folder);
  [execution chain](optimizations.md#2026-11-19--the-internal-base-is-the-machine-root-not-a-folder).

## 2026-11-19 — A failed turn stays visible beside its running child

- **Claim:** a conversation whose latest turn failed or was interrupted no longer
  reads 运行中 because a child run is active. The row reads 需要处理 and its
  preview shows the turn's failure plus "N 个任务仍在执行"; a waiting child still
  yields its waiting status, and a completed/running turn with an active child
  still reads running.
- **Evidence:** the new `test/companion-control-plane.test.ts` case is red on the
  old order (row running, preview "1 个任务正在执行") and green after; the file is
  **28/28**, `npm test` **941/941**, typecheck exit 0, gate **PASS**.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-19--a-failed-turn-stays-visible-in-the-sidebar-while-its-child-run-is-active);
  [execution chain](optimizations.md#2026-11-19--a-failed-turn-is-not-hidden-by-its-running-child).

## 2026-11-19 — A failed run says why it failed

- **Claim:** a policy denial now records its reason, and a failed verification
  or rejected review records the verification summary, in `run.status_changed`;
  `run.failureReason` therefore covers every failure. `get_run_status` prints
  `Failure:`, `dispatch_task`/`QueryRunResult` return `failureReason`, and the
  work update/opportunity card read it instead of "没有记录到具体原因".
- **Evidence:** `test/regression/failure-reason.test.ts` is red before (6
  failing assertions on policy, verification replay, status reader and
  `runQuery`) and green after; `npm test` **940/940**, typecheck exit 0, gate
  **PASS**. Landed as `443aa73` after the protected-path override. Patch and
  report: `.automation/repair-reports/failure-reason-20261119T0851.{patch,json}`.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-19--a-failed-run-carries-its-reason-and-the-main-agent-can-read-it);
  [execution chain](optimizations.md#2026-11-19--a-failed-runs-reason-reaches-the-model-and-the-owner).

## 2026-11-19 — Alternating and masked polls stop as no progress

- **Claim:** the shared loop now counts each executed call's identity across the
  turn. Two identical `get_run_status` polls alternated with each other, or one
  poll sharing a batch with a read whose result changes, still reach the warning
  at three and the `no_progress` stop at five. A call whose result changes is
  still progress, and the exact eight-poll incident still stops at five.
- **Evidence:** the two new `test/agent-loop.test.ts` cases are red on the
  pre-change loop (both complete) and green after; the full file is **28/28**.
  The alternation stops at round 9, the masked poll at round 5, the eight
  identical polls at round 5; A,A,B,A,A completes. `npm test` **924/924**,
  typecheck exit 0, gate **PASS**.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-19--the-no-progress-guard-counts-each-call-across-the-turn-not-adjacent-batches);
  [execution chain](optimizations.md#2026-11-19--the-no-progress-guard-counts-each-call-across-the-turn).

## 2026-11-19 — The recorded verifier plan no longer fails on its own search paths

- **Claim:** on the actual `fa36a720` `plan.created` step,
  `extractFileExpectations` now returns `[]`; the slash in
  "package.json / pnpm-workspace.yaml" and the "里的线索" search location no
  longer become file promises, while real deliverables (including spaced
  absolute paths) are still checked.
- **Evidence:** the new regression is red before
  (`["/ pnpm-workspace.yaml","/Users/qihoo/.clone"]`) and green after (`[]`);
  lane suite **919/919**, typecheck 0; on main both regressions plus
  `test/verification.test.ts` and `test/fallback-planner.test.ts` **31/31**,
  full suite **922/922**, gate **PASS**. Landed as `763dcd8` after the
  protected-path override. The lane report was later overwritten by a
  `no-traces` run; the commit and the tests are the evidence.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-19--a-search-location-is-not-a-file-promise-and-the-incidents-real-plan-is-the-fixture);
  [execution chain](optimizations.md#2026-11-19--the-verifiers-real-plan-is-the-fixture-search-locations-are-not-file-promises).

## 2026-11-19 — Read-only dispatch objectives stay read-only in the fallback planner

- **Claim:** `dispatch_task` objectives that say 只读 / 不修改 no longer become a
  `reversible_write` plan just because they mention 保存 / 写 in the code they
  describe. Both recorded objectives plan as one `read-only-lookup`, while a
  named write target still plans delivery.
- **Evidence:** the regression
  `test/regression/fallback-read-only-dispatch.test.ts` is red before (both
  plans `prepare/reversible_write` with a draft subagent) and green after; the
  lane's full suite is **919/919** and typecheck exit 0; on main the regression
  plus `test/fallback-planner.test.ts` is **13/13**. Lane report:
  `.automation/repair-reports/planner-20261119T0812.json`.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-19--a-read-only-marker-outranks-a-bare-write-verb-in-the-fallback-planner);
  [execution chain](optimizations.md#2026-11-19--a-read-only-dispatch-objective-no-longer-plans-as-a-write).

## 2026-11-19 — There is no configured working directory

- **Claim:** the 工作目录 setting and the persisted folder are gone; a write must
  name its exact target and no folder is writable by default; runtime locks and
  the execution database live in the clone home; the verifier verifies a write
  outside the internal base through the step's declared write scope.
- **Evidence:** `test/write-scopes.test.ts` **12/12**, `test/authority.test.ts`
  **12/12**, `test/companion-config-api.test.ts` **17/17**,
  `test/verification.test.ts` **17/17**; the golden path, chaos (kill/restart)
  and repair-lane tests pass; full suite **918/919** (one unrelated failure from
  another session's `.claude/launch.json`); typecheck exit 0; gate **PASS** with
  a one-line baseline change (`policy/local-write-allowed`:
  allowed → `policy/local-write-without-scope-denied`: denied). The owner's
  request is the usability evidence; no owner session was measured.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-19--there-is-no-configured-working-directory-a-write-names-its-targets);
  [execution chain](optimizations.md#2026-11-19--there-is-no-configured-working-directory-a-write-names-its-targets).

## 2026-11-19 — A directory-introduced path is not a promised file, and a spaced path stays whole

- **Claim:** the verifier no longer fails a run because its instructions
  introduced a directory as context (`数据目录 /path`), and an absolute file path
  containing spaces is extracted whole. The two named forms are handled; the
  recorded read-only investigation's real plan text was **not** cleared by this
  patch (see the correction below).
- **Evidence:** the repair lane's regression case **1/1**;
  `test/verification.test.ts` **16/16**; full suite on main **916/916**;
  typecheck exit 0; gate **PASS**; a reproduction of the recorded instruction
  text returns `extracted: []` and `needsReview`; a spaced write path returns
  `[{"path":"/Users/qihoo/Documents/Clone AI/out.md"}]`. Landed as commit
  `6dc13f0`, after the lane's protected-path gate refused it and the owner
  explicitly approved the verified patch.
- **Correction (2026-11-19 audit):** replaying the real `plan.created` step
  (journal seq 1818) on the merged extractor returns two false promises —
  `/Users/qihoo/.clone` and a new `/ pnpm-workspace.yaml` — and
  `EvidenceVerifier` still returns `passed:false`. The fixture used reduced
  instructions. A follow-up lane patch with the real instructions landed as
  `763dcd8` after the owner approved it; the corrected decision is the "search
  location is not a file promise" entry in `trade-offs.md`.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-19--a-path-introduced-as-a-directory-is-not-a-file-promise-and-a-spaced-path-is-one-path);
  [execution chain](optimizations.md#2026-11-19--the-verifier-path-fix-was-produced-by-the-lane-refused-by-the-protected-path-gate-and-merged-by-the-owner).

## 2026-11-19 — Agent settings show the model choice, not the wiring

- **Claim:** Settings → Agent no longer exposes the Magpie loopback URL
  (`http://127.0.0.1:3425/v1`) or a duplicate 当前模型 card with the raw
  provider/model id; the connection state, explanation and friendly model
  picker remain.
- **Evidence:** `test/ui-locale.test.ts` **4/4** asserts the URL, the
  `gateway?.endpoint` expression and `label: "当前模型"` are absent while
  `id: "gateway-model"` and `data-gateway-apply` remain; a live page after the
  new sidecar started shows exactly two overview cards and no endpoint; `npm
  test` **910/910**, `npm run typecheck` exit 0, `npm run gate` **PASS**.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-19--agent-settings-show-the-connection-not-the-loopback-url-or-raw-model-id),
  [execution chain](optimizations.md#2026-11-19--agent-settings-stop-printing-the-loopback-url-and-the-duplicate-raw-model-id).

## 2026-11-19 — A conversation table renders as a table and exports to CSV

- **Claim:** a GFM table in a reply now renders as a real table in the
  conversation — header, alignment, inline code and bold in cells, escaped
  pipes, horizontal scrolling on narrow windows — instead of the literal `|`
  and `---` rows. Every rendered table carries a 导出 CSV control that writes a
  timestamped CSV into the folder the owner picks; Excel opens it directly.
- **Evidence:** `test/ui-structure.test.ts` **24/24** (parser, alignment,
  escaped pipes, code-fence isolation, HTML escaping, CSV payload, browser
  download and native-picker wiring); `test/desktop-only-surface.test.ts`
  **5/5** (the CSV is written byte for byte; empty, relative, missing and
  data-directory targets are refused); `npm test` **910/910**;
  `npm run typecheck` exit 0; `npm run gate` **PASS**, baseline unchanged. A
  static render of the real markup and styles at 1024×900 and 375×812 shows the
  table and control with no page horizontal overflow. The usability gain is
  assumed beyond that check; no owner session was measured.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-19--a-conversation-table-renders-as-a-table-and-exports-to-csv-on-request);
  [execution chain](optimizations.md#2026-11-19--a-conversation-table-renders-as-a-table-and-exports-to-csv).

## 2026-11-19 — A repeated tool call stops the turn locally, and a live run is not polled

- **Claim:** the shared loop now warns at the third consecutive identical call
  and stops at the fifth with `no_progress`; it identifies a call by tool name,
  canonicalized arguments and result text, so a call whose result changes is
  still progress. The Main Agent is told that a run proposed by
  `propose_work_plan` advances on its own, that `get_run_status` is a snapshot
  and must not be polled, and a live run's status now says so. A worker stopped
  this way is reported as `no_progress`, not `completed`, and the owner gets a
  Chinese summary and next step.
- **Evidence:** `test/agent-loop.test.ts` **23/26 before** the change (the three
  failures are the no-progress stop, the warning, and reordered JSON keys) →
  **26/26 after**; `test/main-agent.test.ts` **16/16**; `npm test` **906/906**;
  `npm run typecheck` exit 0; `npm run gate` **PASS**, baseline unchanged. The
  production failure is in the owner's journal: turn `fa63e0f3…` called
  `get_run_status` eight times for run `fa36a720…` with the same `running`
  projection, and the external gateway's stop was stored as a completed reply.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-19--a-repeated-tool-call-stops-the-turn-locally-and-a-queued-run-is-not-polled);
  [execution chain](optimizations.md#2026-11-19--a-repeated-tool-call-stops-the-turn-locally-so-a-queued-run-is-not-polled).

## 2026-11-19 — A conversation turn shows its result and evidence, not the process

- **Claim:** the conversation's reading column now carries only the request, the
  result, the produced runs and one 依据 line. The model, prompt snapshot, tool
  table and every tool call's input are no longer rendered there, and a 查看审计
  control lands on 主 Agent 回合 filtered to that turn by its id and
  conversation.
- **Evidence:** `test/ui-structure.test.ts` flips from asserting 上下文 / 派发 /
  the model string / `charter v3` / `dispatch_task` in the conversation markup to
  asserting they are absent and 结果 / 产物 / 依据 / the audit link are present,
  renders `assemblyBlock` for the compaction summary and `turnsView` for the
  dropped tool list (**26/26**); `npm test` **916/916**; `npm run typecheck` exit
  0; `npm run gate` **PASS**, baseline unchanged. A static render of the real
  markup and CSS shows a four-call turn as the answer plus
  `依据 工具调用 4 次 查看审计 ›`, and a dispatched turn as `产物 1` with its
  run row. The usability gain is assumed; no owner session was measured.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-19--the-conversation-shows-the-result-and-its-grounds-the-process-moves-to-the-audit);
  [execution chain](optimizations.md#2026-11-19--a-conversation-turn-shows-its-result-and-evidence-and-the-process-moves-to-the-audit).

## 2026-11-19 — A direct answer stays in the sidebar, and today's work comes from learned folders

- **Claim:** a request the Main Agent answers without dispatching a task is now
  one 对话 row in the sidebar, and 整理今天的工作信息 can name the files that
  actually changed today under the folders the twin learned from use — without a
  folder setting, a connector, or a worker Run.
- **Evidence:** `test/companion-control-plane.test.ts` changed from expecting **0**
  conversation rows to expecting `conversation-a` and `conversation-b` (**25/25**);
  `test/known-folders.test.ts` + `test/recent-changes.test.ts` **8/8**;
  `test/ui-structure.test.ts` **21/21**; the live tool against the owner's machine
  reports **9 files** changed today under `/Users/qihoo/work` and **5
  repositories** with their status (Spotlight **0.13 s** vs a pruned `find` **5.2 s**);
  a live preview turn with `deepseek-v4.1-flash` called the tool first (**573 ms**)
  and answered with a project-by-project digest; after the desktop restart, the
  same tool answered a live turn in the real home (**454 ms**, no dispatch) and
  the sidebar showed **10 rows** with one 对话 row; the audit turn card now has a
  right-hand request and a left-hand answer, with the lost `.au-turn*` layer restored.
- **Where:** [trade-off: a request is still a row](../architecture/trade-offs.md#2026-11-19--a-request-that-dispatched-no-task-is-still-a-sidebar-row),
  [trade-off: a turn is an exchange](../architecture/trade-offs.md#2026-11-19--a-turn-is-an-exchange-the-owner-on-the-right-the-twin-on-the-left),
  [trade-off: folders are learned](../architecture/trade-offs.md#2026-11-19--folders-are-learned-from-use-not-configured-todays-changes-come-from-the-machine);
  [execution chain](optimizations.md#2026-11-19--a-new-request-stays-visible-a-turn-reads-as-an-exchange-and-todays-work-comes-from-learned-folders).

## 2026-11-19 — A video attachment's frame comes from AVFoundation

- **Claim:** a video chosen through the native picker now gets its 1280×720
  JPEG frame from `AVAssetImageGenerator` instead of the WebView media pipeline,
  dropping the frame wait from ~1.1 s to ~0.16 s cold / ~0.013 s warm. Drag/drop,
  paste and extraction failures still fall back to the HTML `<video>` path.
- **Evidence:** `benchmark/video-frame.swift` on the 8.2 MB/30 s/1080p fixture:
  **160 ms first, 13 ms warm**, 164,786-byte JPEG;
  [`benchmark/results/video-frame-2026-11-19T07-14-36Z.json`](../../benchmark/results/video-frame-2026-11-19T07-14-36Z.json).
  The WKWebView `<video>` path measured 1,065–1,277 ms for the same file, with
  all seek/metadata/`toBlob` variants at 1,112–1,222 ms and encode at 10–19 ms.
  `test/attachment-client.test.ts` **13/13** (including the native-frame case);
  the Swift shell typechecks; full suite **916/916** at the time of this run;
  typecheck and gate pass.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-19--a-video-attachments-frame-comes-from-avfoundation),
  [execution chain](optimizations.md#2026-11-19--video-frames-come-from-avfoundation-not-the-webview-media-pipeline).

## 2026-11-19 — The audit view renders without waiting for gateway usage

- **Claim:** the audit list caches Magpie usage rows for 15 s and bounds the
  optional gateway wait at 1 s; a slow or missing gateway no longer makes every
  audit open wait, and repeated opens reuse the 499 KB response instead of
  re-fetching and re-parsing it.
- **Evidence:** live `/api/audit` before the change: 2,290/404/62 ms
  (181 KB, 27 runs); the gateway usage request alone 429/57/21 ms for
  499,369 bytes. After the change the direct fetch measured **438 ms first /
  0 ms second**; the audit projection is ~60 ms, so a warm audit open is ~60 ms
  and a cold one is bounded near 1.5 s. `test/magpie-usage.test.ts` **4/4**
  (cache, expiry, hanging gateway, failure cached empty); full suite
  **916/916** at the time of this run; typecheck and gate pass. Benchmark:
  [`benchmark/results/audit-usage-2026-11-19T06-46-17Z.json`](../../benchmark/results/audit-usage-2026-11-19T06-46-17Z.json).
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-19--audit-usage-enrichment-is-cached-and-bounded),
  [execution chain](optimizations.md#2026-11-19--the-audit-view-stops-waiting-on-the-gateways-usage-history).

## 2026-11-19 — The attachment picker skips the sheet animation

- **Claim:** the native attachment picker uses the app-modal `NSOpenPanel.begin`
  instead of a window sheet, and its cold construction is warmed 1.5 s after the
  page is ready. The sheet's ~270 ms animation is gone from every picker, and
  the first click no longer pays the ~300–660 ms cold build.
- **Evidence:** `benchmark/attachment-panel.swift`, run on the M5 Pro with the
  shell's content types: first cold sheet `build=659 ms, visible=984 ms`;
  construction warm-up `112 ms`; warm sheet `build=100 ms, visible=389 ms`;
  warm `begin` `build=80 ms, visible=106 ms`. Result file:
  [`benchmark/results/attachment-panel-2026-11-19T06-21-31Z.json`](../../benchmark/results/attachment-panel-2026-11-19T06-21-31Z.json).
  `test/desktop-shell.test.ts` pins `panel.begin` and the warm function; full
  suite **906/906** at the time of this run, `npm run typecheck` and `npm run gate` pass. The packaged
  app was not instrumented for an absolute click-to-panel number, but after the
  rebuilt app was relaunched on 2026-11-19 the owner reported the attach
  interaction now feels fast ("ok了，现在很快了").
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-19--the-attachment-panel-opens-without-the-sheet-animation),
  [execution chain](optimizations.md#2026-11-19--the-attachment-panel-appears-in-110-ms-not-a-sheet-animation).

## 2026-11-19 — The native window is the only UI; the browser preview entry is gone

- **Claim:** the repository exposes one UI entry, the installed native window
  and its supervised `port: 0` loopback server. `.claude/launch.json`,
  `scripts/companion-dev.mjs` and the `companion:dev` script are gone, so a
  Claude session can no longer start a browser page that looks like the app and
  writes a second clone home. Archived eval replays still start the server
  directly on `CLONE_AI_PORT`.
- **Evidence:** `test/desktop-only-ui.test.ts` fails before the removal
  (`.claude/launch.json` present) and passes **2/2** after; `npm test`
  **884/884**; `npm run typecheck` exit 0; `npm run gate` **PASS**; after
  stopping the three preview servers no listener remains on 4317/4318/4319.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-19--the-installed-window-is-the-only-ui-the-browser-preview-entry-is-removed),
  [execution chain](optimizations.md#2026-11-19--the-browser-preview-entry-is-removed-the-native-window-is-the-only-ui).

## 2026-11-19 — An Agent 协作 row opens the task record that owns it

- **Claim:** every subagent row in the main conversation's Agent 协作 card opens
  the task record that owns it in one click; the target card is expanded, the
  matching row is scrolled into view once, and the title underlines with a
  pointer cursor on hover. A row inside its own record stays plain text.
- **Evidence:** `test/agent-collaboration-link.test.ts` **1/1** (both the
  conversation and the task record return the subagent's `runId`),
  `test/ui-structure.test.ts` (button outside the record, plain row inside,
  one-shot focus, click wiring, hover underline), full suite **876** tests /
  **875 pass** with the WhatsApp file green on a free port (a final re-run on
  the shared tree passed **885/885**),
  `npm run typecheck` and `npm run gate` pass; in the browser preview a click
  landed on the record with its card open and the row in view, and Playwright
  hover reported `underline` and `pointer`.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-19--an-agent-协作-row-opens-the-task-record-that-owns-it),
  [execution chain](optimizations.md#2026-11-19--agent-協作-rows-open-the-record-that-explains-them).

## 2026-11-19 — Workers read the whole machine; every write carries a scope

- **Claim:** a worker may read any readable location on the local computer
  except protected locations; no folder, including the workspace, is writable
  by default — every write step carries an explicit `files` write scope that
  the policy engine checks (`observe` denies, `prepare`/`act_with_approval`
  ask the owner, `act_auto` allows). A project named outside the current folder
  is read instead of answered with "outside the workspace".
- **Evidence:** `test/path-gate.test.ts` (an outside read is allowed, a write
  needs a granted root, the live workspace is not a root, the isolated copy is,
  `~/.ssh` is refused, `.git` is refused under any root),
  `test/native-worker-tools.test.ts` (an unscoped read outside the workspace,
  and a device refusal), `test/native-agent-worker.test.ts` and
  `test/mcp.test.ts` (a read path is not confined; writes still are),
  `test/companion-main-agent.test.ts` (the prompt names the machine as the
  readable surface and no default write folder), `test/write-scopes.test.ts`
  **9/9** (workspace fallback, named targets, write-cue extraction, observe/approve transition), and
  `test/golden-path.test.ts` with an `act_auto` policy; full suite **873/873**
  (852/852 without the port-conflicting WhatsApp file, 21/21 on a free port),
  `npm run typecheck` and `npm run gate` pass.
- **Where:** [read trade-off](../architecture/trade-offs.md#2026-11-19--the-machine-is-the-workspace-reads-are-not-confined),
  [write trade-off](../architecture/trade-offs.md#2026-11-19--writes-have-no-workspace-either-every-write-carries-a-scope),
  [read chain](optimizations.md#2026-11-19--the-machine-is-the-workspace-for-reads),
  [write chain](optimizations.md#2026-11-19--writes-are-scoped-per-step-not-by-workspace).

## 2026-11-19 — A Main Agent can recall another task's context on demand

- **Claim:** `search_history` searches every task conversation by default, tags
  each result with its conversation and time, can be narrowed to the current
  conversation, and records the query, scope and hits in the audit; automatic
  context stays scoped, so multiple Main Agent instances keep their isolation
  and concurrency.
- **Evidence:** `test/history-search.test.ts` **2/2**; the cross-conversation
  tool case in `test/native-main-agent.test.ts`; the provenance case in
  `test/main-agent-turn-audit.test.ts`; the UI case in
  `test/ui-structure.test.ts`; full suite **858/858**, `npm run typecheck` and
  `npm run gate` pass. Browser: a main-conversation question recovered the
  `conversation-other` turn plus one weak match, and the audit showed
  "检索 1 次 … 历史检索 海港项目 · 全部对话 → 2 条 · 对话 other、对话
  b276bc66-d13".
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-19--a-main-agent-can-retrieve-across-task-conversations),
  [execution chain](optimizations.md#2026-11-19--a-main-agent-can-retrieve-across-task-conversations).

## 2026-11-19 — A new request is routed by Clone AI, not chosen by the owner

- **Claim:** one "新请求" action replaces the new-conversation/new-task choice;
  rule cues reuse a related conversation, a new-goal cue or no context starts a
  new Main Agent, and an ambiguous request asks the model once (fail-open new);
  each task record names the dispatching Main Agent and opens its conversation;
  the audit shows the routing decision and why.
- **Evidence:** `test/conversation-router.test.ts` **8/8** (rule continue/new,
  new-goal cue, model continue/new, model-unavailable fallback, latest
  conversation, task → conversation); route API and journal cases in
  `test/companion-control-plane.test.ts`; audit routing case in
  `test/main-agent-turn-audit.test.ts`; UI case in `test/ui-structure.test.ts`;
  full suite **848/848**, `npm run typecheck` and `npm run gate` pass. Browser:
  a task record showed "派发者 对话 ce9205bc-c20… 的 Main Agent" with a button;
  "继续整理这份资料…" reused that conversation (rule); "做一个全新的项目…" created
  `conversation-b276…`; the audit showed "路由 沿用对话 …（规则判断）" and
  "新开 Main Agent …（模型不可用，按新开处理）".
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-19--one-new-request-action-clone-ai-routes-to-a-main-agent),
  [execution chain](optimizations.md#2026-11-19--one-new-request-routed-to-a-main-agent-by-clone-ai).

## 2026-11-19 — Readiness no longer waits for the first maintenance pass

- **Claim:** the companion server publishes its loopback endpoint and answers
  `/api/health` before running the first background maintenance pass. A held
  memory-extraction lock — another sidecar mid-extraction, or a miner waiting
  on a model — can no longer leave the daemon alive but invisible with the
  desktop window stuck on 正在连接. With eight pending extractions and the lock
  held, the sidecar now reaches ready in about 170 ms instead of never within
  the 15 s harness timeout; the lock-free control is 246 ms. Inside the pass,
  the opportunity scan runs before the extraction drain, so the deadline cards
  the owner sees on first paint are current while the lock is held; shutdown
  aborts every background lock wait — the maintenance pass, its governance
  operations, the in-process lock queue and a scheduled run's post-run
  extraction — so it stays graceful instead of hanging until SIGKILL.
- **Evidence:** `test/companion-startup-readiness.test.ts` — four pinned
  behaviors: readiness while the extraction lock is held, a deadline card
  visible through `/api/opportunities` while it is still held, and `close()`
  returning in under 2 s without releasing the extraction or governance lock.
  `test/workspace-lock-abort.test.ts` — four focused cases (external lock wait,
  queued waiter, pipeline extraction, conversation drain) that time out if the
  shutdown signal is dropped. The first case was red before the
  change (the 4 s readiness wait timed out at 4.04 s; the first test version
  reported `startCompanionServer did not publish readiness while the extraction
  lock was held`) and green after; the scan and shutdown
  cases were verified red against the first version of the change by the
  independent review's probes (`0` cards until release; close pending after
  2 s). Final isolated runs: **52.9 / 15.1 / 114.2 ms** for the server cases and
  **105.6 / 53.1 / 107.6 / 108.3 ms** for the focused abort cases, all green. Startup
  measurement on a copy of the live home,
  `node /tmp/clone-startup-measure.mjs /tmp/clone-home-hang-tJjQVr 15000`:
  no `CLONE_AI_READY` within 15 s before, **178 ms** / **170 ms** after.
  Full suite **858/858**, `npm run typecheck` exit 0, `npm run gate` **PASS**.
  End-to-end launch with no LaunchAgent loaded (the app spawns its bundled
  sidecar, which contains this change): `CLONE_AI_DESKTOP_READY` in **512–1158
  ms** across five clean launches; a separate browser measurement of the UI
  finished its initial API round at 282 ms (one extra launch a second after a
  quit took 4.4 s; cause not established, not reproduced).
  Live symptom: launchd PID 80762 was alive for 15 h 51 m with no listening
  socket and no endpoint file; the window showed 正在连接.
- **Where:** [trade-off: publish readiness before the first maintenance
  pass](../architecture/trade-offs.md#2026-11-19--publish-readiness-before-the-first-maintenance-pass),
  [execution chain](optimizations.md#2026-11-19--readiness-is-published-before-the-first-maintenance-pass).

## 2026-11-18 — Task records own the decision, and the audit shows the assembly

- **Claim:** the sidebar lists dispatched tasks only; a waiting task is promoted
  into "需要你的确认" with an explicit `需你确认`/`需你复核` flag; approval and review
  cards — with the step and the buttons — are decided on the task record itself;
  and every Main Agent turn in the audit shows the conversation, history window,
  prompt materials, tool table and dispatched runs.
- **Evidence:** `test/ui-structure.test.ts` **15/15**,
  `test/companion-control-plane.test.ts` **22/22**,
  `test/main-agent-turn-audit.test.ts` **13/13**,
  `test/companion-config-api.test.ts` **21/21**; full suite **831/831**,
  `npm run typecheck` and `npm run gate` pass. Browser: a paused run appeared
  only under "需要你的确认 · 1" with `需你确认`; its record showed
  "需要你确认后才能继续 / 步骤：发送" and approve/reject; a new task dispatched a
  run through a stub model, and 审计 → 主 Agent 回合 showed
  "任务组装 · 1 个 Run · 材料 ebbfb873 … charter v2 · 情境简报 · AGENTS.md ·
  工具表 11 个 … 整理本周资料 失败 起草".
- **Where:** [trade-off: task record as the unit](../architecture/trade-offs.md#2026-11-18--the-task-record-is-the-unit-no-conversation-rows-decisions-on-the-task),
  [trade-off: audit assembly](../architecture/trade-offs.md#2026-11-18--the-audit-explains-how-every-main-agent-turn-was-assembled),
  [execution chain](optimizations.md#2026-11-18--the-list-is-tasks-decisions-are-per-task-and-the-audit-shows-the-assembly).

## 2026-11-18 — A direct answer supplies evidence for a direct_response step

- **Claim:** a single-agent `direct_response` step no longer fails after the
  worker has answered. The native worker records exactly one `observation`
  evidence row for the final answer (bounded summary, `locator:
  answer:<stepId>`), gated on `produced.size === 0` so a real read is not
  duplicated; every other step keeps its evidence gate, and the Kernel does not
  synthesize evidence.
- **Evidence:** deterministic trace `53074cf2` reproduces the failure
  (`Agent direct-responder completed step direct-response without evidence.`).
  Repair-lane attempt 3: phase-1 Run `566b1603` was red on
  `test/regression/direct-response-evidence.test.ts`; fix Run `1d811b94` made
  the case green; the lane's full suite **760/760**, typecheck 0. Branch
  `rsi/auto-fix-20261118T1044`, commit `76aec5d`. Applied to the shared tree:
  the new case is red with the fix reverted and green with it; full suite
  **832/832**, `npm run typecheck` 0, `npm run gate` **PASS**. The two earlier
  lane attempts (no test written; English-only comment) are in the optimization
  log, not in this results file.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-18--a-direct-answer-is-the-evidence-for-a-direct_response-step),
  [execution chain](optimizations.md#2026-11-18--direct-answer-evidence-gap-the-repair-lane-produced-the-fix-after-three-attempts).

## 2026-11-18 — A read-only request is answered instead of failing for a missing artifact

- **Claim:** a read-only or analysis request is planned as one read-only step
  with observation evidence, not as a draft that requires a file the objective
  forbids. Research and review orders in a mixed plan also require observation.
  An unsatisfiable contract is rejected when the plan is attached, and a
  rejected plan closes its Run instead of freezing in `planning`. The worker is
  told the required contract, and evidence recording no longer hides a write
  behind an earlier read or drops it under the observation cap.
- **Evidence:** the three journal prompts (`663b45b5`, `c03c7cea`, `cd74804b`)
  reproduce `prepare/reversible_write` + `draft/local-draft` (`kind: artifact`,
  `locatorRequired: true`) before the change; the journal shows only
  `observation` rows and verification fails with `Missing required artifact
  evidence: local-draft`. After the change the same prompts return one
  `read-only-lookup` step with no artifact contract. Deterministic eval:
  `node --experimental-strip-types --test test/fallback-planner.test.ts
  test/worker-evidence-contract.test.ts` **18/18**; full suite **831/831**;
  `npm run typecheck` exit 0; `npm run gate` **PASS** (verdict/policy/audit/
  memory 100 %). Not verified live in the desktop app: no new task was
  dispatched after the change.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-18--a-read-only-request-gets-observation-evidence-not-an-artifact),
  [execution chain](optimizations.md#2026-11-18--a-read-only-request-is-answered-instead-of-failing-for-a-missing-artifact).

## 2026-11-18 — Concurrent Main Agent turns share one worker budget

- **Claim:** worker capacity is now one measured `CapacityGate` per clone home,
  shared by every assembly built over that home — the daemon, each Query
  workflow, the Main Agent's per-call kernel sessions and the repair lane — so
  two concurrent Main Agent turns dispatching at once cannot exceed one measured
  worker budget. The owner's `maxConcurrentWorkers` pin still applies and a
  refresh through any assembly reaches all of them without a restart. The
  registry is reference-counted, so temporary homes in tests do not accumulate.
- **Evidence:** `test/runtime-capacity-sharing.test.ts` — 5 deterministic
  cases (shared gate and one waiting acquire at pin 1; pin propagation across
  assemblies; the kernel session drawing from the daemon's gate; retirement
  after the last close with a double close releasing once; twelve temporary
  homes leaving nothing behind). Against `HEAD`'s per-assembly factory, cases
  1–4 fail; with the change, 5/5 pass. Full suite **798/798**, `npm run
  typecheck`, `npm run gate` pass. Not verified live: the oversubscription
  itself was never measured on two simultaneous dispatching tasks.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-18--one-measured-worker-budget-per-clone-home-not-per-assembly),
  [execution chain](optimizations.md#2026-11-18--worker-capacity-becomes-one-budget-per-clone-home).

## 2026-11-18 — A finished task no longer proposes its objective as a memory

- **Claim:** task-run memory mining proposes nothing without a configured
  miner, and any miner's untyped or `procedure` candidate that only restates
  its task objective is dropped before the owner's review list; a typed
  preference/fact/decision/commitment equal to the objective stays for review.
  A one-time governance pass rejected the pending legacy copies in the live
  home, leaving zero; the review list, attention list and dashboard no longer
  present decided copies as current.
- **Evidence:** live journal `~/.clone/journal.sqlite3`: 8 requested / 8
  extracted (all `count: 1`) / 8 proposed, every summary `候选流程：` plus the
  exact task objective; 2 owner-rejected and 6 rejected by the cleanup, **0
  pending**. `test/memory-candidate-quality.test.ts` **8/8** (default zero,
  gate drops/keeps, a typed preference equal to the objective kept, `=all`
  selects the real miner, cleanup once); `test/golden-path.test.ts` **2/2**;
  `test/runtime.test.ts` **5/5**; `npm run gate` **13/14/4 + memory 26/26** at
  100 % agreement with the baseline regenerated; `npm run typecheck` exit 0.
  Full `npm test`: **831/831**.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-18--a-finished-task-is-not-a-memory-candidates-must-state-durable-knowledge),
  [execution chain](optimizations.md#2026-11-18--a-finished-tasks-objective-stops-becoming-a-memory-candidate).

## 2026-11-18 — The main pane reads as a dispatch log

- **Claim:** a conversation's main pane renders one log entry per Main Agent
  turn — the query, the context it assembled (provider/model/effort, prompt
  material and tool table, history window, compactions), the work it dispatched
  (tool calls and spawned runs), and the result — instead of chat bubbles; the
  task-record view and decision cards are unchanged.
- **Evidence:** `test/main-agent-turn-audit.test.ts` (projection and search),
  `test/ui-structure.test.ts` (log vs. messages, live echo, hidden and failed
  runs), `test/companion-control-plane.test.ts` (session view turns, bounded log,
  hidden spawned run) and `test/prompt-snapshot.test.ts` pass — **58/58**;
  full suite **834/834**, `npm run typecheck`, `npm run gate` pass. Browser on
  an isolated preview home: two turns rendered as log entries with
  `native/verify-model`, `charter v2`, `工具 11 个`, `此前 1 轮已完成对话` and
  the reply, with zero chat bubbles.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-18--the-main-pane-is-a-dispatch-log-not-a-chat-transcript),
  [execution chain](optimizations.md#2026-11-18--a-conversations-main-pane-becomes-a-dispatch-log).

## 2026-11-18 — A read-only request runs once, in the right workspace

- **Claim:** an explicit read-only request (or a research request with no
  deliverable) becomes one read-only step executed by `context-researcher`, with
  no draft work order and no required artifact; a `dispatch_task` run executes
  in the turn's workspace, not the daemon's checkout; `execution.started`
  records that workspace.
- **Evidence:** `test/fallback-planner.test.ts` **10/10** (read-only request and
  read-only code review are one step; a named output target still gets a draft;
  a no-write phrase containing 写 does not become delivery);
  `test/main-agent.test.ts` **37/37** (including the tool-runtime workspace
  case); `test/native-main-agent.test.ts` and `test/dispatch-task.test.ts` pass.
  Before: runs `c03c7cea`/`cd74804b` failed with "Missing required artifact
  evidence: local-draft"; run `b1e04b18` ran in `/Users/qihoo/study/clone-ai` and
  reported the knowledge-base README as outside the workspace. After: the live
  check on `/Users/qihoo/work/knowledge_base` (native /
  `360/openai/gpt-6.1-terra`) produced **one** run (`99504e85`) with a single
  `read-only-lookup` step (`delegated: false`, `risk: read_only`), which read the
  absolute README, recorded the observation, wrote the three-sentence answer as
  `execution.completed`, and reached `waiting_review`. Full `npm test`
  **829/829**; `npm run typecheck` and `npm run gate` pass.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-18--a-read-only-request-is-a-step-and-tools-use-the-turns-workspace),
  [execution chain](optimizations.md#2026-11-18--a-read-only-request-is-one-step-and-its-run-uses-the-turns-workspace).

## 2026-11-18 — A review shows the worker's answer, and the prompt knows the workspace

- **Claim:** the Main Agent's prompt now loads project instructions from the
  workspace configured in Settings and names that workspace; both the planner
  and the worker are told that a project outside it must be reported instead of
  reviewed from the workspace's files. A single-agent step's final answer is
  journaled and shown in the task record and in a review card docked at the top
  of the pane. Worker file tools resolve a path with `resolve`, like the gate,
  so an absolute path inside the workspace (or a granted read root) reaches the
  file the gate approved. Saving a different workspace says it needs an app
  restart.
- **Evidence:** `test/companion-main-agent.test.ts` **6/6** (the new case
  captures the configured workspace's `AGENTS.md` marker and
  `Current workspace: …`, and not the checkout's rules);
  `test/run-query-routing.test.ts` **11/11** (the new case finds an
  `execution.completed` whose summary is the worker's answer);
  `test/main-conversation-approvals.test.ts` **5/5**;
  `test/companion-config-api.test.ts` **19/19** (the restart notice is true for a
  different path and absent for the running one); `test/ui-structure.test.ts` **14/14**; `test/native-agent-worker.test.ts`
  **15/15**; `test/native-worker-tools.test.ts` **6/6** (an absolute path inside
  the workspace and a granted read root outside it); `npm run typecheck` exit 0;
  `npm run gate` PASS with the baseline unchanged. Before-data from the live
  journal: run `062716a9` had no completion event, and prompt snapshot
  `a063d154…` read the clone-ai checkout's `AGENTS.md`. Live check with native /
  `360/openai/gpt-6.1-terra` on a fresh temp workspace: the original request
  asked for the path or a workspace switch and dispatched nothing
  (`newRuns: []`); without the "no filesystem tool" line it still dispatched one
  run that failed, so that line is load-bearing. Real-app verification: run
  `b1e04b18` failed because `join` doubled the absolute path; after the
  `resolve` fix, run `496d2061` read the knowledge-base `README.md`
  (`isError: false`), recorded a three-sentence `execution.completed`, reached
  `waiting_review`, and the task record shows that answer above the acceptance
  line. Full `npm test` **829/829** after the shared checkout's concurrent changes
  settled (an earlier run hit an unrelated `EADDRINUSE` on port 4318 held by
  another session's dev server; it passed once that server stopped).
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-18--the-main-agent-knows-its-workspace-and-a-review-carries-the-answer),
  [execution chain](optimizations.md#2026-11-18--the-main-agent-reads-its-workspace-and-a-review-carries-the-answer).

## 2026-11-18 — A path mentioned only in prose no longer fails a worker step

- **Claim:** the native worker fails a step for a missing required input only when the work order declares that input with `required: true`; a path that merely appears in the objective, instructions or acceptance criteria is context, and a path that is later read or written no longer counts as missing. Declared required inputs that are still missing still fail.
- **Evidence:** the repair lane's report: `status: fixed`, branch `rsi/auto-fix-20261118T0913`, commit `fb496e5b`, eval before red, regression after green (4 files), full suite **759/759** and typecheck **0** in the worktree (`/tmp/clone-repair-automation/rsi/last-run.json`). Independent check: `test/regression/native-missing-input.test.js` fails with an assertion on an unpatched worktree at `07f8bb5` and passes on the branch. The branch was fast-forwarded into `main`.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-18--a-path-mentioned-in-instructions-is-not-a-required-input),
  [execution chain](optimizations.md#2026-11-18--a-path-in-prose-is-not-a-required-input-repair-lane-repaired).

## 2026-11-18 — Tasks run as separate Main Agents, bounded by the machine

- **Claim:** each task is its own Main Agent conversation with its own history;
  a task executing subtasks no longer blocks another task; concurrent Main
  Agent turns are bounded by a cross-process pool sampled from CPU and load,
  with `maxConcurrentMainAgents` as the owner's pin; the desktop can start a
  second task while the first still streams.
- **Evidence:** feature tests **21/21** (`test/main-agent-capacity.test.ts`
  3/3, `test/main-agent-slots.test.ts` 5/5, a real two-process slot test 1/1,
  `test/prompt-lock.test.ts` 4/4, `test/native-main-agent.test.ts` 7/7 with
  conversation isolation, `test/run-triggers.test.ts` 1/1);
  `test/companion-control-plane.test.ts` **22/22** (separate histories, the main
  conversation does not absorb a task, same-titled failed conversations stay
  separate, a hidden conversation rejects a send, a bare run id is refused);
  `test/companion-config-api.test.ts` **20/20** (the pin can be set and cleared);
  full suite **791/791**, `npm run typecheck` and `npm run gate` pass. Browser on
  a fresh companion with a local SSE stub: two tasks started 350 ms apart both
  completed as separate conversations, the second stayed selected when the
  first finished, each view held only its own turn, and the main conversation
  held neither.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-18--each-task-runs-its-own-main-agent-sized-by-the-machine),
  [execution chain](optimizations.md#2026-11-18--each-task-gets-its-own-main-agent-sized-by-the-machine).

## 2026-11-18 — A verification record reads as a decision, not a repeated list

- **Claim:** the review card now shows the owner's decision as its verdict, the
  criteria as short numbered rows with the repeated step title demoted to a
  muted line, and a summary that counts them instead of pasting them again; new
  records store the criteria once.
- **Evidence:** `test/ui-structure.test.ts` **12/12**,
  `test/verification.test.ts` **16/16**; browser check rendered 4 numbered rows
  with a `已接受结果` pill and `检查了 11 条证据`; full suite **759/759**,
  typecheck and gate pass. Run `18569eb4`'s stored summary is rewritten by the
  UI because its event is history.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-18--a-verification-record-states-a-count-not-a-repeated-list),
  [execution chain](optimizations.md#2026-11-18--the-verification-record-stops-repeating-itself).

## 2026-11-18 — A finished task record keeps its verification, evidence and artifacts

- **Claim:** the task record of a reviewed run keeps the system verdict, the
  owner's decision, the unverified criteria and the checked-evidence count after
  the decision; it lists the artifacts before the observations instead of only
  counting them; and the trace opens while a decision is pending.
- **Evidence:** `node --experimental-strip-types --test test/ui-structure.test.ts`
  — 12/12, including a rendered-markup check (a fake session through
  `verificationMarkup`/`evidenceMarkup`/`traceMarkup`); `npm test` 759/759,
  `npm run typecheck` and `npm run gate` pass. In an isolated copy of the owner's
  journal, run `91b685cf` showed 核验结果/需要你的复核, nine evidence rows and an
  open 43-row trace; run `4ce0db3d` showed 通过/你的决定：接受结果, three artifact
  rows ahead of 23 observations, and an open 214-row trace.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-18--a-finished-run-keeps-its-verification-evidence-and-trace-on-screen),
  [execution chain](optimizations.md#2026-11-18--a-finished-run-keeps-its-verification-evidence-and-trace).

## 2026-11-18 — Approvals are confirmed from the main conversation

- **Claim:** every waiting approval and review can be decided from the Main
  Agent conversation, each card posting to the run id it belongs to — including
  when both kinds are pending at once; a child task record points there instead
  of offering a second set of buttons, and derived tasks sit in a collapsible
  group under the conversation that spawned them.
- **Evidence:** `node --experimental-strip-types --test test/ui-structure.test.ts
  test/main-conversation-approvals.test.ts` — **14/14**, where HEAD fails the UI
  contract on `session.id !== MAIN_CONVERSATION_ID`;
  `test/main-conversation-approvals.test.ts` **3/3**; full suite **758/758**,
  typecheck and gate pass.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-18--approvals-live-in-the-main-conversation-child-tasks-collapse-under-it),
  [execution chain](optimizations.md#2026-11-18--approvals-move-to-the-main-conversation).

## 2026-11-18 — A finished task record keeps its verdict and evidence

- **Claim:** after the owner accepts or rejects a result, the task record still
  shows the system verdict, the owner's decision, the unverified criteria, the
  evidence rows the run produced (artifacts first), and a trace that opens while
  a decision is pending.
- **Evidence:** the new UI contract test fails at HEAD (**9/11**) and passes with
  the change (**11/11**); full suite **758/758**, typecheck and gate pass.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-18--a-finished-run-keeps-its-verification-evidence-and-trace-on-screen),
  [execution chain](optimizations.md#2026-11-18--a-finished-run-keeps-its-verification-evidence-and-trace).

## 2026-11-18 — UI edits reach the running window without a daemon restart

- **Claim:** the resident daemon, which serves a checkout, now re-reads each
  client asset per request, so a UI edit lands on the next reload instead of
  stranding the window on the script it read at startup; a source that calls a
  function it never defines now fails the UI suite.
- **Evidence:** appending a line to `app.js` changed the served length on the
  next request (152,768 → 152,778 bytes) with no restart, where the stale
  snapshot had served 150,805; `test/ui-structure.test.ts` **10/10**; full suite
  **757/757**, typecheck and gate pass.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-18--a-checkout-served-daemon-re-reads-its-client-files-per-request),
  [execution chain](optimizations.md#2026-11-18--a-checkout-served-daemon-serves-the-file-not-its-startup-copy).

## 2026-11-18 — A step ends when the model says it is done, not at a round number

- **Claim:** the shared agent loop has no default model-round cap. It continues
  until the model returns an answer, the turn is aborted, or a duration,
  tool-call or token budget stops it; an explicit plan budget or
  `CLONE_AI_NATIVE_MAX_ROUNDS` still bounds a step when set, and the planners no
  longer write `maxModelCalls`.
- **Evidence:** `node --experimental-strip-types --test test/agent-loop.test.ts
  test/native-agent-worker.test.ts test/companion-main-agent.test.ts` — a scripted
  model that requests tools for 13 rounds and then answers completes, while an
  explicit `maxRounds: 2` still ends in `max_turns`;
  `effectiveRoundLimit(undefined, undefined)` is `undefined`. `npm test`
  756/756, `npm run typecheck` and `npm run gate` pass.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-18--a-worker-stops-when-the-model-stops-no-default-round-cap),
  [execution chain](optimizations.md#2026-11-18--a-worker-stops-when-the-model-stops-the-default-round-cap-is-gone).

## 2026-11-18 — The owner's message bubble renders Markdown

- **Claim:** owner messages now render headings, lists, inline/fenced code and
  bold through the same escaping renderer as the agent's replies, so a pasted
  task brief is no longer literal markdown.
- **Evidence:** `node --experimental-strip-types --test test/ui-structure.test.ts`
  — **8/8**. Browser check on the isolated companion dev server: the injected
  owner message produced 1 heading (computed weight 720), 2 bullets, 1 bold,
  2 inline code spans and 1 code block; a `<script>` in the text produced no
  script node and `window.__pwned` stayed false. Full suite **751/751**,
  typecheck and gate pass.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-18--the-owners-message-renders-through-the-markdown-path),
  [execution chain](optimizations.md#2026-11-18--the-owners-message-renders-markdown).

## 2026-11-18 — Automation stopped competing with the owner's runtime

- **Claim:** the repair lane, nightly RSI and the eval companion resolve an
  isolated clone home (`.automation/<purpose>` or `CLONE_AI_AUTOMATION_HOME`),
  seed only config files, and refuse the owner's live home; failed traces stay
  readable while reports, state and locks no longer land in `~/.clone`.
- **Evidence:** `test/automation-home.test.ts` **5/5**;
  `npm run repair -- --dry-run --max-traces 2` prints the isolated home and
  plans **2 traces** read from `~/.clone/failed-traces`;
  `node scripts/nightly-rsi.mjs --dry-run --max-traces 2` plans from the same
  traces with `.automation/nightly` state; `companion-dev` falls back to
  `.automation/preview` and refuses `~/.clone`. Full suite **750/750**, typecheck
  and gate pass.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-18--maintenance-automation-runs-in-its-own-clone-home),
  [execution chain](optimizations.md#2026-11-18--automation-runs-in-its-own-clone-home).

## 2026-11-18 — One Agent invocation can be deleted from its row

- **Claim:** each Agent-invocation row carries its own delete/restore action beside the selectable record, so deleting one record no longer requires opening the detail and scrolling past the prompt; the bulk action remains for the filtered list, and both are soft deletes.
- **Evidence:** `node --experimental-strip-types --test test/ui-structure.test.ts` — **7/7**. In the browser against an isolated audit home with three seeded records, every row showed 删除; deleting one left two rows with a tombstone and "已隐藏 1 条…"; 含已删除 then showed the row with 恢复, and restoring it returned the third record with "已恢复 1 条…". No console errors.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-18--the-invocation-list-exposes-a-per-row-delete-control),
  [execution chain](optimizations.md#2026-11-18--a-per-row-delete-entry-in-the-agent-invocation-list).

## 2026-11-18 — A Finder-launched app attaches to the resident daemon

- **Claim:** when the LaunchAgent `ai.clone.companion` is loaded, a packaged app
  launched from Finder attaches to its endpoint instead of spawning a second
  runtime on the same journal; without the job it still runs standalone.
- **Evidence:** `node --experimental-strip-types --test test/desktop-shell.test.ts`
  — **1/1**. Manual: with the job loaded, the pre-change build spawned child
  76242 and rewrote the endpoint; the changed build (app 81494) has no child,
  the endpoint still names daemon pid 78156, `GET /api/health` → HTTP 200. Full
  suite **744/744**, typecheck and gate pass.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-18--a-packaged-launch-attaches-when-the-launchagent-is-loaded),
  [execution chain](optimizations.md#2026-11-18--a-finder-launched-app-attaches-to-the-loaded-daemon).

## 2026-11-18 — The Forbidden City benchmark passes end to end in the App

- **Claim:** run `18569eb4`, submitted through the App's own daemon with a
  one-paragraph task, now grades **28/28** with zero hard failures: ten named
  halls with their roof types and a 961 m axis, the shared 三台, 太和殿 at
  64×37×35 m, detailed roofs/brackets/lattices/studs, shadows, orbit 63°,
  zoom ×0.58, a hero framing at 34.5% of the frame height, and mirrored
  体仁阁/弘义阁.
- **Evidence:** `node benchmark/capability/forbidden-city/verify/check-forbidden-city.mjs
  --workspace "/Users/qihoo/Documents/Clone AI" --out …/verify/app-final2
  --interactive` → **28/28**, screenshots in `screens/`, report in
  `report.json`. Runs along the way: `91a50a87` cut off at 12 rounds (fixed),
  `9d706a27` wrong workspace (fixed), `4ce0db3d` correct data but a 9% hero
  framing (now graded), `18569eb4` 27/28 with the pavilions under
  `props.sideHalls` (lookup fixed).
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-18--the-default-view-is-graded-on-composition-not-only-on-data),
  [execution chain](optimizations.md#2026-11-18--the-load-time-view-is-graded-on-composition).

## 2026-11-18 — A complete model is no longer allowed to look like a floor plan

- **Claim:** the interactive checker grades the load-time composition: 太和殿
  must cover at least 25% of the frame height and sit inside the frame,
  measured by projecting its corners through the camera the page reports. Run
  `4ce0db3d` passed 26/27 on data and interaction yet covered 9.0%; the new
  check fails that view deterministically.
- **Evidence:** same workspace, before/after the check: `26/27` → `hero covers
  9.0% of frame height, inside=true`, 26/28 with two hard failures. No model
  call is spent on grading.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-18--the-default-view-is-graded-on-composition-not-only-on-data),
  [execution chain](optimizations.md#2026-11-18--the-load-time-view-is-graded-on-composition).

## 2026-11-18 — A one-shot build-and-verify step is no longer cut off at 12 rounds

- **Claim:** the native worker's default model-call budget is now 40, so a step
  that writes a page, renders it, looks at the screenshots through the browser
  tools, and repairs what it sees can finish in one query. Plan budgets and
  `CLONE_AI_NATIVE_MAX_ROUNDS` still take precedence.
- **Evidence:** App run `91a50a87` wrote `index.html`, `src/main.js`,
  `README.md` and five screenshots, then failed with `The agent reached its
  12-round limit without a final answer` (12 model calls, 14 tool calls,
  102,872 tokens, 112.2 s). With the interactive checker fixed to stop grading
  video-only fields, the same workspace grades **26/27** (orbit 63°, zoom ×0.55,
  median 33.3 ms/frame), the only miss being side pavilions the eval prompt
  never asked for.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-18--the-native-workers-default-round-budget-is-40-not-12),
  [checker trade-off](../architecture/trade-offs.md#2026-11-18--interactive-grading-stops-asking-for-video-only-fields),
  [execution chain](optimizations.md#2026-11-18--a-build-and-verify-step-gets-40-rounds-and-interactive-grading-drops-video-only-checks).

## 2026-11-18 — OCR and legacy .doc reach the model without leaving the machine

- **Claim:** a scanned PDF falls back to Vision OCR and a legacy `.doc` is read
  with AppKit through a Swift helper compiled into the app; both reach the model
  as a delimited text block under the existing 50,000/100,000 character caps.
  The helper reads stdin and writes stdout, so Node never writes a temp file.
- **Evidence:** `node --experimental-strip-types --test test/attachments.test.ts
  test/document-extract.test.ts test/native-main-agent.test.ts
  test/desktop-shell.test.ts` — 31/31; `npm test` 742/742; typecheck pass; gate
  PASS. The compiled helper read a `textutil`-generated `.doc` and OCR'd a
  rendered scanned PDF into `Hello from a PDF fixture.` /
  `Second line with Tom & Jerry.`; the bundled Node resolved the sibling helper
  and extracted both fixtures. A 45-line dense fixture produced 33 rows starting
  with `Line` from a 53-row output, so OCR is usable but not perfect.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-18--ocr-and-legacy-doc-go-through-a-native-macos-helper),
  [execution chain](optimizations.md#2026-11-18--scanned-pdfs-and-legacy-doc-reach-the-model-too).

## 2026-11-18 — The window recovers a stopped runtime on its own

- **Claim:** a packaged app whose spawned runtime stops no longer ends at a
  static "close and reopen" screen: the shell relaunches it with exponential
  backoff (measured 1, 2, 4, 8 and 16 s), shows the last stderr lines, and both
  modes probe `/api/health` every 5 seconds so a hung runtime is restarted
  (non-resident) or re-attached (resident).
- **Evidence:** `node --experimental-strip-types --test test/desktop-shell.test.ts`
  — **1/1** with the new assertions; the HEAD shell has no
  `scheduleRuntimeRestart` or `/api/health` caller and still prints the terminal
  copy. Manual eval of `dist/Clone AI-2026-11-18T06-53-44-937Z.app` with
  `CLONE_HOME` at a regular file: five relaunches at 14:55:22.777 / 24.004 /
  26.241 / 30.443 / 38.632, gaps 1.2 / 2.2 / 4.2 / 8.2 / 16.2 s;
  `GET /api/health` on a running runtime returns HTTP 200. Full suite
  **742/742**, typecheck and gate pass.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-18--the-window-supervises-its-runtime-retry-probe-and-say-why),
  [execution chain](optimizations.md#2026-11-18--the-window-retries-its-runtime-and-shows-why-it-stopped).

## 2026-11-18 — A raced journal event no longer keeps the app from starting

- **Claim:** the companion rebuilds its projection from a shared journal even when one process recorded an illegal `failed -> verifying` transition; the desktop sidecar starts and serves again, while live writers are still refused by `changeStatus`.
- **Evidence:** `node --experimental-strip-types --test test/run-state.test.ts test/runtime.test.ts test/run-queue.test.ts test/recovery-concurrency.test.ts` — **19/19**, `npm run typecheck` pass. The sidecar that had crashed in `hydrate()` now prints `CLONE_AI_READY`; `GET /api/dashboard` with the bearer token returns **HTTP 200, 8 sessions**; the 2-second `failed -> verifying` queue error loop stops.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-18--a-journal-replay-reflects-what-was-recorded-writers-validate),
  [execution chain](optimizations.md#2026-11-18--a-projection-rebuild-survives-a-raced-status-transition).

## 2026-11-18 — An isolated step sees the owner's untracked inputs

- **Claim:** an external step that runs in a git worktree now carries the
  owner's untracked, non-ignored files, so a seeded `vendor/three.module.js` is
  readable inside `~/.clone/isolated-workspaces/...` instead of aborting with
  "Required input missing". Tracked files still come from HEAD; ignored output
  and symlinks stay out.
- **Evidence:** `node --experimental-strip-types --test test/isolated-workspace.test.ts`
  — 8/8; the worktree case reads `note.md` and `vendor/three.module.js` from the
  sandbox, reads HEAD's `tracked.md`, and refuses `debug.log`. `npm test`
  740/740, `npm run typecheck` passes, `npm run gate` **PASS**.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-18--untracked-workspace-files-are-copied-into-the-isolated-worktree),
  [execution chain](optimizations.md#2026-11-18--an-isolated-worktree-carries-the-owners-untracked-inputs).

## 2026-11-18 — The archived memory set is a control, and it can be pruned

- **Claim:** the memory panel's 已归档 count now filters the list to the archived set with one click, and an archived memory can be permanently deleted — both possible `.md` paths, its index row, terms, weights, versions and staged mutations — with the decision journaled as `memory.deleted` (summary included) before the files go. An active memory must be archived first, so the only irreversible memory action stays one deliberate step from the default view.
- **Evidence:** `node --experimental-strip-types --test test/md-memory-store.test.ts test/memory-governance.test.ts test/memory-library-api.test.ts test/regression/memory-refresh-focus.test.ts` — **48/48**. The API case proves archived→200, active→409, unknown→404, a second DELETE→404, the `.md` gone, and zero remaining rows; the store case proves `syncFromFiles()` does not resurrect a deleted memory. `npm test` **734/734**, `npm run typecheck` pass, `npm run gate` **PASS** (13 cases, agreement 100%, baseline unchanged). In an isolated `CLONE_AI_HOME=/tmp/clone-ai-preview-home`, the browser flow create → archive → click 已归档 → delete ended with no `.md` files, `stats 0/0`, one `memory.deleted` event, the archived card switched `aria-pressed`, and the archived row showed 删除.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-18--archived-memories-can-be-permanently-deleted-and-archiving-comes-first),
  [execution chain](optimizations.md#2026-11-18--archived-memories-are-one-click-away-and-can-be-deleted-for-good).

## 2026-11-18 — A PDF or .docx becomes text inside the turn

- **Claim:** PDF and `.docx` attachments are extracted in-process and reach the
  model as a delimited text block in that turn, under the same 50,000/100,000
  character caps as text documents. Scanned PDFs and legacy `.doc` are refused
  with reasons; a longer document is truncated with a marker and a completion
  notice. Nothing is written to disk, and the ledger keeps only names/sizes.
- **Evidence:** `node --experimental-strip-types --test test/attachments.test.ts
  test/document-extract.test.ts test/native-main-agent.test.ts
  test/desktop-shell.test.ts` — 28/28. Fixtures `sample.pdf.b64`,
  `sample.docx.b64`, `scanned.pdf.b64`: text PDF and `.docx` extract the
  expected sentences (entities decoded); the image-only PDF is refused with OCR
  guidance; a 20-character budget produces the truncation marker and report; a
  broken `.docx` is refused. The focused run is 28/28; typecheck and
  `npm run gate` PASS. The full suite passed 727/727 before a concurrent
  `companion:dev` claimed port 4318; a later run was 731/733, the two failures
  being unrelated WhatsApp-bridge `EADDRINUSE` errors on that port. The built
  bundle's own Node extracted both fixtures from `dist/…/runtime` (unpdf at
  4.1 MB), and the rebuilt app's composer showed two document chips and sent two
  `{kind:"document", data}` entries.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-18--pdf-and-docx-are-extracted-before-the-turn-not-handed-to-the-model),
  [execution chain](optimizations.md#2026-11-18--pdf-and-docx-become-text-before-the-model-sees-them).

## 2026-11-18 — The invocation audit can be searched and cleared without losing evidence

- **Claim:** the **Agent 调用** tab searches the whole shared invocation ledger
  server-side, shows `显示 N / 共 M 条`, and can hide records — individually or
  the loaded filtered list — with a reversible tombstone; **含已删除** brings
  them back. The **主 Agent 回合** tab gains a server-side search box too.
- **Evidence:** `node --experimental-strip-types --test
  test/invocation-ledger.test.ts test/companion-control-plane.test.ts` — 10/10 and
  15/15; before implementation the ledger test failed at import
  (`does not provide an export named 'markInvocations'`). The final full run is
  735/735. One run while the preview server held port 4318 was 734/735, the only
  failure being the unrelated WhatsApp-bridge `EADDRINUSE`; after the port was
  released the suite passed completely. `npm run typecheck` passes and
  `npm run gate` PASS with an unchanged baseline.
  In the Browser pane against the real ledger, `只回复 ok` narrowed 23 records
  to 3 with focus restored; deleting one left 2; **含已删除** showed it with a
  已删除 badge; restore returned 3 with none deleted. The ledger file held
  `started`, `completed`, `deleted`, `restored` for that id with the prompt
  intact. Turns search `故宫` returned 3 of 8 from the server. A 520-record
  seeded ledger proved the oldest record still opens by id while the list page
  stops at 500; padded ids are trimmed and a 500-character id is refused (400).
  A hide → restore round trip in the browser showed `另有 1 条已隐藏`, then
  returned 23/23 with no deleted rows.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-18--deleting-an-audit-invocation-is-a-tombstone-not-an-erased-ledger-line),
  [execution chain](optimizations.md#2026-11-18--agent-invocation-audit-can-be-searched-and-soft-deleted).

## 2026-11-18 — A text document rides in the turn, not in the ledger

- **Claim:** the composer accepts text documents from the picker or a window-wide
  drop; the model receives them as a delimited data block in that turn, while the
  turn ledger and history keep only a name/size manifest. Limits are 4
  attachments, 50,000 characters per document and 100,000 across documents; PDF
  and binary files are refused with a reason.
- **Evidence:** `node --experimental-strip-types --test test/attachments.test.ts
  test/native-main-agent.test.ts` — 18/18. The native case captures the provider
  request and asserts the document body appears inside
  `<document name="notes.md" media-type="text/markdown">`, while
  `readMainAgentTurnRecords` contains only
  `[attached documents: notes.md (11 characters)]`. `npm test` 715/715,
  `npm run typecheck` pass, `npm run gate` PASS with an unchanged baseline. On
  the rebuilt app's loopback server, a picked `notes.md` and a dropped `todo.txt`
  plus PNG produced two document chips and one image chip; the intercepted stream
  body carried both text bodies (`kind:"document"`) next to the image's base64,
  and the composer cleared. No console errors; no model call was made.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-18--text-documents-attach-inline-pdfs-and-cross-turn-document-text-wait),
  [execution chain](optimizations.md#2026-11-18--text-documents-ride-in-the-turn-instead-of-the-workspace).

## 2026-11-17 — Detail is now a measured requirement, and the render finally shows it

- **Claim:** the Forbidden City benchmark grades architectural detail by counted
  pieces and a declared shadow state, instead of passing any render that
  satisfies a data contract; a model that had passed 24/24 on data now fails
  three detail checks and one shadow check.
- **Evidence:** attempt E under the detail contract: **24/28** —
  `model.roof-detail`, `model.dougong`, `model.facade-detail` fail (no counts
  reported) and `browser.shadows` fails (no `castShadow`/`shadowMap` in source;
  center-crop diagnostic 83.2% near-flat pixels, 221,850 triangles). Attempt F
  under the same contract: **27/28** — 6 halls report ≥3 roof segments and ≥24
  tile ridges, ≥40 brackets, ≥32 mullions and ≥36 studs; source enables
  `shadowMap.enabled` and a casting sun; center-crop flat pixels fall to
  **72.7%**; t=0 and t=22.5 screenshots show tile ridges and a cast shadow.
  Supervisor render 30.00 s 1920×1080 H.264 (7.8 MB). Evidence:
  `eval-runs/2026-11-17-forbidden-city/verify/{e-detail,f}/report.json`,
  `…/verify/f/video.mp4`.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-17--detail-is-graded-by-counts-and-shadows-not-by-prose),
  [execution chain](optimizations.md#2026-11-17--detail-becomes-a-graded-contract-in-the-forbidden-city-benchmark).

## 2026-11-17 — An honest delivery is no longer failed for being honest

- **Claim:** the file verifier no longer reads `不要声称 out/video.mp4 已生成` as a
  promise, and a plan that names `tests/` as a deliverable (or says the tests
  were not run) no longer triggers the test-evidence gate — while a step that
  really asks for a test run still requires test evidence.
- **Evidence:** before, `extractFileExpectations(attemptCStep)` returned
  `[{ path: "out/video.mp4" }]` and `mentionsTests(...)` returned `true`; after,
  `[]` and `false`, with `npm test passes`, `修复后运行测试` and
  ``Run `node --test tests/` `` still `true`.
  `test/verification.test.ts` 16/16; full suite 688/688; typecheck and
  `npm run gate` pass, with the two new gate cases recorded in the baseline.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-17--the-verifier-reads-negation-and-naming-tests-no-longer-demands-a-test-run),
  [execution chain](optimizations.md#2026-11-17--the-verifier-stops-punishing-honest-disclosure).

## 2026-11-17 — A 3D task that can fail on the world, not just on itself

- **Claim:** Forbidden City modeling is now graded against an external
  architectural contract — ten named halls with their correct roof forms, the
  shared 三台, a measured axis, and the published 太和殿 dimensions — read from
  `window.getForbiddenCityModel()` by a supervisor checker, with harness and
  modeling reported separately.
- **Evidence:** attempt C (steered prompt) produced 20 files; `node --test`
  6/6; checker **21/21 hard checks** including 10/10 roof forms, 10/10 axis
  buildings within ±1 m, `platformId: three-halls`, 64×37×35 m 太和殿, 0 m
  symmetry error; supervisor-rendered 900 frames → 30.00 s 1920×1080 H.264;
  33.3 ms/frame median. Calibration on the older 01 city artifact: 11/14, with
  the missing model contract and wrong import map the only hard failures.
  Evidence: `eval-runs/2026-11-17-forbidden-city/verify/c/report.json`,
  `…/render/video.mp4`; analysis
  [`ANALYSIS.md`](../../benchmark/capability/forbidden-city/ANALYSIS.md).
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-17--the-forbidden-city-benchmark-grades-an-external-contract-and-keeps-harness-and-modeling-apart),
  [execution chain](optimizations.md#2026-11-17--the-forbidden-city-3d-benchmark).

## 2026-11-13 — The Main Agent reads the repository's own rules

- **Claim:** clone-main now loads the workspace's `AGENTS.md` / `CLAUDE.md`,
  nested Claude files and `.claude/rules/*.md` into its system prompt, labeled as
  project instructions; imports cannot leave the workspace, and the layer is
  capped and switchable.
- **Evidence:** `test/project-instructions.test.ts` 7/7 (order, nested paths,
  in-workspace import expanded, outside import and symlink escape refused, cycle
  terminates, budget truncation stated, switch off). End-to-end on this
  repository: a live Main Agent turn's prompt material records
  `[{ path: "AGENTS.md", bytes: 11576 }]` and the compiled system prompt
  contains `npm run gate`; before the change, `grep -rn 'AGENTS.md' src/`
  returned nothing. Full suite 677/677; typecheck and `npm run gate` pass.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-13--the-main-agent-reads-project-instruction-files-labeled-by-trust-class),
  [execution chain](optimizations.md#2026-11-13--the-four-gaps-the-memory-comparison-found).

## 2026-11-13 — A memory edit can be undone

- **Claim:** every owner-visible change to a memory records the state before it,
  and an undo restores that state as an auditable `memory.updated` reversal; a
  second undo walks one change further back.
- **Evidence:** `test/memory-versions.test.ts` 5/5 (edit undone back to the
  original summary and content, undo event carries `source: "undo"` and the
  restored version id, second undo returns the prior state, archive undone to
  `active`, no-op refused, history capped at 20). Full suite 677/677; typecheck
  and `npm run gate` pass.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-13--memory-edits-are-versioned-and-an-undo-restores-the-previous-version),
  [execution chain](optimizations.md#2026-11-13--the-four-gaps-the-memory-comparison-found).

## 2026-11-13 — Consolidation proposes merges from a signal that finally has a caller

- **Claim:** the idle improvement sweep proposes merge suggestions for
  same-type memories at or above the measured overlap threshold, and approving
  one authors the merged memory and archives the sources as `retired`, so the
  merge is reversible.
- **Evidence:** `test/memory-consolidation.test.ts` 5/5 (reworded pair
  proposed with the newer statement kept, unrelated and cross-type ignored, an
  explicit revision excluded, secret excluded, approval leaves one active memory
  and two archived with reason `retired`). `findConflicts` had no production
  caller before this. Full suite 677/677; typecheck and `npm run gate` pass.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-13--background-consolidation-proposes-merges-the-owner-still-decides),
  [execution chain](optimizations.md#2026-11-13--the-four-gaps-the-memory-comparison-found).

## 2026-11-11 — The repair lane produced a verified fix

- **Claim:** clone-ai's own repair lane produced the fix for token-aware
  compaction being unreachable, and the working agent verified it functionally
  rather than by rewriting it.
- **Evidence:** patch changes `src/main-agent/native-runtime.ts` so compaction is
  always enabled with a 128,000-token default. The regression case
  `test/regression/audit-ctx-1.test.ts` is **red on `8e9bbd4`** (no
  `main_agent.context_compacted` event) and **green with the patch**; full suite
  634/634, typecheck and `npm run gate` pass. Produced by DeepSeek V4.1 Flash at
  `reasoning_effort=max` through `clone-ai repair` (run `bd3451a6`), reviewed
  from the captured request/response transcript.
- **Where:** [worker streaming and stop
  instructions](../architecture/trade-offs.md#2026-11-11--the-worker-streams-its-activity-and-the-repair-lane-says-when-to-stop),
  [windowed reads and fragment
  refusal](../architecture/trade-offs.md#2026-11-11--reads-are-windowed-with-an-explicit-total-writes-refuse-fragments),
  [execution chain](optimizations.md#2026-11-11--making-the-repair-lane-reviewable).

## 2026-11-10 — The scope gate now refuses what it claimed to refuse

- **Claim:** the per-call path gate rejects a symlink inside the workspace that
  points outside it, a read grant cannot authorize a write, a grant on an
  ancestor of a protected root is refused, and writes into `.git` are refused.
- **Evidence:** `test/path-gate.test.ts` 4/4 covers all four; each was reproduced
  against the repository's own modules before the fix — `decideTool` returned
  `{allowed: true}` for `link/secret.txt` and `link/new.txt`, and a `~/Library`
  grant was accepted with `dropped: []`. Full suite 626/626; typecheck and
  `npm run gate` pass.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-10--scope-checks-compare-resolved-paths-and-the-repair-lanes-guards-are-real),
  [execution chain](optimizations.md#2026-11-10--closing-the-audits-verified-defects).

## 2026-11-09 — A shared loop kernel with per-call authorization and recorded compaction


- **Claim:** the Main Agent and the native worker run one loop contract, every
  tool call is decided before it executes, long transcripts compact on token
  pressure and record what was dropped, and MCP and skills are opt-in without
  changing a turn that does not ask for them.
- **Evidence:** the deterministic suite went from 585 tests / 4 failures
  (migration fallout) to **560 tests, 560 pass, 0 fail** after the upstream
  native-only migration merged; `test/agent-loop.test.ts` 14/14 covers terminal
  reasons, the concurrency barrier, tool pairing, budgets, abort, retry,
  truncation and deny/ask/allow; `test/context-window.test.ts` 8/8;
  `test/mcp-host.test.ts` 5/5 against a real stdio child; `test/skill-loader.test.ts`
  5/5; native worker/client 17/17; an end-to-end Main Agent turn invokes both a
  skill and an MCP tool. `npm run typecheck` and `npm run gate` pass. No live
  model call was made, so the gain is a harness-contract gain, not a quality
  measurement.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-06--every-in-process-tool-call-goes-through-a-per-call-decision),
  [compaction trade-off](../architecture/trade-offs.md#2026-11-06--compaction-is-token-aware-and-recorded-deterministic-summaries-first),
  [MCP and skills trade-off](../architecture/trade-offs.md#2026-11-06--mcp-and-skills-first-plugins-cloud-vm-and-computer-use-deferred),
  [execution chain](optimizations.md#2026-11-09--per-call-permissions-context-compaction-mcp-and-skills).

## 2026-11-17 — A Finder-launched app has an endpoint

- **Claim:** the endpoint and its credential persist in `config.json`, so an
  app whose process environment is empty still runs; the credential is
  write-only over the API and the files are 0600.
- **Evidence:** `test/companion-config-api.test.ts` (stored key never echoed, a
  full re-read does not leak it, explicit clear removes it, scheme-less URL
  refused); `test/daemon-supervisor.test.ts` (sidecar sets `umask 0o077` before
  starting the companion); full suite 687/687; typecheck and `gate` pass.
  Not verified: no live turn on a config-only endpoint.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-17--the-endpoint-is-saved-in-config-json-and-the-key-is-write-only),
  [execution chain](optimizations.md#2026-11-17--the-endpoint-is-persisted-and-the-key-is-write-only).

## 2026-11-13 — The twin survives an app quit

- **Claim:** the runtime is a `launchd` job, so it starts at login, restarts
  after a crash, and keeps running when the window is closed; the app attaches to
  the endpoint the daemon publishes instead of owning the process.
- **Evidence:** `test/daemon-supervisor.test.ts` (7 tests: RunAtLoad/KeepAlive/
  throttle present, XML escaping, 0600 plist written idempotently, uninstall
  idempotent, argv identical to the shell's spawn, default install location);
  `swiftc -parse -typecheck apps/desktop/macos/main.swift` exits 0; full suite
  684/684; typecheck and `gate` pass. Not verified live: no `launchctl bootstrap`
  was run in this session, so the installed login item itself is unproven.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-13--the-runtime-is-a-launchd-job-and-the-app-is-only-a-window),
  [execution chain](optimizations.md#2026-11-13--the-runtime-becomes-a-launchd-job).

## 2026-11-07 — Worker concurrency follows measured machine capacity

- **Claim:** dispatch concurrency is bounded by measured CPU, load and free
  memory, not by the plan's shape; the queue and every subagent wave share one
  budget, and the model can read the limit but not set it.
- **Evidence:** `test/capacity.test.ts` (6 tests: CPU-bound, memory-bound, load
  sensitive, owner pin capped by cores, gate never exceeds the limit and wakes
  waiters in order, cancelled waits release their slot). Full suite 525/525;
  typecheck and `npm run gate` pass. End-to-end throughput on a large host is not
  yet measured; the verified claim is that no execution can exceed the limit.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-06--worker-concurrency-follows-measured-machine-capacity-capped-by-the-kernel),
  [execution chain](optimizations.md#2026-11-06--worker-concurrency-follows-measured-machine-capacity).

## 2026-11-06 — One auditable execution path

- **Claim:** the Main Agent and every worker are our own in-process loops. The Pi
  SDK and all black-box CLI workers are gone, so every turn and every tool call
  is recorded and gated by the Kernel; no CLI can run with hidden tools or
  credentials.
- **Evidence:** `@earendil-works/pi-coding-agent` removed from `package.json`;
  `black-box-cli-worker`, `worker-registry`, `worker-env`, `providers.json` and
  their tests deleted; full suite 519/519 after the removal; typecheck,
  `npm run gate` and bilingual docs pass.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-06--the-harness-keeps-only-its-own-agents-no-pi-sdk-no-black-box-clis),
  [execution chain](optimizations.md#2026-11-06--removing-the-black-box-cli-workers-stage-2-of-2).

## 2026-11-06 — Native Main Agent matches Pi, with fewer tokens

- **Claim:** on the fixed Main Agent task set the native loop matches Pi's
  outcomes while using slightly fewer tokens.
- **Evidence:** five samples per cell, `360/deepseek/deepseek-v4.1-flash` via
  Magpie, result `benchmark/results/main-agent-2026-11-06T02-07-58-472Z.json`:
  both **15/15**; median duration summed **17.2 s native vs 20.0 s Pi**;
  median tokens **17,973 vs 19,081** (≈5.8% fewer); plan p90 **15.8 s vs 26.9 s**.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-05--a-native-main-agent-loop-behind-a-flag-not-a-flag-day),
  [execution chain](optimizations.md#2026-11-06--five-sample-confirmation-of-the-main-agent-comparison).

## 2026-11-06 — Native Main Agent streams, compacts and accepts images

- **Claim:** the native loop delivers tokens as they arrive, keeps a long
  conversation within budget without losing the full text, and accepts image
  attachments.
- **Evidence:** live long-context run — 24 seeded turns, 4,000-char budget,
  2,121-char summary reached the endpoint, the oldest turn's needle survived, the
  reply was exactly `BLUE-FALCON`, 7,842 tokens, all five checks true
  (`benchmark/results/native-main-long-context-2026-11-05T09-43-52-438Z.json`).
  Live image run — 64×64 red PNG, reply `Red.`, 3,806 tokens
  (`benchmark/results/native-main-images-2026-11-05T10-01-47-161Z.json`).
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-05--native-main-agent-streams-and-compacts-deterministically),
  [execution chain](optimizations.md#2026-11-06--long-context-validation-of-native-compaction).

## 2026-11-05 — The native worker completes the reliability set

- **Claim:** the in-process worker completes the fixed reliability tasks,
  reports exact token usage, and fails a declared-missing input cleanly instead
  of inventing an artifact.
- **Evidence:** `npm run bench -- --provider native` (before the CLI removal),
  model `360/moonshotai/kimi-k3.1-pro` via Magpie: **5/5** including
  `missing-input` as an expected failure; per-task usage recorded
  (summarize 2,252 tokens, three-step pipeline 12,420, total ≈27k)
  (`benchmark/results/native-2026-11-05T11-09-55-300Z.json`). After the
  missing-input guard, the task fails with `no_artifact` / `native-missing-input`
  and 1,397 tokens (`benchmark/results/native-2026-11-05T08-10-22-910Z.json`).
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-05--a-missing-named-input-fails-the-native-worker-instead-of-allowing-invention),
  [execution chain](optimizations.md#2026-11-05--a-missing-named-input-fails-the-native-worker).

## 2026-11-05 — Every Main Agent turn is attributable

- **Claim:** every Main Agent turn, from CLI, `npm run main`, the desktop/server
  companion or WhatsApp, records its input, reply, tool calls, model, effort and
  exact usage in the journal; a turn without a run still leaves a record.
- **Evidence:** `test/main-agent-turn-audit.test.ts` (4 tests: redaction, tool
  events, failed turn, interruption idempotence, newest-first loading); full suite
  544/544 at the time; `clone-ai audit turns` and `GET /api/audit/turns` read the
  same records.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-05--every-main-agent-turn-is-a-journal-record-not-a-side-file),
  [execution chain](optimizations.md#2026-11-05--turn-level-audit-for-every-main-agent-entry-point).

## 2026-11-05 — The regression gate holds the judgment layers

- **Claim:** evidence verification, authority policy and audit calibration are
  re-run on every commit without a model, and any verdict change is a reviewable
  diff.
- **Evidence:** `npm run gate` — 11 verdict cases, 14 policy cases, 5 audit
  records; 100% agreement, 0 false passes, 0 unsafe allows; CI runs it after
  `npm test` and `npm run typecheck` (`benchmark/gate/baseline.json`).
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-05--the-regression-gate-is-offline-per-case-and-behavior-only),
  [execution chain](optimizations.md#2026-11-05--prompt-provenance-and-offline-regression-gate).

## 2026-11-05 — A prompt revision is identifiable

- **Claim:** a failed turn can be attributed to the exact prompt it read: charter
  version, compiled briefing, registered tool table, model and effort are
  content-addressed and journaled per turn.
- **Evidence:** `test/prompt-snapshot.test.ts` (hash stability, reuse of
  identical material, briefing and tool changes moving different hashes, the
  journal event and locator, all registered tools visible, write failure logged
  not thrown); `GET /api/main-agent/prompt-snapshots` lists recent turns.
- **Where:** [trade-off](../architecture/trade-offs.md#2026-11-05--prompt-provenance-is-a-content-addressed-file-plus-a-journal-event),
  [execution chain](optimizations.md#2026-11-05--prompt-provenance-and-offline-regression-gate).
