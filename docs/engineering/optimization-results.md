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
  rows ahead of 23 observations, and a collapsed 214-row trace.
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
  --workspace "/Users/user/Documents/Clone AI" --out …/verify/app-final2
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
- **Evidence:** five samples per cell, `deepseek/deepseek-v4.1-flash` via
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
  model `moonshotai/kimi-k3.1-pro` via Magpie: **5/5** including
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
