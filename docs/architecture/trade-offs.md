# Architecture trade-offs

**English** · [简体中文](trade-offs.zh-CN.md)

A decision is only durable when its reason is written down. Each entry states
what was decided, the evidence behind it, and the condition under which a
future reader should reverse it.

## 2026-11-19 — The internal base is the machine root, not a folder

**Decision.** When neither `workspacePath` nor `CLONE_AI_WORKSPACE` is given,
`resolveClonePaths` defaults the internal base to `/` — the machine root — and
the companion server uses the same fallback instead of the clone home. The
runtime's execution lock stops deriving its database from the workspace:
`CloneRuntime` receives `workspaceLockFile`
(`<clone home>/workspace-runtime/workspace-execution.sqlite3`) and passes it to
`WorkspaceExecutionLock`, so a root workspace never tries to create `/.clone`.
The verifier's default root therefore becomes `/`; `verifiedWorkspacePath` still
refuses the locations no policy may open (keys, browser profiles, the journal,
tokens, policies). The clone home remains the owner's data directory, not a
default working folder.

**Why it won.** The owner corrected the previous entry directly: "工作区默认就是
/，是整个机器，而不是某个文件夹". The verification run on 2026-11-19
(`16494863…`) showed the worker listing `/Users/qihoo/.clone` and reading
`/Users/qihoo/.clone/README.md`; that is the hidden-folder confinement the owner
rejected. A folder is neither a default nor a permission.

**Alternatives rejected.**
- *Keep the clone home as the base.* It confined relative paths and the
  verifier to a hidden data directory; the owner explicitly rejected a folder.
- *Use the process cwd.* The base would depend on how the app was launched,
  which is the configured-folder problem under another name.
- *Keep the execution lock under `<workspace>/.clone`.* With `/` it would try
  `/.clone` and fail; the lock belongs to the runtime, so it lives under the
  clone home.
- *Narrow the verifier below the base.* The verifier's roots are the internal
  base and the step's declared write scopes. With `/` as the base that is the
  machine; narrowing it would leave a valid read outside `~/.clone`
  unverifiable — the failure this change fixes. The forbidden-location check
  remains, so protected files are not read by the verifier.

**What it costs.**
- Relative paths in plans resolve from `/`; plans should use absolute targets.
  A root-level `AGENTS.md` or `CLAUDE.md` would be picked up if one existed.
- The verifier reads a locator to check evidence, so a fabricated locator can
  make it read any non-forbidden file the process can read. The content is not
  returned, but the read happens. If that is unacceptable, restrict the
  verifier's roots per step without changing the base.
- A `CloneRuntime` constructed directly with `/` and no checkpoint store would
  derive `/.clone/workspace-checkpoints`; the factory always passes the
  clone-home store, so production never does.

**Evidence.** The owner's statement; the 2026-11-19 run read `~/.clone`;
`~/.clone/.clone/workspace-execution.sqlite3` exists, proving the runtime lock
still used the workspace; `test/clone-home.test.ts` pins the `/` default, the
`CLONE_AI_WORKSPACE` override and `workspaceLockFile` under the clone home;
`test/workspace-lock-abort.test.ts` pins an explicit lock file.

**Reversal condition.** If a relative path or project-instruction lookup from
`/` selects a wrong file, or a fabricated evidence locator reads a protected
path, restore a non-permission base (the clone home) while keeping reads
machine-wide, or add a protected-path deny to the verifier. If the owner later
names a per-task folder, make it a learned or per-request folder, never a
global setting.

**Supersedes:** the internal-base half of
[2026-11-19 — There is no configured working directory; a write names its
targets](#2026-11-19--there-is-no-configured-working-directory-a-write-names-its-targets).

## 2026-11-19 — The no-progress guard counts each call across the turn, not adjacent batches

**Decision.** The shared agent loop now counts, per turn, the identity of every
executed tool call — tool name, canonicalized arguments and result text — and
warns when any identity reaches three occurrences and ends the turn with
`no_progress` at five. Adjacent-batch equality is gone: a different call between
two identical polls no longer resets the poll's count, and one changing call in
a batch no longer masks an identical sibling. A call whose result changes is a
new identity (progress); a changed argument is a different identity.

**Why it won.** The 2026-11-19 audit reproduced two escape shapes on the merged
guard. (1) Alternating `get_run_status(run-1)` / `get_run_status(run-2)` with
constant results ran twelve rounds and completed, because no two adjacent
batches matched. (2) Eight batches of `[get_run_status(run-1), tick]` completed
because the tick's changing result changed the whole batch fingerprint. Both are
waiting, not progress. The Main Agent path has no round cap (`bba7896`), and the
prompt's "never poll" is soft; the guard is the only local bound for these
shapes.

**Alternatives rejected.**

- *Keep adjacent-batch equality and add a cycle detector for lengths 2..k.* More
  state, and a cycle can be longer than k; per-identity counting catches any
  spacing with one map.
- *Count only consecutive occurrences of the same identity.* That is what the
  batch rule effectively did; it misses alternation.
- *Reset all counts when a different call appears.* That reintroduces the same
  blindness: a model can alternate forever.
- *Treat a batch with any changing result as progress.* That is exactly the
  masking shape; a changing sibling says nothing about the poll.
- *Add a default round or duration cap.* `bba7896` removed the arbitrary cap; a
  cap stops productive long turns without proving no progress.

**What was given up.** A legitimate identical call repeated five times across a
turn (even with different work between) is stopped; a turn that re-reads the same
file with the same result five times ends earlier than before. Counts are per
turn, not windowed. The result text is compared after the loop's truncation, so
a result carrying a timestamp or counter is progress. The cost is one map entry
per executed call: small strings, no model calls.

**Evidence.** The audit's reproductions on `43a34cc`: a twelve-round
alternation completed, and eight batches of an identical poll plus a changing
tick completed; both were waiting. New cases in `test/agent-loop.test.ts`: the
alternation stops at round 9 after the fifth A; the masked poll stops at round 5;
the exact eight identical polls still stop at 5; A,A,B,A,A completes with four A
occurrences; a changing result still progresses. Before the change the two new
cases fail (both complete); after they end as `no_progress`. Full suite and
typecheck results are recorded in the optimization log.

**Reversal condition.** If a benchmark or an owner's turn is stopped as
`no_progress` while making real progress (e.g., a legitimate repeated read whose
result is identical for five occurrences), raise the thresholds, narrow the
counting to read-only wait tools, or window the counts. If a provider rewrites
results so identical calls no longer compare equal, fingerprint the
pre-truncation result.

## 2026-11-19 — A search location is not a file promise, and the incident's real plan is the fixture

**Decision.** `extractFileExpectations` treats a path as a file promise only when
the plan names it as a deliverable. A path introduced as a search location or a
directory context (数据目录, 候选位置, "里的线索", a slash-separated list such as
`package.json / pnpm-workspace.yaml`) is context, not a promised file; a spaced
absolute deliverable path stays whole. The regression test uses the actual
`plan.created` instructions of run `fa36a720`, and it must be red before the
fix: the current extractor returns `"/ pnpm-workspace.yaml"` and
`"/Users/qihoo/.clone"` from those instructions.

**Why it won.** Commit `6dc13f0` was claimed to clear this trace, but it fixes
only two synthetic sentences. Replaying the real step (journal seq 1818) on the
merged extractor still yields two false promises, and an `EvidenceVerifier`
replay still returns `passed: false`; the lane's regression fixture
(`test/regression/fa36a720-directory-and-spaced-path.test.ts`) contains neither
the candidate-location sentence nor the slash list. The added absolute-path
pattern also introduced a new false positive (`/ pnpm-workspace.yaml`) by
accepting a slash followed by whitespace. Verification must be judged on the
recorded plan, not on a reduced paraphrase of it.

**Alternatives rejected.**

- *Add more exclusion words.* The real plan supplies a second mention ("里的线索")
  and a slash list; each new sentence can add another form. A keyword exclusion
  list is what produced the false positives in the first place.
- *Widen the verifier's roots so `/Users/qihoo/.clone` exists.* The path is a
  directory mentioned as a place to search, not a file deliverable; accepting it
  would hide a false promise instead of removing it.
- *Skip file expectations for every read-only step.* The `写入 missing.md` case
  and the workspace-boundary test need real promises to stay checked; a
  read-only step can still promise a file it wrote nothing to.
- *Add a `deliverables` field to the plan schema now.* That is the durable fix
  named by the previous entry's reversal condition, but it changes the plan
  contract and every planner; do it only if the prose heuristic keeps failing.

**What was given up.** A plan that mentions a real file only as context ("read
`/x/y.md` and summarize") no longer makes that file a required deliverable;
verification falls back to the step's observations. A plan that means a
deliverable but phrases it only as a location list is not verified as a
promise. The extractor remains a prose heuristic; a novel phrasing can still
misclassify.

**Evidence.** Journal seq 1818 (the real step) and my reproduction on the
current tree: `[{"path":"/ pnpm-workspace.yaml"},{"path":"/Users/qihoo/.clone"}]`.
The pre-`6dc13f0` extractor returned `["/Users/qihoo/.clone", "AI/.clone"]`, so
one false promise is replaced by another and one is new. The repair lane
produced `test/regression/verifier-real-plan.test.ts` from the real instructions
(red before, green after); it landed as commit `763dcd8`.

**Reversal condition.** If a real promised file is suppressed, add an explicit
deliverable marker (a plan field or a "generate/write exactly this path" rule)
rather than another exclusion word. If plans quote paths as evidence rather
than deliverables, stop scanning instructions for file promises and rely on the
step's declared scopes.

## 2026-11-19 — A read-only marker outranks a bare write verb in the fallback planner

**Decision.** When a request carries an explicit read-only marker (只读, 不要修改,
review only, …) and names no write target (写到 / 保存到 / 输出到 / write to with a
path), `buildFallbackPlan` no longer treats a bare write verb (保存, 写, 渲染, …)
as a delivery request. The rule becomes
`deliveryRequested = writeTarget || (!explicitReadOnly && (positiveWrite || artifactNoun))`.
A named write target still wins; a request without a read-only marker keeps the
existing delivery terms. The two `dispatch_task` objectives from 2026-11-19 then
plan as one read-only lookup instead of `reversible_write`.

**Why it won.** The two dispatch runs (`2c8b917a`, `09499a28`) were denied at
policy 3–4 ms after queuing: the auto-plan classified "读取/保存…配置的代码" and
"读写…配置的代码" as delivery because `保存`/`写` are in `POSITIVE_WRITE_VERBS`,
and the planner's `positiveWrite` branch is an unconditional OR. The denied
plan carried a workspace write scope and the files domain was observe-only. The
denial reason did not reach the Main Agent (a separate defect), so it
re-dispatched and then abandoned `dispatch_task` for a hand-written read-only
plan — the path that ended in eight `get_run_status` polls.

**Alternatives rejected.**

- *Blacklist the phrases "读取/保存" and "读写".* The next objective will phrase
  the mention differently; the rule would stay a list of known sentences.
- *Rely on the policy denial to make the model re-plan.* `dispatch_task` and
  `get_run_status` do not carry the denial reason today; relying on it leaves
  the duplicate dispatch loop in place.
- *Restore the workspace write fallback.* That is the implicit permission the
  owner removed in the entry above.
- *Use a planner model call.* It costs a model call per dispatch, and the
  fallback planner exists for the no-planner path; this is a precedence rule,
  not a judgment call.
- *Require a read-only marker to be the whole request.* The real objectives
  contain other instructions; the marker appears at the end.

**What was given up.** "不要修改现有文件，只写一份报告" with no named target is
now planned read-only; the owner must name the output target, which the
no-working-directory decision already requires for any write. A request whose
only delivery cue is a bare verb alongside a read-only marker is answered as an
investigation rather than a write. The planner remains a keyword policy; a
novel phrasing can still misclassify.

**Evidence.** Journal seq 1785/1792/1794/1795 and 1799/1806/1808/1809: both
objectives say 只读/不修改, both plans are `prepare/reversible_write`, both
denials are `The files domain is observe-only`, and both runs fail in 3–4 ms.
Reproduction on the current tree gives the same plans. A simulation over the 11
literal inputs in `test/fallback-planner.test.ts` changed zero classifications;
`不要修改现有文件，但把报告写到 out/report.md` stays a draft because a named
target wins. The repair lane produces the red/green case from the two recorded
objectives; this entry records its before/after result.

**Reversal condition.** If a benchmark or an owner's dispatch is planned
read-only while the owner asked for a file without naming a target, add a
deliverable marker (an explicit `deliverables` field, or a "只写/只生成/只输出 +
artifact" rule) rather than re-enabling bare verbs. If plans start naming a
target for every deliverable, rely on `writeTarget` alone.

## 2026-11-19 — There is no configured working directory; a write names its targets

**Decision.** The owner-facing 工作目录 setting, the `workspacePath` config
field, the public path display and the saved-path restart notice are removed.
The app no longer asks for or persists a working folder. A write step that names
no target gets no files write scope: the Kernel no longer proposes the workspace
as a fallback, and the authority policy denies such a step because it named no
target. `ensureWriteScopes` adds scopes only for targets named in the step or
the request. An internal base folder remains an implementation detail — the
server uses `CLONE_AI_WORKSPACE` if set, otherwise the clone home — for relative
paths, project-instruction lookup, the verifier's default root and legacy
migration; it is not configurable and not a permission. Runtime locks and the
execution database move from `<base>/.clone` to
`<clone home>/workspace-runtime`. The verifier may read a file inside the
internal base or inside a write scope the step declared; a read-only promise
outside both still fails. The prompt no longer names a current workspace:
the computer is the workspace, reads are open, writes name targets, and no
folder is writable by default. Charter version 7.

**Why it won.** The owner's request came with the screenshot of the 工作目录
setting: "这个工作目录不要了，没有工作目录，整个电脑都是工作空间，修改一下代码".
The 2026-11-19 decisions (4f0149e, 7e80c41) already made reads machine-wide and
every write carry a scope; the setting and the implicit workspace fallback were
the last places a folder acted as a permission. The project's learned-folders
decision also says working folders are learned from use, never configured as a
setting.

**Alternatives rejected.**

- *Keep the setting as an optional default folder.* The owner asked to remove
  it, and a global folder setting is what the learned-folders decision rejects.
- *Make the whole machine the verifier's read surface.* The workspace-boundary
  test and untrusted evidence locators say the verifier reads only paths the
  owner authorized; the step's declared write scope is that authorization.
- *Remove the internal base entirely.* Relative paths, project-instruction
  lookup and existing verification need a base; the clone home is a safe
  non-project one.
- *Default writes to the clone home.* That is still an invented default, and it
  is not where an owner's deliverables belong.
- *Relax the protected-path policy.* No protected file is opened by this change;
  the scope and base checks stay.

**What was given up.** The app no longer loads a project's AGENTS.md/CLAUDE.md
from an owner-chosen folder; the internal base (the clone home by default)
usually has none, so the agent must read project rules through a step. Relative
paths in plans resolve against the internal base; plans should use absolute
targets. Automatic verification of a file outside the base requires the step's
write scope to contain it; a read-only step's outside promise still fails. Diff
and test contracts remain base-relative; a plan testing another project needs a
scope and an absolute command. Existing `workspacePath` values in `config.json`
are ignored and disappear on the next write.

**Evidence.** The owner's screenshot and instruction; `src/config/clone-config.ts`
persisted the field, `apps/desktop/ui/index.html` and `app.js` exposed it,
`src/authority/write-scopes.ts` fell back to it, and `src/config/clone-home.ts`
put the runtime database inside it. Tests pin the new contract: the UI and config
no longer offer the setting, a no-target write gets no scope and is denied, the
runtime database lives under the clone home, and the verifier accepts a file
under a step's declared scope outside the base.

**Reversal condition.** If the agent cannot load a project's rules or run its
tests without an owner-chosen folder, add a learned or per-request folder (the
folder the request names, not a global setting), or a per-step working
directory. If verification of scoped writes proves insufficient, widen the
verifier to the step's scopes for diff and test contracts too.

**Superseded (internal base).** [2026-11-19 — The internal base is the machine
root, not a folder](#2026-11-19--the-internal-base-is-the-machine-root-not-a-folder)
replaces the clone-home default with `/`.

## 2026-11-19 — The sidebar's top level is the conversation; tasks nest inside it

**Decision.** The sidebar exposes one top-level kind per section. A conversation
row is the thread; the Runs its turns dispatched are collapsible children
(default collapsed, with a count and a running/waiting/failed distribution). Runs
the main conversation dispatched sit under a non-row 主对话 header; Runs with no
conversation — scheduled, repair-lane, opportunity and external requests — sit
under 定时/自动. The main conversation stays the fixed navigation entry, never a
row. The parent row's status is the aggregate waiting > running > recent failure
> completed; its title is the conversation's first request, so the row does not
churn every turn; its preview follows the latest turn or child. Task records
keep their decision dock, evidence, verification and Agent rows. A waiting child
is promoted into the 需要你的确认 section, not left inside a collapsed group.
The owner-facing vocabulary is four words: 新请求 (the action), 对话 (the
thread), 任务 (one bounded Run), 定时 (the schedule rule). 最近任务, 任务记录 as
a peer kind, 任务对话 and 个人对话 are retired. `buildSession` no longer defaults
a missing trigger `conversationId` to the main conversation: a send from a
conversation-less task record is routed as a new request, not silently into the
main thread.

This supersedes the "no conversation rows" clause of the 2026-11-18 "The task
record is the unit" entry — its reversal condition anticipated owners wanting to
switch among several conversations — and inherits the 2026-11-19 "A request that
dispatched no task is still a sidebar row" reversal condition ("group the
conversation and its child tasks into one collapsible row"). The
decisions-on-the-task-record clause of 2026-11-18 stands unchanged.

**Alternatives rejected.**

- *Keep the flat mixed list.* A row is a conversation or a Run depending on
  whether the request dispatched work, so the owner must know the dispatch
  outcome to read the list. "任务" then names the new-request action, the
  最近任务 list, a schedule rule, a Run record and a child Run at once.
- *One "session" object with work records inside it.* The runtime has no session
  object; a conversation is a turn-ledger scope. Threadless Runs would need a
  synthetic conversation, a new persisted thread-attachment index and a second
  id space. Moving decisions to the session top also reverses the tested
  2026-11-18 contract that decisions live on the task record.
- *Task-only: one request is one task.* A direct answer creates no Run by design
  (`proposePlanToKernel` refuses a one-step `direct_response`), and one
  conversation can contain several turns and several Runs. Calling the
  conversation "the task's transcript" inverts the containment and either fakes
  Runs for answers or hides a thread inside a task.
- *Nest threadless Runs under a fake conversation.* Scheduled, repair and
  opportunity Runs have no conversation; `buildSession` papers over this today
  by defaulting to the main conversation — exactly the misrouting this change
  removes.

**Evidence.** The runtime has three layers, not two. A conversation is the
turn-ledger, context-window, prompt-lock and history-search scope and has no
execution terminal state; a Kernel Task is the immutable request header and has
no status; a Kernel Run is the governed execution with plan, authority, budget,
evidence, verification and terminal states (`src/core/contracts.ts:31-46`,
`src/core/runtime.ts:407-433`). `mainAgentRunConversations` maps a Run to a
conversation only for `source === "main-agent"`
(`src/main-agent/run-triggers.ts:20-47`); a direct answer creates no Run
(`src/main-agent/tools/kernel-tools.ts:135-146`); scheduled and desktop requests
create Runs with no conversation. The current UI shows the collision:
`sessionMarkup` badges a conversation row with 对话 (`apps/desktop/ui/app.js:664`),
`setTopbar` prints 个人对话 / 任务对话 / 任务记录 (`app.js:1932`), the buttons say
新请求 / 对话 / 定时任务 and the list header is 最近任务
(`apps/desktop/ui/index.html:21-25`), while the locale already calls the action
新请求 (`src/desktop/ui-locale.ts:12`). The 2026-11-18 build `a575fdb` already
rendered conversation rows with `.session-children`; the 2026-11-19 flatten
removed the renderer but left its CSS (`apps/desktop/ui/audit.css:134-145`), the
`openChildGroups` state and `parentId`/`childCount` in `SessionSummary`
(`src/companion-server.ts:3999-4013`). The eval is deterministic: a dashboard
case with one conversation and two spawned Runs must return one conversation row
with `childCount: 2` and two child rows carrying `parentId`; the UI contract
must show the nested group and the 主对话/定时 groups; the waiting child must
appear in the promoted section and not twice.

**What it costs.** One nesting level. A one-request/one-Run conversation renders
a parent and a nearly identical child; the parent title is the first request, so
it stays stable, but it can be stale after a topic change. A conversation with
many Runs needs the collapsed group and the promoted waiting section to stay
readable. The learning-cost gain is *assumed*: no owner usability check was run.
The deterministic eval shows the intended shape, not a measured reduction in
learning time. No benchmark applies: this is a UI/read-model contract, not a
provider or orchestration change.

**Reversal condition.** If grouped rows make dispatched work hard to find, add a
flat task filter or fall back to the task-only list; if the parent/child
duplication for one-request/one-Run conversations confuses owners, collapse a
single-child group into the parent row. Do not hide direct answers again. If
owners need every Run as a top-level row, add a "tasks" view rather than removing
the conversation parent.

## 2026-11-19 — Agent settings show the connection, not the loopback URL or raw model id

**Decision.** Settings → Agent no longer prints the Magpie loopback URL
(`http://127.0.0.1:3425/v1`) under 本机 Magpie 已连接, and its overview no longer
has a third 当前模型 stat card repeating the raw provider/model id
(`360/deepseek/deepseek-v4.1-flash`). The gateway card keeps the connection
state, the explanation and the model picker, whose options already show the
friendly model name. The raw endpoint and id remain in the config file, the
audit and the logs.

**Alternatives rejected.**

- *Keep the URL as a diagnostic.* It is always the same loopback address; the
  owner cannot act on it from settings, and when it matters the audit and logs
  already carry it.
- *Move the URL into a collapsed 连接详情 disclosure.* Still a path in a settings
  page whose job is choosing a model; it adds a control to hide something nobody
  needs there.
- *Show the friendly model name in the stat card.* The picker directly below
  already shows it, and the card would duplicate the picker while adding a
  second place that can go stale.
- *Remove the gateway card too.* The connection state, the model picker and the
  "use this model" action live there.

**Evidence.** The two screenshots show the raw `http://127.0.0.1:3425/v1` line
and a 当前模型 360/deepseek/deepseek-v4.1-flash card directly above the same
model's picker. `test/ui-locale.test.ts` already states that model count, version
and API paths are diagnostics, not choices; it will pin the URL and the third
stat card out of the page.

**What it costs.** A nonstandard endpoint is not visible on the settings page; a
reader must use the config file, the audit or the logs. The overview has two
cards instead of three.

**Reversal condition.** If the owner needs to diagnose a nonstandard endpoint
from Settings, add a collapsed 连接详情 disclosure or a copy action; do not
restore a permanent code line. If the model id must be visible for support, show
it in the audit only.

## 2026-11-19 — A conversation table renders as a table, and exports to CSV on request

**Decision.** The conversation's Markdown renderer (`richText` in
`apps/desktop/ui/app.js`) learns GFM tables: a header row, a delimiter row
(`:---:`, `---:`, `---`), body rows, alignment and `\|` escapes. Cells go
through the same escape-first inline path as the rest of a message, and the
table renders inside a `.md-table-wrap` with a 导出 CSV control. That control
posts the table's CSV to a new owner-initiated `POST /api/tables/export`, which
writes a timestamped `.csv` into the folder the owner chose in the native
directory picker and then reveals it in Finder. Tables stay Markdown at the
source; the Main Agent, its charter and the prompt are unchanged.

**Alternatives rejected.**

- *Have the Main Agent turn every table into an Excel/CSV file through a
  worker.* The Main Agent has no filesystem tool of its own, so every table
  would need a dispatch, a `files` write scope and possibly an approval; a
  three-row status table would cost a run and a scope request. The desktop also
  has no `.xlsx` writer, so the file would be CSV in any case.
- *Add a third-party Markdown parser.* The hand-written renderer escapes its
  input first, and its escaping is already covered by the UI tests. A parser
  would either replace that safety property or require a separate sanitizer,
  and this local-first app ships no such dependency today.
- *Keep the raw text and tell the owner to read it elsewhere.* That is the
  reported defect, not a fix.
- *Only render tables, with no export.* The owner asked for a file Excel can
  open; a rendered table alone does not give them one.

**Evidence.** The owner's screenshot of 2026-11-19 shows clone-ai's reply with
the literal `|位置|状态|` and `|---|` rows: `richText` at
`apps/desktop/ui/app.js:1605` handles fenced code, inline code, bold, headings
and lists, but has no table rule, and `test/ui-structure.test.ts` only asserts
the heading/list styles. The native directory picker and the owner-initiated
`/api/export` flow already establish the trust boundary this export reuses.

**What was given up.** The hand parser covers the common GFM table subset but
not multi-line cells (`<br>` inside a cell), inline HTML (escaped everywhere, as
before), or tables indented by four or more spaces. CSV export flattens cell
markup to plain text. Each rendered table carries its CSV in a
`data-export-csv` attribute, so a very large table duplicates its text in the
DOM; the server bounds the export size. The export route is a new local write
surface: it accepts only an absolute folder chosen through the native dialog,
refuses the clone data directory, and writes an exclusive timestamped name, but
it is still code that did not exist before.

**Reversal condition.** If the owner wants every table delivered as a file
rather than inline, or tables routinely outgrow the reading column, make a
worker-produced CSV the default and keep rendering only for short tables. If
the hand parser mis-renders tables real GFM users write (nested or multi-line
cells), adopt a maintained GFM parser and re-run the escaping tests. If owners
never use the export control, or a native save panel becomes available, replace
the daemon write with the save panel. If the CSV attribute makes the DOM heavy
in practice, switch to a registry keyed by table id.

## 2026-11-19 — A path introduced as a directory is not a file promise, and a spaced path is one path

**Decision.** `extractFileExpectations` no longer turns a path into a file
promise when the clause immediately before it ends with a directory word
(目录, 文件夹, directory, folder). A plan that says "数据目录
/Users/qihoo/.clone" names an input location, not a file it promises to
produce. A path that is a file promise, including an absolute path containing
spaces, is kept whole: `Write /tmp/verify/Clone AI/out.md` extracts the full
path, never `AI/out.md`. The verifier keeps its workspace read boundary, its
symlink refusal and its write rules; nothing outside the workspace becomes
readable.

**Why it won.** Run `fa36a720…` was a read-only investigation. Its instructions
introduced `/Users/qihoo/.clone` as 数据目录 and
`/Users/qihoo/Documents/Clone AI/.clone` as 项目运行目录. The extractor treated
both as promised files, split the second at the space, and the verifier failed
the run with `"/Users/qihoo/.clone" was promised but does not exist on disk;
"AI/.clone" was promised but does not exist on disk`. The first path is an
existing directory outside the workspace; the second never existed. The worker's
report was correct. A directory is an input location, not a deliverable; only a
file promise belongs in the verifier's file contract. The space fix covers an
actual file target.

**Alternatives rejected.**

- *Read the file contract only from acceptance criteria for read_only steps.*
  Two existing tests deliberately take a path from a read_only step and assert a
  hard failure: "a read-only step that promises a missing file fails" uses
  `写入 `missing.md`` in the instructions, and the workspace-boundary test names
  the path in its acceptance criterion. Removing instruction paths for
  read_only steps would turn the first into review and weaken the contract.
- *Ignore every path in a read_only step.* Same problem: the missing-file test
  expects a failure.
- *Require a write verb for every path.* The "file expectations distinguish
  paths and explicit root-level deliverables from code" test expects
  `Review docs/nightly-rsi.md`, `Inspect lib\runtime.ts` and others to be
  extracted without a write verb.
- *Let the verifier read outside the workspace.* The workspace-boundary test
  pins a hard failure; evidence locators are untrusted, and opening the machine
  would let a plan make the Kernel read arbitrary files.
- *Only fix the space split.* The two directory paths would still be extracted
  and fail.

**What was given up.** A real file path behind a directory word ("the report
directory /tmp/out.md") is treated as context. Only absolute paths get the
space-aware treatment; a relative path with spaces is still ambiguous. The
extractor remains a heuristic over prose.

**Evidence.** The failed step's instructions say "已知数据目录
/Users/qihoo/.clone，项目运行目录 /Users/qihoo/Documents/Clone AI/.clone。" Both
clauses end with 目录. The current extractor returns both paths (the second
truncated), and the verifier reports both missing. `/Users/qihoo/.clone` exists
as a directory. The existing `写入 missing.md` and workspace-boundary cases must
stay hard failures. The repair lane's regression case must be red before the
fix and green after: a 数据目录 path yields no file expectation, and a spaced
absolute file path is extracted whole. The lane produced that case and a green
patch (new case **1/1**, `test/verification.test.ts` **16/16**, full suite exit
**0**), but `src/core/verification.ts` is in the lane's `PROTECTED` list, so the
lane refused to commit it. The owner explicitly approved merging the verified
patch; it landed as commit `6dc13f0`. Post-merge on main: regression +
verification **17/17**, full suite **916/916**, typecheck exit 0, gate
**PASS**.

**Correction (2026-11-19, after the audit).** The sentence above that the
recorded investigation's paths are handled is wrong. The fixture reduced the
instructions to the two directory sentences; the real `plan.created` step
(journal seq 1818) also says "候选位置包括 … 以及 /Users/qihoo/.clone 里的线索"
and "package.json / pnpm-workspace.yaml". On the merged extractor those produce
`/Users/qihoo/.clone` again and a new false promise `/ pnpm-workspace.yaml`, and
an `EvidenceVerifier` replay still fails (`passed:false`). The replacement entry
at the top of this file records the corrected decision and uses the real
instructions as the fixture. The 1/1 fixture and the 16/16 result above describe
the synthetic forms only.

**Reversal condition.** If plans routinely put a real file path behind a
directory word, add an explicit deliverable marker to the plan schema instead of
the marker heuristic. If plans start quoting every path, rely on quoted paths.
If relative paths with spaces become common, extend the space handling to them.

## 2026-11-19 — A repeated tool call stops the turn locally, and a queued run is not polled

**Decision.** The shared agent loop (Main Agent and every native worker) now
fingerprints each executed tool-call batch by tool name, canonicalized arguments
and result text. When the same fingerprint occurs three times in a row it
appends a system notice to the transcript ("No progress: this exact call
returned the same result …"); on the fifth consecutive occurrence it ends the
turn with a new typed terminal reason `no_progress` and an error naming the
tool and count. A batch whose result differs is progress and resets the streak.
The Main Agent's charter and the `get_run_status` description now say that a
run proposed by `propose_work_plan` advances on its own: report its runId and
end the turn; `get_run_status` returns a snapshot, never waits, and must not be
polled in a loop. While a run is queued or running, its status text ends with
"Snapshot only — calling this again does not advance the run."
`MAIN_AGENT_CHARTER_VERSION` moves to 6. A worker that stops with the new
reason is reported as `no_progress` instead of `completed`, and
`describeFailureForOwner` gives the owner a Chinese summary and next step.

**Superseded clause (2026-11-19, later the same day).** The adjacent-batch
comparison above ("in a row") was replaced by per-call counts across the turn;
see the entry at the top of this file. The warning at three, the `no_progress`
stop at five and the snapshot guidance are unchanged.

**Why it won.** On 2026-11-19 the owner's turn `fa63e0f3…` called
`get_run_status` on run `fa36a720…` eight times between 14:13:59 and 14:14:21;
every call returned the same projection (`Run …: running`). The provider
gateway (Magpie, with its "stop repeated replies" check on) stopped the request
before the model saw it and returned "这一轮在发给模型之前已被停止…"; Clone AI
recorded that text as a completed reply (`main-agent-turns.jsonl`, status
`completed`), and the queued run kept running. The loop has no default round
cap (bba7896) and no repeated-call detection: its only stops are a final
answer, abort, and token/tool/duration budgets. The only thing that stopped the
repetition lived outside this runtime, and its stop looked like an answer
rather than a failure. The new guard is provider-independent, fires earlier
(5 vs 8), gives the model one chance to change approach at 3, and records an
honest failed turn.

**Alternatives rejected.**

- *Rely on the gateway's repetition check.* Not every provider has one; where it
  exists it is outside the runtime, its threshold is higher, and its stop is
  recorded as a model reply.
- *Reintroduce a default `maxRounds`/`maxToolCalls`.* That is the arbitrary cap
  bba7896 removed; it stops productive long turns without proving no progress.
- *Make `get_run_status` block until the run changes.* The Main Agent should not
  wait for queued work — the queue exists so the conversation returns;
  `dispatch_task` already waits for short work. A blocking read would hold the
  turn and duplicate that path.
- *Only stop silently after N repeats.* The model ignored the external hint once
  already; the warning at 3 gives it a chance to answer, and the typed stop at 5
  is bounded and visible.
- *Rewrite the tool result instead of adding a system message.* The result must
  remain the tool's own output; a system notice is where an instruction belongs,
  and the loop already inserts one for its remaining-round budget notice.

**What was given up.** A legitimate call that returns identical text five times
in a row is cut off. A polling read of a slow external system could hit it; the
model can change the call or answer with what it has. The fingerprint compares
the result text after the loop's truncation, so a result carrying a timestamp,
counter or changing content never matches. The cost is one fingerprint per
batch: small strings, no extra model calls.

**Evidence.** `test/agent-loop.test.ts` is **23/26 before** the change — the
three failures are the new cases: a constant-result repeat stops at
`no_progress` on the fifth call, three repeats inject the warning and a later
answer completes, and reordered JSON keys count as the same call. It is
**26/26 after**. Five same-call-different-result rounds complete, and a changed
argument resets the streak. The existing `get_run_status` test asserts the
snapshot note. `npm test` **906/906**; `npm run typecheck` exit 0; `npm run gate`
**PASS**, baseline unchanged. The before run used `git show HEAD:src/agent/loop.ts`
in place, then restored the new file.

**Reversal condition.** If a benchmark or an owner's turn is stopped as
`no_progress` while it was making real progress (e.g., a legitimate polling read
of an external job whose status text is unchanged for five checks), raise the
thresholds, narrow the guard to read-only tools, or fingerprint a progress field
instead of the result text. If a provider starts rewriting tool results so
identical calls no longer compare equal, move the fingerprint to the
pre-truncation result.

## 2026-11-19 — The conversation shows the result and its grounds; the process moves to the audit

**Decision.** A conversation turn renders the owner's request, the result (the
reply, or the error with its owner-facing summary, next step and raw-error
disclosure), the runs the turn produced as 产物 rows, and one muted 依据 line:
how many tools the turn called (and how many of those failed) and how many runs
it produced, followed by a 查看审计 control. That control opens
设置 → 审计与轨迹 → 主 Agent 回合 filtered to this turn by its turn id and
conversation id. The 上下文 block (provider, model and effort; charter version,
tool table and material hash; history window; deterministic compactions) and
the 派发 block (every tool call with its input summary and duration) are removed
from the conversation. The audit keeps the assembly block, the tool list with
inputs and durations, and the history searches; the compaction summaries, which
only the conversation rendered, move into a new 上下文压缩 block there. The live
running card keeps its transient tool timeline while the turn streams; once the
turn settles, the entry is request, result, products and grounds. Task records,
approval and review cards, and the composer are unchanged.

**Why it won.** The owner's report came with a screenshot whose red box covered
exactly 上下文 and 派发: "不要显示的这么细了，这些在审计里显示就可以了，对话 query
只要产物，以及结论，都要有论据的，中间做了什么在审计显示就可以了". That is the
usability check the 2026-11-18 dispatch-log entry named as its reversal
condition. The conversation duplicated the audit on every turn: model, prompt
snapshot, tool table and every call's JSON input sat between the request and
the reply. Keeping a count and a link instead of the blocks leaves the
conclusion checkable while the reading column carries the product.

**Alternatives rejected.**

- *Collapse 上下文 and 派发 into `<details>` under the result.* The process would
  still occupy the conversation, duplicate the audit, and give the same facts
  two renderings.
- *Keep the tool table in the 依据 line.* Tool names are process; the audit names
  every call with its input and duration, which is where a diagnosis belongs.
- *Keep the request text as the link's search key.* The first implementation
  did: `entry.input` is up to 20,000 characters, so a long Chinese request
  overflows the server's 16 KiB GET header limit and returns 431, and the
  journal stores the request redacted, so a request containing a phone number
  or email matches nothing. The turn id is short, stable and searchable, and
  the conversation id keeps a reused id in another task out of the landing.
- *Drop the provenance line and show only the reply.* A conclusion would then
  have no path back to how it was reached; "都要有论据" is not met by prose
  alone.
- *Move the reply to the audit too.* The reply is the product; without it the
  conversation becomes a status feed.
- *Delete the turn log and return to chat bubbles.* The turn's status, error
  summary and produced runs still belong beside the answer.

**What was given up.** The model, prompt assembly and tool calls are one click
away instead of in place, and the 依据 line reports counts, not names. The audit
landing is a one-turn filter, not a search; the owner clears it to browse the
list. The conversation payload still carries the fields the audit uses; only the
render changed.

**Evidence.** The screenshot places the 上下文 panel (model, system prompt, tool
table) and the 派发 panel (four calls with JSON inputs and durations) above a
reply that already names what it checked. `audit.js` renders `assemblyBlock(turn)`,
`turn.toolCalls`, the reply and the turn's runs. `test/ui-structure.test.ts`
previously asserted 上下文 / 派发 / the model string / the charter line /
`dispatch_task` in the conversation markup; it now asserts they are absent, that
结果 / 产物 / 依据 and the audit control are present, renders `assemblyBlock` to
prove the compaction summary survives, renders `turnsView` to prove the tool
list survives, and pins the turn-id landing. A three-lens adversarial review of
the first implementation found the request-key failures, an unjournaled dead
link, focus and label gaps, and that the compaction summary had no audit home;
the shipped code fixes each. `npm test` **916/916**, `npm run typecheck` exit 0,
`npm run gate` **PASS**, baseline unchanged.

**Reversal condition.** If owners report that understanding an ordinary answer
requires opening the audit, or the filtered audit does not land on the turn,
restore one collapsed 过程 disclosure under the result — never the two full
steps — or give the audit per-turn anchors.

## 2026-11-19 — A request that dispatched no task is still a sidebar row

**Decision.** The sidebar lists every request the owner started. A conversation
whose visible task Runs exist is represented by those task rows, as before; a
conversation whose turns dispatched no visible task — a direct answer, a failed
or interrupted turn — becomes one row with `kind: "conversation"`, the latest
turn text as its title, and that turn's status and reply as its preview. The
fixed main conversation is never a row, and a hidden conversation stays hidden.
`buildDashboard` builds these rows from the turn ledger it already reads; the UI
stops filtering them out, marks them 对话, and opens them through the existing
conversation route.

**Alternatives rejected.**

- *Keep the tasks-only list.* This is what produced the report: 整理今天的工作信息
  was answered directly, so no Run existed, and the request vanished from the
  sidebar as soon as the reply arrived. Only a localStorage selection or a child
  record could reopen it.
- *List every conversation and its tasks.* One request would read as two rows.
  The conversation row represents the request; the task rows represent the work
  it dispatched.
- *Create a Run for a direct answer.* The Kernel deliberately refuses a one-step
  `direct_response` proposal, so "hello" does not become a task, a capacity slot
  and a worker launch.
- *Add a separate "requests" list.* Two lists lengthen the sidebar and force the
  owner to know which list a message lives in; the request is the natural unit.

**Evidence.** `buildDashboard` built `sessions` only from `taskRuns`, and
`renderSessions` filtered `kind !== "conversation"`. The turn for 整理今天的工作信息
exists in `main-agent-turns.jsonl` (conversation-a17fbdb8…, completed) with no
`run.created`; the dashboard returned nine task rows and no row for it. A
direct-answer turn creates no Run: `proposePlanToKernel` returns before
`acceptTrigger`. `test/companion-control-plane.test.ts` now expects both
direct-answer conversations as rows; `test/ui-structure.test.ts` pins that the
sidebar no longer filters conversations and marks them.

**What it costs.** The sidebar can grow one row per answered request; a
conversation whose latest turn failed keeps a failed status even when an earlier
turn succeeded; the row title is the last request, not a summary of the thread.
Hiding a run without hiding its conversation still leaves the conversation row.

**Reversal condition.** If answered requests make dispatched work hard to find,
group a conversation with its child tasks under one collapsible row or add a
filter; do not hide direct answers again.

## 2026-11-19 — A turn is an exchange: the owner on the right, the twin on the left

**Decision.** The main conversation log and 设置 → 审计与轨迹 → 主 Agent 回合 render
a turn as two sides: the owner's request is a right-aligned bubble; the twin's
reply is the left-hand section with its author, status, time and evidence below.
The audit's duplicated 140-character input preview in the card head and the two
same-looking `<pre>` blocks under 输入 and 回复 are gone. The 上下文 / 派发 / 结果
steps stay under the answer, and the audit's assembly and tool evidence stay in
the card below the exchange.

**Alternatives rejected.**

- *Keep the unified log card with the query as a clamped title.* That was the
  shipped design and the screenshot's complaint: with a long reply, the request
  and the answer shared one block and one text style.
- *Restore only the lost `.au-turn*` styles.* Those rules were dropped in an
  earlier merge, so two grey blocks were all that remained; spacing alone would
  still leave both voices in one left column.
- *Change only the audit view.* The screenshot was the audit, but the main
  conversation used the same stacking; two layouts would make the same turn look
  different depending on where it is read.
- *Put the reply in a bubble too.* The reply carries steps, tool rows and
  dispatched runs; a bubble cannot hold them without nesting cards again.

**Evidence.** The screenshot shows 输入 and 回复 as identical grey `<pre>` blocks
with the request repeated in the head. `audit.css` at HEAD had no `.au-turn*`
rules (they were deleted in the merge at 9e24cd8 / 2a3ac95). The main view kept
the query only in the `.log-query` head and the reply under 结果.
`test/ui-structure.test.ts` now pins the right bubble, the left answer, the
author overline and the audit's two sides; the old "not chat bubbles" assertion
was replaced.

**What it costs.** A turn is taller: request bubble, answer, then evidence. The
log is no longer a uniform card list, so export and print readers must learn the
two-sided grammar. The live composer and the settled server render must stay in
sync; both call the same two-side markup.

**Reversal condition.** If the owner asks for a compact single-column log again
(e.g. to compare many turns on one screen), add a density switch that collapses
the two sides into the old bordered card; keep the right-aligned request as the
default.

## 2026-11-19 — Folders are learned from use, not configured; today's changes come from the machine

**Decision.** "今天的工作信息" no longer depends on a folder setting or a worker
Run. The twin learns folders from the owner's own requests and from the tasks it
dispatched: a path is reduced to the folder that holds the project
(`~/work/knowledge_base/README.md` → `~/work`; a project under the noisy
`~/Documents` container → the project itself). The list is derived from the
persisted turn ledger and task events, so it survives restarts without a second
store, and the situation briefing carries it every turn. A new read-only Kernel
tool, `recent_file_changes`, lists files whose content changed since local
midnight (Spotlight on macOS, with a bounded directory walk elsewhere) plus each
Git repository's branch, uncommitted changes and commits. It defaults to the
learned folders and accepts a path only when the owner names one. The Main Agent
charter tells it to call the tool before claiming there is no work material.

**Alternatives rejected.**

- *Add a "work folder" setting.* The owner rejected this explicitly: work,
  study and other folders exist, and setting them one by one is unrealistic. A
  setting also cannot learn a new folder when the owner starts using it.
- *Point the files connector at `~/work`.* The connector is a declaration with a
  target; it reads only `.md`/`.txt` heads, returns at most 10 observations and
  has no Git or mtime view, so it cannot produce a change record.
- *Dispatch a read-only worker to scan the folder.* That was the old path:
  `context-researcher` failed with "completed step without evidence", the native
  worker has no shell/Git/mtime tool, and the reply became "no material". The
  Main Agent also cannot pass a worker's conclusion back.
- *Scan every known folder in the briefing.* Walking a 130 GB tree takes ~5 s;
  the briefing is compiled every turn. The tool scans on demand, and Spotlight
  answers the "changed today" query in ~0.13 s.
- *Auto-promote the folder list into the reviewed memory library.* Promotion is
  owner-governed; the learned list is a deterministic projection of the owner's
  own requests, not a model claim, so it stays in the briefing and the 情境 panel
  instead of becoming a review candidate.

**Evidence.** The turn 整理今天的工作信息 called only `get_situation`,
`search_history`, `get_authority` and `get_capacity`, and replied that it had no
material. The turn ledger and task events already contain
`/Users/qihoo/work/knowledge_base/README.md` (six requests); the new extractor
returns `/Users/qihoo/work`. Against the live machine, `recent_file_changes`
reports 9 files changed today under `~/work` and five repositories; Spotlight
answers in 0.13 s versus 5.2 s for a pruned `find` over the same tree.
`test/known-folders.test.ts` pins the reduction rules and protected-path
refusal; `test/recent-changes.test.ts` pins the change list, Git status and
protected refusal; `test/situation-briefing.test.ts` pins the briefing section.

**What it costs.** One mention can teach a one-off folder; it sorts by recency
and the tool caps at five folders. The list is per clone home and disappears if
the turn ledger and journal are deleted. The walk is bounded (8 s, 4,000
directories) and can miss files in an unindexed huge tree; Spotlight covers the
normal case. The tool reads file names and Git status, never file contents.
Running `git` in a folder is read-only but starts one process per repository.

**Reversal condition.** If learned folders are routinely wrong or noisy, add a
"forget this folder" action and require two mentions before a path is learned;
if the briefing grows too large, move the list to a tool result only. If the
tool leaks sensitive paths into a context the owner did not expect, restrict it
to folders named in the current request.

## 2026-11-19 — The installed window is the only UI; the browser preview entry is removed

**Decision.** Remove the browser preview surface end to end: delete
`.claude/launch.json` (its only configuration started `npm run companion:dev`
on port 4317), `scripts/companion-dev.mjs`, and the `companion:dev` npm script.
Keep `src/companion-server.ts` and the supervised `src/desktop-sidecar.ts`
loopback server, because the native window needs that port. The two archived
eval harnesses that started `companion-dev` now start
`src/companion-server.ts` with `CLONE_AI_PORT=$PORT` and their existing
`CLONE_AI_DATA_DIR`, so replay keeps its port and its isolated home. This
supersedes the preview fallback in the 2026-11-18 "Maintenance automation runs
in its own clone home" entry.

**Alternatives rejected.**

- *Keep the preview and add a banner.* The preview seeds the owner's providers,
  settings and MCP credentials and can execute tasks and approvals; a label
  makes the confusion visible but leaves a second real execution surface whose
  every run is invisible to the app. A banner is a mitigation, not a boundary.
- *Delete only `.claude/launch.json`.* `npm run companion:dev` would still start
  the same browser page by hand, and the docs would still promise that no
  browser preview exists. The entry point Claude sessions use is the one that
  made it appear without the owner's request; remove the surface, not just its
  shortcut.
- *Point the preview at `~/.clone` so its tasks appear in the app.* That is the
  two-writer collision the isolated home was introduced to prevent: on
  2026-11-18 an automation prompt held the Main Agent prompt lock for 149.9 s
  and rejected the owner's messages. Two UIs must not share one journal.
- *Keep a fixed-port server for eval replay.* The eval scripts need an HTTP
  server with a token and a home, not a browser UI. `src/companion-server.ts`
  already serves that and accepts `CLONE_AI_PORT`; tests use `port: 0`.

**Evidence.** On 2026-11-19 the owner was looking at `localhost:4317`, not the
app: three `companion-dev` servers launched by Claude sessions (4317, 4318,
4319) shared `.automation/preview`, while the desktop sidecar used
`127.0.0.1:58277` and `~/.clone`. The task `发送周报` existed only in the
preview journal (seq 18, created 2026-11-18T10:24Z) and not in the owner's
journal (0 matches in 1760 events), so the app could not show it; the approval
at 2026-11-19T02:10:58Z failed with "An isolated workspace cannot be created
inside the owner's live project", because the preview's workspace is the repo
itself. The preview was never a mock: it seeds the owner's config and can run
tasks and approvals. The owner had asked for this removal on 2026-11-18 (task
`0a563166`), but that run failed after 12 s with "Required input missing:
AGENTS.md" (owner journal seq 1548–1577). `apps/desktop/README.md` and
`docs/initial-runtime.md` already state that there is no supported browser
preview; the launch config contradicted them.

**What it costs.** Browser-pane UI verification is gone; UI work now uses
`npm run desktop:dev`, which opens the real `.app` against the live source.
Archived eval replays use the direct server entry. A session that calls
`preview_start` gets no server — the intended outcome, not a regression.

**Reversal condition.** If a class of UI bugs can only be reproduced in a
browser (not in the native WebKit window or `desktop:dev`), reintroduce a
preview as a separately homed, visibly labeled tool that refuses `~/.clone`,
serves only a test home, and carries a test that it never writes the owner's
journal. If a headless CI needs a UI oracle, add a `port: 0` test harness that
is not a product surface.

## 2026-11-19 — An Agent 协作 row opens the task record that owns it

**Decision.** A subagent row in the Agent 协作 card is a button when its run is
not the record being viewed: clicking it opens that run's task record, opens the
target record's own Agent 协作 disclosure and scrolls the matching row into view
once. Rows inside the run's own record stay plain text, because they are already
at the destination. The title underlines on hover and the button carries a focus
ring, matching the child-run rows in 派发. The conversation payload now carries
`runId` on each subagent so the row can address its record; a task record's rows
carry `runId === session.id` and remain unlinked.

**Alternatives rejected.**

- *Keep the rows as status text.* This is what the owner's screenshot showed: the
  main conversation listed three rows titled 准备本地交付物, two needing attention,
  and the only way to learn which task each belonged to was to scan the sidebar
  for an identical title. A status list without a destination forces the hunt the
  row already knows the answer to.
- *Open a dedicated subagent detail page.* A subagent is a work order, not a
  session: it has no run status, no approvals and no owner review of its own. A
  separate page would duplicate the task record and add a route that exists for
  one row.
- *Link to the run's journal trace.* The full trace is a diagnostic view; the
  owner's next action (see the evidence, review the result, retry the task) lives
  on the task record.
- *Make the whole card one link to the newest run.* The card aggregates several
  runs; a single destination would be wrong for every other row.

**Evidence.** The 2026-11-19 screenshot shows the Agent 协作 card in the main
conversation with three identical titles and no clickable affordance; the
sidebar holds the owning tasks under the same conversation but under different
labels. The session payload made the link impossible: `buildMainAgentConversation`
mapped subagents without `runId`, so the UI could not name a destination even
though `state.subagents` carries one. `buildSession` already had `runId` through
the source record, and its rows are all the record's own run.

**What it costs.** The session view grows one field per subagent; a click leaves
the conversation (there is no back stack — the sidebar's conversation row is the
way back); the destination record is forced open once, which is a deliberate
one-shot state rather than a new remembered disclosure. A subagent whose run is
hidden never appears in the card (the existing visibility filter), so no link can
land on a 404.

**Reversal condition.** If the Agent 协作 card gains an inline subagent transcript
(or subagents become first-class sessions with their own run records), the row
should open that detail instead of the parent task record; if hover links prove
undiscoverable, add a persistent chevron rather than more colour.

## 2026-11-19 — The transcript separates a turn, a task update and a child run by structure

**Decision.** The conversation log no longer renders every level as the same
bordered white card. A Main Agent turn is an exchange: the owner's request sits
above as a right-aligned bubble (recorded in the 2026-11-19 "A turn is an
exchange" entry), and the twin's answer below it is a ruled section — a hairline
top rule (2 px in a danger or warning tone when failed or interrupted), a small
author overline (`clone-ai` / `历史记录`), a status dot plus word and time on one
line, and the 上下文 / 派发 / 结果 steps on one 52 px label gutter. The
author/status/time strip is sticky inside its own answer section: while any part
of the answer is on screen, the reader still knows whose answer and which state
it is, and the next answer's strip replaces it. A turn that hands over to a
status note closes with a bottom rule, so the note cannot look attached to the
answer's tail. A 任务更新 is an indented margin note beside a 2 px rule — small
label, status, time, then text — with no fill, title or steps; its left rule
carries the state tone and the badge word stays authoritative. A dispatched child
run is a hairline row on a 1 px rail inside 派发, showing its id, a truncating
title and a tone-coloured status word; the whole row stays the button. Records
after the log (Agent 协作, 执行计划, 证据与产物, 本地执行轨迹, 核验结果) are
top-rule disclosures, not cards; the flattening is scoped to the conversation, so
a task-record view keeps its card grouping. The error block inside 结果 is the
only filled callout left in the transcript.

**Alternatives rejected.**

- *Keep cards and give each status a tinted header band.* This was the first
  implementation. It reduced the "everything is one white card" effect for turns,
  but a work update, a child run and a record still kept the same card chrome;
  the owner still had to read the title to know which level a block was.
- *Give the child runs their own badges instead of a rail.* A bordered, filled
  child row is exactly what made the nested dispatch look like sibling tasks.
  The rail and the status word establish containment; a badge adds back the
  chrome being removed.
- *Return the whole exchange to chat bubbles.* The answer carries steps, tool
  rows and dispatched runs; a bubble cannot hold them without nesting cards. The
  bubble is reserved for the owner's request, and the answer stays a section.
- *Collapse dispatched runs into a count.* It hides the openable task and hides
  which run failed.
- *Tint every state of every card.* A completed task would then compete with
  failures and waiting decisions; state salience belongs in the rule, the dot-word
  and the error content, not in four card fills.

**Evidence.** The owner's 2026-11-19 screenshot shows four blocks in one
viewport — a turn's tail, a 任务更新, the next turn and an Agent 协作 disclosure —
sharing the same 1 px border, near-white background, 9–14 px radius and shadow;
nested run buttons are also white bordered cards, so a child run is
indistinguishable from a sibling task. The complaint: "这里每次任务区分的ui设计
不清晰". The source matched the screenshot: `.log-entry`, `.log-entry--work`,
`.log-run` and `.activity-card` all used the same border, background and shadow
recipe. The revised design was checked in the browser preview at 1280 px and
640 px with a synthetic conversation containing a completed turn with two child
runs, a waiting-review update, an interrupted turn with an error and an expanded
record.

**What it costs.** A turn loses the container that used to clip hover and focus
outlines. The request bubble already separates the owner's voice from the
answer; the sticky author strip reserves about 25 px at the top of the scrollport
while any part of an answer is visible, and a pending decision dock sits above it
and covers it until the decision is made. The strip pins the author, state and
time, not the request text, so a long answer is identified by its opening bubble
plus the pinned author bar. The status pill becomes a dot plus word, so it is
visually smaller; the word remains, so colour is never the only carrier. The
margin note is intentionally quiet and can be missed in a fast scroll except for
its coloured rule, dot and word. Child rows rely on a full-row click target, a
7 px vertical padding and a hairline hover rather than a box; if they feel hard
to hit, raise the row height. Removing the activity-card fills also removes the
grouping those boxes provided; the top rule and the summary spacing replace it,
but only after the turn log — task-record views keep their cards.

**Reversal condition.** If owners still cannot tell where one answer ends in a
long transcript, add a bottom hairline to every answer or a faint section
background while keeping task updates as margin notes. If the pinned author
strip is not enough to identify a long answer, pin the request bubble within its
exchange or add a truncated request line to the strip. If the decision dock keeps
it hidden for long, move the strip below the dock. If child runs are missed or
hard to hit, increase their row height and restore a subtle hover fill. If the
`clone-ai` overline proves too terse, name the level there while keeping one
named level per block. If the request bubble plus the answer makes each exchange
too tall, collapse the context steps behind a disclosure rather than shrinking
the request.

## 2026-11-19 — A video attachment's frame comes from AVFoundation

**Decision.** For a video chosen through the native picker, the shell extracts
one 1280 px JPEG at 1 s with `AVAssetImageGenerator` on a background queue and
hands it to the page through `window.CloneNative.onVideoFrame`, keyed by file
name and size. The page's `videoFrame` uses that frame first;
it falls back to the existing HTML `<video>` path for drag/drop or paste, when
native extraction fails, or after a 1.5 s wait. The model still receives one
JPEG image, and the attachment payload shape is unchanged.

**Alternatives rejected.**

- *Keep the HTML `<video>` path.* WKWebView took 1.07–1.28 s for the same 8 MB,
  30 s, 1080p MP4 across loadeddata/metadata, seek target, no-seek and `toBlob`
  variants; the JPEG encode was only 10–19 ms, so media loading and frame decode
  were the cost. The native extractor took 152 ms first and 13–14 ms warm.
- *Defer the frame extraction to send.* The same ~1.1 s wait simply moves to the
  send path; the model still needs the frame.
- *Decode the frame with WebCodecs in JavaScript.* It would require an MP4
  demuxer and sample-table handling for a single frame; AVFoundation already
  owns that pipeline.
- *Use the native path for drag/drop and clipboard videos too.* Those `File`
  objects have no path the shell can open; the WebView path remains their
  fallback.
- *Lower the frame resolution or JPEG quality.* The encode is 10–19 ms; the
  resolution is not the bottleneck.

**Evidence.** A Swift/WKWebView harness measured the same 8 MB/30 s/1080p file:
HTML video 1,065–1,277 ms attach; variants 1,112–1,222 ms; encode 10–19 ms.
`AVAssetImageGenerator` with `maximumSize` 1280, preferred transform and JPEG
0.86 measured **152 ms first / 13–14 ms warm**, producing a 1280×720 frame of
164,786 bytes. The native frame is a 1 s still, like the HTML path's seek
target.

**What it costs.** Native code and a small JS bridge; the frame can differ
slightly from WebKit's (rotation is applied by AVFoundation; HDR and unusual
codecs may fail and fall back). Drag/drop or pasted videos still take the
WebView path. The JS waits up to 1.5 s for the native frame before falling back,
so a failed extraction does not block indefinitely. Keys use name/size/mtime;
two different files with all three equal would share a frame (rare). The frame
travels through `evaluateJavaScript` as a one-time data URL.

**Reversal condition.** If AVFoundation frames are rotated, tinted, or
unsupported for common owner videos, keep the native path only for formats it
handles and fall back for the rest; if the HTML path becomes fast, remove the
bridge. If the 1 s timestamp is wrong for very short videos, clamp it from the
asset duration before extraction. If the bridge's key matching proves fragile,
pass the selected URLs to the page explicitly instead of matching by metadata.

## 2026-11-19 — Audit usage enrichment is cached and bounded

**Decision.** The audit list caches the Magpie gateway's usage rows for 15 s per
endpoint/limit and, on a miss, waits at most 1 s for the optional enrichment
instead of 2 s. A failed or slow gateway caches an empty row set for the same
15 s instead of making every audit request wait; the audit still renders all
run records without usage.

**Alternatives rejected.**

- *Keep the 2 s timeout and no cache.* The live `/api/audit` endpoint measured
  2,290 ms on the first call, 404 ms on the second and 62 ms on the third; the
  gateway's `/v1/magpie/usage/requests?limit=500` returns 499 KB and measured
  429/57/21 ms, so every audit open re-fetched and re-parsed it on the request
  path. Opening 设置 → 审计与轨迹 could wait over two seconds for optional data.
- *Fetch usage only when the owner explicitly refreshes.* The first audit open
  would still block; it would also need a new UI contract and a second payload
  shape.
- *Drop gateway usage entirely.* It is the only token, cost and HTTP-error
  source for black-box workers; the audit's error samples come from it.
- *Cache until the journal changes.* The gateway usage changes independently of
  the journal (other clients use the same gateway), so a journal-triggered
  invalidation would serve stale rows indefinitely; a short TTL is bounded.

**Evidence.** Live audit list: 181 KB, 27 runs; `/api/audit` first/second/third
calls 2,290/404/62 ms. Gateway usage: 499,369 bytes; first/second/third calls
429/57/21 ms. The audit projection itself is about 60 ms; the gateway fetch and
its 499 KB parse were the dominant request cost. Unit tests cover the cache
(repeated calls fetch once), expiry and the bounded timeout with a hanging fake
fetch.

**What it costs.** Usage columns can be up to 15 s stale; during a gateway
outage or a slow response the audit shows no usage until the next TTL. The
audit remains complete without it; run records, verdicts, errors and traces are
journal-backed and unaffected. A 1 s timeout may omit usage on a gateway that
would have answered between 1 and 2 s.

**Reversal condition.** If owners need second-level usage freshness, lower the
TTL or add an explicit refresh action instead of extending the request path. If
the gateway is consistently fast, keep a shorter timeout; if 1 s omits real
usage too often, raise it or fetch usage asynchronously through a separate
endpoint. If another client starts writing far more gateway rows, lower the
limit or filter by the audit window rather than caching a larger payload.

## 2026-11-19 — The attachment panel opens without the sheet animation

**Decision.** The native attachment picker uses `NSOpenPanel.begin` (an
app-modal floating panel) instead of `beginSheetModal(for:)`, and the shell
constructs one throwaway panel with the same content types once after the page
is ready, so the first real click does not pay the cold AppKit/LaunchServices
construction. The `WKUIDelegate` still returns the selected URLs to the
WebView; file handling, drag/drop and the allowed content types are unchanged.

**Alternatives rejected.**

- *Keep the sheet.* Measured on the same offscreen window and content types, the
  sheet became visible in 385–394 ms after a warm construction; `begin` became
  visible in 112–133 ms. The ~270 ms difference is the sheet animation, and the
  owner's complaint is click latency.
- *Reuse one panel object for every click.* `NSOpenPanel` reuse is not
  documented and carries stale directory/selection state; a throwaway warm
  construction gives the same framework warm-up without reuse.
- *Warm by showing and cancelling a panel at launch.* After construction
  warm-up, a hidden show/cancel saved only ~15–30 ms over construction alone and
  risks a visible flash or focus steal; rejected.
- *Set a fixed `directoryURL`.* The first-panel cost was the same for `/tmp`,
  `~/Downloads`, `~`, and the system default (298–407 ms build, 597–607 ms
  visible); the directory was not the cause, and a fixed folder would override
  the owner's last-used location.

**Evidence.** A Swift/AppKit harness (same `allowedContentTypes`, offscreen
borderless window, Apple M5 Pro) measured: the first panel in a process took
298–407 ms to build and 597–937 ms to become visible with the sheet; after one
construction warm-up, 90–113 ms to build and 385–394 ms to become visible with
the sheet; `begin` took 96–113 ms to build and 112–133 ms to become visible. The
warm construction alone reduced the next panel's build to 96–111 ms. The
packaged app's absolute click-to-panel timing is not measured until the app is
rebuilt; the sheet-vs-`begin` difference is AppKit's sheet animation. The eval
is a committed harness, `benchmark/attachment-panel.swift`, plus a structural
test that the delegate uses `panel.begin` and the warm function.

**What it costs.** The picker is a floating app-modal panel rather than a sheet
attached to the window; the visual anchoring changes. The warm construction
blocks the main thread for about 300 ms once, scheduled 1.5 s after the page is
ready, so a click in the first 1.5 s still pays the cold build but already
benefits from `begin`. File selection time and the native panel's ~110–130 ms
appearance remain; a file dialog cannot be instant.

**Reversal condition.** If the floating panel feels disconnected, interferes
with full-screen or window management, or is less accessible than the sheet,
restore `beginSheetModal` and accept the ~270 ms animation. If the delayed warm
causes a visible startup hitch or catches a click, move the warm to attach
hover/focus or remove it. If a future macOS removes the sheet animation or
anchors `begin`, re-measure and keep the faster presentation.

## 2026-11-19 — Attachment clicks answer first; bytes stay behind the chip

**Decision.** Selecting a file returns to the composer immediately: a placeholder
chip is painted in the change handler before any bytes are read, and files are
prepared with a bounded pool of three readers instead of one serial chain.
Images are decoded once into a 240 px thumbnail that the chip and the live card
share; the original `File` is kept for the request. Image and PDF/`.docx` bytes
are then read in the background, after the chip exists, with
`Uint8Array.prototype.toBase64()` when the runtime has it and
`FileReader.readAsDataURL()` otherwise; no `data:` URL enters the DOM or the
item. A send awaits only the reads that are still in flight, and that await
overlaps the route decision. Text documents are read at selection because their
length decides the 50,000/100,000-character caps. The submit path waits for an
in-flight attachment batch and re-checks that the turn is not empty after the
wait, so a batch whose files were all rejected keeps the composer and its route
context. The failed-send path restores the attachments by identity inside the
four-attachment cap, a transient read failure stays retryable instead of being
cached, and a preview URL is not revoked while a connected live card still
displays it. `applyChrome` stops rewriting every
`[data-i18n]` node when the locale and strings did not change, the 3-second
refresh is skipped while a batch is being prepared and is single-flight, and
the post-turn refresh now runs after the stream slot is released instead of
being skipped and landing on an arbitrary tick. The server extraction path
stays sequential and in-process.

**Alternatives rejected.**

- *Keep eager data URLs (the previous behavior).* Four 5 MB images took 94 ms to
  attach and produced ~28 MB of `data:` markup that was parsed by `innerHTML`
  twice (composer chip and live card) and decoded at full resolution for 76 px
  and 120 px boxes. The live-card copy is discarded at the next refresh.
- *Defer every byte read to send time (the first version of this change).* It
  moved the 14–17 ms encode onto the send path instead of removing it, and a
  file moved, deleted or evicted by iCloud became a new send failure. Reading in
  the background after the chip keeps the click path free, makes the send body
  usually ready, and narrows the unreadable-file window.
- *`Promise.all` over the batch with slots reserved from file metadata.* Text
  document lengths and the shared 100,000-character budget are unknown before
  reading, and completion order is not input order; pushing results as they
  settle would reorder the chips, the request array, the reports and the
  audited manifest. The ordered prefetch keeps the sequential checks exactly.
- *Parallel extraction of binary documents on the server.* The sidecar is one
  Node thread, so concurrency adds interleaving, not cores: four real PDFs took
  273 ms sequentially and 356 ms with `Promise.all`. The budget arithmetic also
  depends on order (`cap = min(50,000, remaining)`, the truncation marker counts
  toward `remaining`, and `remaining` may go slightly negative), so a parallel
  allocator can silently change the model message and the ledger manifest.
- *Page-level PDF fan-out.* Concurrent `getPage`/`getTextContent` calls on one
  `unpdf` document throw `DataCloneError` from its loopback port; the parser is
  not safe for concurrent page access in this build.
- *Worker threads or child processes for PDF text.* The macOS app ships the
  source tree and a Node binary, but the Windows sidecar is bundled with
  esbuild and `pkg`; a worker would need a second packaging path on one
  platform and a fallback on the other. The realistic gain is also after the
  send, not on the click: four in-cap PDFs measured 232 ms sequentially and
  134 ms with four workers, while a single PDF gains nothing. That is below
  model-latency noise for this change.
- *Parallel OCR in the native helper.* A 20-page scanned PDF took 2.34 s
  sequentially and 2.10 s with four concurrent pages (~10%), while rasterized
  pages multiply peak memory and PDFKit/Vision concurrency is not documented as
  safe. The helper also cannot run inside `npm test`, so the change would have
  to ship "assumed".
- *Defer text-document reads too.* The 2 MB cap rejects before reading, and a
  2 MB read measured 2 ms; its length is required for the per-document and
  total character checks.

**Evidence.** In Chromium, attaching four generated 5 MB PNGs took 94 ms with
the old serial data-URL path and 3 ms to create the ordered object URLs before
any read; the background encode of the same four files took 14–17 ms. Four
12 MP photos produced 240 px thumbnails in 36–58 ms concurrently, 2.5 KB each
instead of a 2.4 MB data URL and a full-resolution decode in a 76 px chip. The
UI survey measured four full-resolution data-URL previews at 115.8 ms of
`innerHTML` insert and a 270.8 ms maximum main-thread gap, versus 2.5 ms and
18.2 ms for the same images as blob URLs. A real 8 MB MP4 frame took 561 ms on
first attach; four in-memory copies took 174 ms sequentially and 102 ms
concurrently (timings noisy). The client survey measured
`Uint8Array.prototype.toBase64()` in the system JavaScriptCore at 0.56 ms for
5 MB (assumption: the desktop WebView exposes it; the code feature-detects and
falls back). Code review found three real races: the four-attachment cap is
checked before an `await` and the push after it, `createSession` clears the
composer before pending reads finish, and a failed send drops the attachments;
the review also found that caching a rejected payload made a transient read
failure permanent. The deterministic eval is `test/attachment-client.test.ts`
(concurrency and the global three-reader bound across overlapping batches,
input order, cap and budget semantics, chip-before-read, one background encode
per binary/image, payload reuse across requests, the FileReader fallback,
payload accepted by the real `parseAttachments`, attachment retention on
failure, a retry after a transient failure, failed-send restore within the cap,
and a connected card keeping its preview). A committed VM benchmark
(`benchmark/attachment-client.ts --old-ref 4f0149e --runs 3 --read-ms 10`)
reproduces the strategy difference: four 5 MB images went from 68 ms of serial
attach work, four `data:` previews and 28 MB of preview markup to 0 ms of
attach work, four `blob:` previews and 704 bytes of markup, with four
background encodes; the mixed batch went from 58 ms to 12 ms. Browser timings
are manual measurements, not a committed benchmark, and are labelled
approximate.

**What it costs.** The base64 payload is held from attach until the turn ends,
bounded by the same four attachments and 10 MB per binary; the previous path
held the payload plus a second `data:` URL copy. A file must remain readable
while the background read runs; if it was moved or deleted, the send fails with
the attachment name and the attachments are restored so the owner can retry.
The 240 px thumbnail loses full-resolution inspection and GIF animation in the
composer and live card; the model still receives the original bytes. A video's
placeholder remains "读取中…" until its frame is decoded. Blob URLs live until
the attachment is removed or the live card is replaced, then are revoked; all
remaining URLs are revoked on unload. Scanned PDFs still pay the native OCR
time at send; the native file panel was not measured and may be the owner's
actual click delay. Chromium numbers are not WKWebView numbers.

**Reversal condition.** If profiling in the packaged app shows the native
`NSOpenPanel` or server extraction dominates the wait, stop optimizing this
path and write a trade-off for that layer. If four large binaries held as
base64 pressure memory, defer the read to send time and accept the smaller
unreadable-file window. If send-time encoding becomes visible (roughly >100 ms)
or fails on slow volumes, pre-encode in an idle callback and cache the result.
If the target WebView lacks `createImageBitmap` resizing, keep the object-URL
fallback or remove thumbnails. If four large images at three-way preparation
pressure memory, lower the pool to one or two. If scanned PDFs become a common
input, revisit OCR with a varied multi-page fixture and a bounded worker model,
and record the benchmark.

## 2026-11-19 — A Main Agent can retrieve across task conversations

**Decision.** Keep multiple Main Agent instances — the same identity, one per
task conversation — and give each one a global retrieval tool. Automatic context
stays scoped to the current conversation; `search_history` searches every
conversation by default, tags each result with its conversation id and time, and
records the query, scope and hits as `main_agent.history_searched`. The tool can
still be narrowed to the current conversation. The prompt tells the agent it is
the same twin as in the owner's other tasks, with its own conversation here.

**Alternatives rejected.**

- *One serialized Main Agent that searches history and assembles context for
  every request.* It makes every turn wait behind the longest turn and turns
  context assembly into a retrieval/budget subsystem that must be right before
  the agent can work. The owner chose the multi-instance model (B) on 2026-11-19.
- *Inject all history into every prompt.* It is unbounded, mostly irrelevant,
  and makes the prompt change on every task.
- *Keep search scoped to the current conversation.* A fact established in one
  task is then invisible in another unless the memory pipeline promoted it; this
  is the fragmentation the owner is trying to solve.
- *Memory-only sharing.* Reviewed memories are durable facts, not the reasoning
  and decisions in earlier conversations; retrieval is the only way to recover
  those without promoting everything.

**Evidence.** The native `search_history` filters the ledger to the current
`conversationId` (`searchLedger`), so a task cannot see another task's turns;
the ledger already stores every turn with its conversation id, so provenance is
free. `readMainAgentTurnRecords` and the existing tokenizer provide the search
base. The owner's 2026-11-19 decision: add global retrieval, keep B (multiple
per-thread instances), and treat context assembly as an ongoing problem rather
than a reason to serialize.

**What it costs.** Retrieval quality becomes part of every cross-task lookup:
the terms the model chooses determine what it recovers, and a miss looks like
absence. Results consume prompt tokens (bounded by limit and excerpt size).
Cross-task context can blur boundaries if the model treats another task's
instruction as this task's; results are labelled as records, not instructions.
The ledger search does not rank by semantics, only by term overlap and recency.

**Reversal condition.** If cross-task retrieval routinely mixes goals or pulls
the wrong task's instructions in, restrict the default to explicit queries and
add a thread-summary tool instead of raw excerpts. If retrieval misses dominate
the owner's corrections, add semantic/embedding search or thread summaries. If
the single serialized Main Agent is adopted later, this tool becomes its base
and the multi-instance locks are removed.

## 2026-11-19 — One new-request action; Clone AI routes to a Main Agent

**Decision.** The desktop exposes one "新请求" action instead of asking the owner
to choose between a new conversation and a new task. Typing inside a
conversation stays with that conversation's Main Agent. A new request is routed:
a explicit continuation cue ("继续", "刚才", "上次", "这个任务", "continue", "that task")
reuses the selected conversation, or the most recent one when nothing is
selected; an explicit new-goal cue ("新项目", "另一个任务", "new project") or no
context starts a new Main Agent; an ambiguous request with a selected
conversation asks the model for a continue/new decision, and fails open to a new
Main Agent when the model is unavailable. Every decision is journaled as
`conversation.routed` with its reason and source, shown in the audit's assembly
block. A task record names the Main Agent that dispatched it and offers a button
to open that conversation.

**Alternatives rejected.**

- *Keep separate new-conversation and new-task controls.* That is the current
  learning cost: the owner must know which concept creates a Main Agent.
- *Always start a new Main Agent.* Every follow-up would lose the context it
  refers to and fragment the owner's memory.
- *Always reuse the previous Main Agent.* One context would grow without bound
  and unrelated tasks would read each other's history.
- *Rules only.* Keyword cues handle "继续上次" but not "把这个方案再改一下" versus
  "另一个项目也这样做"; the router needs semantics for the ambiguous middle.
- *A model call for every message.* The explicit conversation selection already
  answers most messages; charging a routing call for them buys nothing.

**Evidence.** The owner's request on 2026-11-19: the new-conversation/new-task
choice is too much to learn, and Clone AI should decide whether to use a new or
the previous Main Agent. The plumbing already exists: `conversationId` scopes
the lock, history and slot (`src/application/run-main-query.ts`), and
`mainAgentRunConversations` maps a dispatched run back to its conversation, so
the router and the task-record line need no new storage. The model router fires
only for an ambiguous new request with a selected conversation.

**What it costs.** An ambiguous new request costs one extra model call (bounded,
temperature 0, short output), and a misroute is visible in the audit but cannot
be moved automatically; the owner resends inside the intended conversation.
Keyword cues are a heuristic and can misfire. Explicitly typing inside a
conversation bypasses the router entirely, which is the escape hatch.

**Reversal condition.** If misroutes are frequent or the extra call is
unwelcome, make the router rules-only or restore an explicit "new Main Agent"
control; if owners want full manual control again, revert the UI action while
keeping the journaled routing decision and the task-record dispatch source.

## 2026-11-19 — The Agent settings page is a catalog, not a control panel

**Decision.** Settings → Agent shows the Magpie gateway's detected state and
model picker, then a read-only list of the four built-in workers with the role
and what each one does. The manual endpoint/API-key form, the local-provider
registry list, and each worker's provider select and enable switch are removed.
The gateway card also drops its model-count, version and API-path badges; the
model picker already names what the gateway serves, and the status badge says
whether it is online.

**Alternatives rejected.**

- *Keep the manual endpoint and API key as a fallback.* The gateway probe
  already discovers the loopback endpoint, and "use this model" persists it
  before a turn can run (`src/companion-server.ts:1154-1158`). Manual entry
  duplicated a value the app writes itself, and the owner asked to use Magpie
  only.
- *Keep the provider select.* `src/workers/provider-catalog.ts` registers a
  single provider, `native`; `normalize()` maps any saved id it no longer knows
  back to `native` (`src/config/worker-settings.ts:154-177`). The live
  `settings.json` still names `claude-code` for every role, which the runtime
  never uses — the control showed a choice the runtime does not honor.
- *Keep the enable switches.* All four defaults are `enabled: true`, and
  `direct-responder` is `required`. The owner asked for every worker to be on;
  a switch implies a policy choice the product no longer offers.
- *Keep the provider list.* `GET /api/agents` synthesizes one row
  (`src/companion-server.ts:1510`), so it restates the worker catalog with an
  install state that can never change.

**Evidence.** The provider registry has one entry; every default profile is
enabled; the live `~/.clone/settings.json` has every role enabled (with stale
`claude-code` provider ids that normalize to `native`); the endpoint in
`~/.clone/config.json` was written by the gateway apply path. `app.js` no
longer renders `config-base-url`, `data-agent-provider`, `data-agent-toggle`,
`gateway-details` or the API badges, and a UI surface test asserts their
absence.

**What was given up.** A non-loopback or custom gateway endpoint can no longer
be entered from the window (it can still be set through `/api/config` or the
environment), a role can no longer be individually turned off, and the
gateway's version and supported API surfaces are no longer visible at a glance.

**Reversal condition.** Restore the matching control if a second execution
provider is registered, if roles need independent disabling for cost or policy,
or if Magpie cannot discover an endpoint the owner needs and manual entry
becomes the only way to point the app at a model gateway. Also restore the
badges (or put them behind a disclosure) if diagnosing an API compatibility
problem requires seeing the version and surfaces inside the app.

## 2026-11-19 — Publish readiness before the first maintenance pass

**Decision.** `startCompanionServer` binds its loopback port and publishes
`companion-endpoint.json` before the first background maintenance pass runs.
The pass starts immediately after the endpoint is published, fire-and-forget,
with its failure logged and retried by the existing five-minute interval. The
window no longer waits for memory extraction, commitment reconciliation,
opportunity scanning, or any other periodic work before it can connect. Inside
the pass, work that does not need the extraction lock runs first — commitment
reconciliation, then the opportunity scan, the legacy candidate cleanup, the
improvement sweep, the idle/expiry sweeps and the bad-case report — and the
extraction and conversation drains run last. The governance-lock steps follow
the scan, so they can still wait on the governance lock without delaying the
opportunity cards. One shutdown controller is shared by the maintenance pass,
the governance operations its sweeps use, the in-process lock queue, and a
scheduled run's post-run extraction; `close()` aborts it before waiting, so
shutdown completes while another process holds any of those locks. A run that
is already executing and an extraction that already holds its lock are never
cancelled.

**Alternatives rejected.**

- *Keep awaiting maintenance (status quo).* The pass acquires the
  cross-process memory-extraction lock, whose `BEGIN IMMEDIATE` retries every
  50 ms with no deadline (`src/core/workspace-lock.ts:56-64`). One held lock —
  another sidecar mid-extraction, or a miner waiting on a model — turns
  "startup is slow" into "startup never finishes"; the daemon is alive but
  never listens, and the desktop shell stays on 正在连接.
- *Keep the old order inside the pass.* The opportunity strip and attention
  list are the maintenance output the owner sees on first paint. Running the
  scan after the extraction drain leaves them empty for as long as the lock is
  held — the exact reversal condition this decision must avoid.
- *Put a timeout around `startMaintenance()`.* The timeout cannot cancel the
  lock wait; it only abandons the promise while the retry loop keeps running,
  and the threshold is arbitrary. It also leaves readiness coupled to work the
  window does not need.
- *Make lock acquisition time-bound instead.* That changes cross-process
  serialization semantics for every caller, and a legitimately slow miner would
  still delay readiness.
- *Move the whole assembly after `listen`.* Much larger: every request handler
  needs the journal, config and governance already constructed. The maintenance
  pass is the only pre-listen step whose duration is unbounded by its inputs.
- *Leave `close()` waiting on the blocked pass.* Because the pass now starts
  after readiness, the shell's SIGTERM handler enters a close that may never
  resolve; the only bound would be the shell's SIGKILL. Aborting the lock wait
  is the narrow way to keep shutdown graceful.

**Evidence.**

- Live: the launchd job `ai.clone.companion` ran PID 80762 from 2026-11-18
  17:53:26 until 2026-11-19 09:45 (15 h 51 m) with no listening socket
  (`lsof -nP -p 80762 -iTCP -sTCP:LISTEN` printed no line for it) and no
  `~/.clone/companion-endpoint.json`; the desktop window was showing
  "正在连接常驻运行时". The same log holds repeated
  `Scheduled dispatch failed; its outcome needs review — database is locked`
  entries, consistent with lock contention.
- Deterministic reproduction: an isolated copy of the real clone home with the
  eight `memory.candidate.extracted` / `memory.candidate.proposed` rows deleted
  (so eight `memory.candidate.requested` are pending) and a holder process
  holding `BEGIN IMMEDIATE` on
  `<home>/memory-extraction-lock/.clone/workspace-execution.sqlite3`. The
  sidecar printed no `CLONE_AI_READY` within 15 s; with the lock free the same
  home reached ready in 246 ms. Mechanism: `await startMaintenance()` sat
  before `server.listen` and `persistCompanionEndpoint`
  (`src/companion-server.ts:605` vs `:681` and `:694`), and `processJob` takes
  the extraction lock (`src/memory/memory-pipeline.ts:176`).
- Independent review of the first version of this change (readiness moved, old
  pass order, no abort) verified two gaps with probes on a temp home with the
  lock held: `/api/opportunities` returned **0** cards until the lock was
  released, and `close()` was still pending after 2 s. Both are now pinned in
  `test/companion-startup-readiness.test.ts`: the deadline card is present
  while the lock is held, and close returns in under 2 s without releasing it.

**What it costs.** The abort ends waits, not work that already holds a lock: a
shutdown during a miner call still waits for that call (the shell bounds it with
SIGKILL), and a scheduled run that is executing is not cancelled — only its
queued extraction gives up, staying journaled for the next start. An approve,
review, or scheduled run that calls `processNext` while the first drain holds
the lock waits for the current extraction, as with any periodic pass; this
change makes the largest drain overlap the first requests. The scan is ordered
before the drain so the first paint is not affected.

**Reversal condition.** Reverse this if a request served before the first pass
completes starts returning observably stale state the owner can see on first
paint — for example unsettled commitments or a missing opportunity card — and
the fix is not to have that specific route await `startMaintenance()`. Also
reverse if lock acquisition becomes bounded and measurements show the first
pass is fast enough that waiting for it buys visible freshness at startup.

## 2026-11-18 — A direct answer is the evidence for a direct_response step

**Decision.** A single-agent step whose `requiredCapabilities` include
`direct_response` must be able to complete on the worker's final answer. The
native worker records exactly one `observation` evidence row for that answer — a
bounded summary and a step-scoped locator such as `answer:<stepId>` —
immediately before pushing `completed`, gated on `produced.size === 0` so a real
read is not duplicated. The evidence gate for every other step stays untouched,
and the Kernel must not synthesize evidence the executor did not produce. The
change came from the gated repair lane (AGENTS rule 4); the working agent
applied the lane's patch and functionally verified it, and did not hand-write
the logic.

**Alternatives rejected.**

- *Exempt every single-agent step from the evidence assertion.* A
  `context-researcher` read step that answers in prose would pass without
  reading anything; b1e04b18 is the case that must still fail.
- *Synthesize the observation in the Kernel.* Evidence would no longer be the
  executor's claim; the journal invariant that a worker cannot mark its own work
  done without a produced row would be a comment.
- *Leave the gap open.* A direct answer would keep failing after the model has
  already answered, which is the status quo that put this on the list.

**Evidence.**

- Run `b1e04b18` (2026-11-18) is an answer-only single-agent step: one model
  call, zero `agent.tool_started`, zero `evidence.recorded`, then
  `execution.completed` and `execution.failed` with `Agent context-researcher
  completed step read-readme without evidence.` The direct-response variant is
  latent — no `direct_response` plan exists after the native switch — but the
  same gate is reached by any answer-only step.
- A deterministic current-code reproduction (`53074cf2`, isolated home) uses a
  `NativeAgentWorker` whose fake client returns only `收到`: the run fails with
  `Agent direct-responder completed step direct-response without evidence.` The
  trace is `/tmp/clone-ai-repair-trace-home2/failed-traces/53074cf2-….json`.
- The repair lane was run with that trace and the decision brief above. The
  first attempt stopped at the red-eval gate because phase 1 read the trace and
  wrote no test (`I couldn't write a reliable regression test without inspecting
  the executor's API within the prescribed tool-call limit`); the lane also
  ran every existing regression file, so it reported "not-red" instead of
  "no test". The phase-1 prompt was widened to name `src/core/runtime.ts` and
  `src/workers/native-agent-worker.ts`, allow the first write within eight tool
  calls, and the red/green checks were scoped to this repair's new file.
- The second attempt produced a correct 3-line worker change but failed the
  full suite on `bilingual-documentation` (an English-only source comment); the
  fix-phase prompt now requires the English and Chinese lines together. The
  third attempt succeeded: phase-1 Run `566b1603` was red on
  `test/regression/direct-response-evidence.test.ts`, fix Run `1d811b94`
  produced the observation row, the regression case was green, the full suite
  was **760/760**, and typecheck exited 0. Branch
  `rsi/auto-fix-20261118T1044`, commit `76aec5d`; the working agent applied
  the patch to the shared tree and re-ran **832/832**, typecheck 0 and
  `npm run gate` **PASS**.

**What it costs.** A direct answer now reaches `waiting_review` instead of
failing, so the owner must accept the answer; the observation row is the
worker's own text (bounded to 8,000 characters), not an independent artifact.
The case is a new file under `test/regression/`, and the lane still owns the
patch: the working agent applied it and checked functional correctness only.

**Reversal condition.** If `direct_response` steps are shown to be unreachable
in production, delete the observation row rather than keeping dead evidence. If
owners routinely reject direct answers because the observation row is not an
independent artifact, require a tool result or move the answer to the
conversation path instead of the evidence gate.

## 2026-11-18 — A read-only request gets observation evidence, not an artifact

**Decision.** The fallback planner distinguishes a read-only or analysis request
from a delivery request. A read-only task gets one read-only executor step (the
context researcher when enabled) and no artifact contract; a research or review
work order inside a mixed plan requires `observation` evidence. An explicit
read-only constraint outranks a bare artifact noun: only a positive write verb
or a named output target makes the request a delivery. A delivery request keeps
the `artifact` contract. A work order may only require evidence its own risk can
produce: a `read_only` order may require `observation` or `tool_result`, never
`artifact`, `receipt` or `test`, and the Kernel rejects such a plan when it is
attached instead of discovering the contradiction after the worker has finished.
A Kernel-rejected plan fails its Run rather than leaving it in `planning`. The
worker is told the required contract (id, kind, locator requirement and
description) and that a read records observation evidence while a write records
artifact evidence. Evidence recording now keeps artifact rows when the 20-row
cap is applied and lets a write upgrade a path that was already read; the worker
also filters its tools by the work order's risk, not only the parent step's.

**Alternatives rejected.**

- *Let the verifier accept observation evidence for an `artifact` contract.* The
  contract would stop meaning "a durable file exists"; every delivery would pass
  on prose, and the owner would stop having a file to review.
- *Tell the worker to write the artifact even though the objective forbids
  writing.* The tool gate checks grants, not prose: the worker would either
  disobey the owner or still fail, and verification matches only kind plus a
  non-empty locator, so any file would satisfy the contract. The contradiction
  belongs to the layer that emitted both the contract and the prohibition.
- *Leave the worker to fail and ask the owner to retry.* This is the status quo
  that produced the three failed runs below: each worker had already finished
  the requested read and answer before verification rejected it for a file the
  owner had explicitly forbidden.
- *Remove artifact contracts altogether.* A genuine delivery request — a draft,
  report, model or code change — still needs a durable file, otherwise the
  direct responder's text becomes the "deliverable" again.

**Evidence.**

- Journal `~/.clone/journal.sqlite3`, 2026-11-18: runs `663b45b5`, `c03c7cea`
  and `cd74804b` all carry a fallback plan with a `draft` work order whose
  required contract is `local-draft` (`kind: "artifact"`,
  `locatorRequired: true`), while the objective says "不要修改任何文件" or
  "不要修改任何文件或运行产生副作用的操作". `evidence.recorded` contains only
  `observation` rows (one README read in `c03c7cea`/`cd74804b`; 20 of 33 tool
  calls in `663b45b5`), and `subagent.verified` fails with
  `Missing required artifact evidence: local-draft.` The same three requests
  reproduce deterministically with
  `node --experimental-strip-types --input-type=module -e "import {buildFallbackPlan} from './src/planning/fallback-planner.ts'; …"`
  before this change: every read-only query yields `draft/local-draft` with
  `kind: "artifact"`.
- The cause is in the fallback classifier: `项目`, `代码` and `文件` were
  delivery terms, there was no read-only marker, and `needsDelivery` was also
  true whenever `needsResearch` was true (`src/planning/fallback-planner.ts`).
  A request to review a project's code therefore became a request to write a
  file.
- The research and review contracts had the same mismatch even without an
  explicit read-only instruction: `context-note` and `review-note` were
  `kind: "artifact"`, while the native worker only records `observation` for a
  read (`src/workers/native-agent-worker.ts`, `agentTool`).
- The native worker never received `expectedArtifacts`; `buildInstructions`
  sent only the objective, workspace, boundary rules and acceptance criteria.
  A worker could therefore finish legitimately without knowing the Kernel would
  require a locator-bearing artifact.
- The evidence cap and the first-kind-wins map are part of the same failure
  surface: a worker that reads a path and later writes it keeps `observation`
  for that path, and a write after more than 20 reads can be dropped by
  `slice(0, 20)` before verification.
- The five "Required input missing" failures and the one "12-round limit"
  failure from earlier on 2026-11-18 are not evidence for this decision: they
  predate `fb496e5` (only a work order's declared required inputs can fail a
  step) and `e694a4d` (only an absence-shaped read marks an input missing), and
  `bba7896` (no default round cap). The "README is outside the workspace"
  failure is addressed by the working-tree file-tool `resolve` change, not by
  this entry. The missing-input regression file is a `.js` test, which
  `npm test` did not collect; the script now includes
  `test/regression/*.test.js`, so the eval guards the suite.

**What it costs.**

- A read-only request no longer produces a file. A request that does want a
  report or draft must say where to write it (or use a delivery verb); the
  fallback's heuristics can still misclassify an edge case, and the Kernel
  rejection is the backstop rather than a model judgment.
- A main-agent plan that pairs `read_only` with an artifact contract now fails
  at attach time. That is earlier and clearer than a failed run, but it is still
  a planning error the Main Agent must correct.
- The read-only worker is actually restricted to read tools; a work order that
  was previously read-only in name but write-capable through its step can no
  longer write. Any legitimate such work order must raise its own risk.
- `observation` contracts are weaker than a file: they prove a read happened,
  not that the requested analysis is complete. The owner review remains the
  check for content.

**Reversal condition.** If real journals show read-only or analysis requests
routinely needed a file the owner wanted, add an explicit write target to the
classifier instead of restoring a blanket artifact. If more than a fifth of
read-only requests are misclassified in practice, replace the heuristic with the
LLM planner or a model-based intent classifier. If owners repeatedly reject
review results because no file exists, add a separate "write the review to a
file" follow-up plan rather than making every read-only task an artifact task.

## 2026-11-18 — The task record is the unit: no conversation rows, decisions on the task

**Decision.** The sidebar lists only dispatched task runs. Main Agent
conversations — the owner's main thread and the per-task conversations
introduced earlier today — are not list rows: the main thread opens from a
navigation control, and a task's conversation is where a message sent from that
task record goes. Approvals and reviews render and are decided inside the task
record that owns the run; the main conversation no longer aggregates decision
cards. A waiting task is pinned in its own "需要你的确认" sidebar section, carries
an explicit `需你确认` / `需你复核` badge, and its decision dock names the step and
asks for the decision.

**Alternatives rejected.**

- *Keep conversations as rows and hide only the main one.* The per-task
  conversations would still read as chats in a task list, and the owner
  explicitly asked for dispatched tasks only.
- *Keep decisions centralized and strengthen the pointer.* The pointer sends the
  owner away from the run they are reviewing; with the conversation no longer
  listed, the destination is not even in the sidebar.
- *A second "conversations" list beside the task list.* Two navigation surfaces
  for one chat is more to keep current, not less.

**Evidence.** The owner's request on 2026-11-18, after the per-task
conversations shipped: only dispatched tasks in the list, and each subtask's
confirmation in its own record. The prior decision ("Approvals live in the main
conversation", commit `b810879`) was made when one thread was the only context
and the conversation was listed; that premise no longer holds. `buildSession`
already returns the run's own approval (`waiting_approval` + `activeStepId`) and
its verification, so the task record has the data;
`/api/runs/:id/approve|reject|review` already accepts any run id.
`test/ui-structure.test.ts` pins the old pointer and is rewritten.

**What it costs.** Decisions can be spread across tasks; the owner must open the
waiting task instead of one inbox. The dashboard still counts waiting approvals
across runs, but there is no single card list. Conversations are not browsable
from the list: the main thread has a nav control, and a task's thread is reached
by sending from its record. The old conversation delete/restore path remains in
the API but is no longer exposed.

**Reversal condition.** If owners lose the conversation thread or want to switch
among several conversations, add a compact, separate conversation section —
never mixed into the task rows. If decisions in task records are missed, add a
global decision inbox that deep-links into each task; do not move the cards back
to a central thread.

## 2026-11-18 — The audit explains how every Main Agent turn was assembled

**Decision.** Each turn record in 审计 → 主 Agent 回合 shows an assembly block: the
conversation, the history window (messages and completed turns, compactions), the
model and effort, the prompt materials (charter version, briefing present or
absent, instruction sources and warnings, the tool table), and the runs the turn
dispatched with their plan steps and statuses. The history counts and
instruction sources are journaled with the turn; run titles, steps and statuses
are projected from the existing task, run and plan events.

**Alternatives rejected.**

- *Show only the prompt hash and the snapshot locator.* The owner cannot see the
  assembly without opening a content-addressed file; the question was "how was
  this task assembled", not "where is the file".
- *Paste the full system prompt into the audit.* It is large, largely unchanged
  between turns, and the snapshot remains the source of truth.
- *Show only the tools the model called.* The tool list is what it did; the
  assembly is what it was given before it decided.

**Evidence.** `/api/audit/turns` already projects input, reply, tool calls,
compactions and prompt-snapshot hashes (`src/audit/turn-audit.ts`), and the audit
UI shows the tools plus a `prompt <hash>` chip. It drops the snapshot's
`instructionSources`, never records the history window, and shows only a count of
spawned runs — the three pieces the owner asked for are exactly the missing
ones. `buildHistory` already knows the history it assembled; `task.created`,
`run.created`, `plan.created` and `run.status_changed` already carry titles,
steps and statuses.

**What it costs.** Two fields on `main_agent.turn_started` (`historyMessages`,
`historyTurns`), and the projection joins run events by id. A turn whose snapshot
failed shows no materials; a legacy turn without the fields shows "未记录". The
block is collapsed by default so the turn list stays readable.

**Reversal condition.** If the assembly block duplicates the prompt-snapshot
detail page, keep only model, tools and dispatch in the summary and link to the
snapshot; if the journal or projection cost becomes material, derive the counts
from the snapshot or a separate assembly event.

## 2026-11-18 — A finished task is not a memory; candidates must state durable knowledge

**Decision.** Task-run memory mining no longer proposes a candidate by copying the
parent task's objective. `MemoryPipeline`'s default worker extracts nothing:
without a configured miner, a completed task produces zero candidates and its
`memory.candidate.extracted` event records `count: 0`. With
`CLONE_AI_MEMORY_MINING=all`, the model miner still runs. Independently of which
worker produced them, `MemoryPipeline.processJob` drops any **untyped or
`procedure`** candidate whose summary is its task objective. The comparison runs
NFKC, a locale-independent lowercase, invisible-character removal, token-aware
punctuation folding, and procedure-label stripping at either end (`候选流程`,
`流程`, `candidate procedure`, `procedure`). A typed preference, fact, decision
or commitment is kept even when it equals the objective, because the owner may
have stated exactly what the task asked for. The extraction event records
`droppedRestatements` and the PII-redacted dropped summaries when any were
dropped. A one-time governance pass rejects pending candidates
that match the same rule against the task recorded for their run, with a
journaled reason. Conversation mining gets its own pipeline and worker instead
of borrowing the task pipeline's.

**Alternatives rejected.**

- *Keep the deterministic worker and hide or demote its candidates in the UI.*
  The summary is still a work order, not knowledge; hiding it changes where the
  noise appears, not what it is. The live journal shows the list was 7/7
  restatements (below).
- *Copy evidence summaries instead of the objective.* Evidence is a worker's
  claim about what it did, not an owner statement or a standing fact, and it is
  less controlled than the objective. It would still be a run log with a
  different wording.
- *Fix only the mining prompt.* Prompts are advisory; the shipped placeholder is
  proof a producer can ignore them, and a model can echo the objective too. The
  refusal has to be structural.
- *Remove the candidate list and require hand-authored memories.* The owner still
  needs a review surface for genuine mined memories; the list stays, only its
  input becomes honest.
- *Restore conversation mining in this change.* `ConversationMemoryPipeline.record()`
  currently has no production caller — it was lost when the native loop replaced
  Pi. Restoring it would add a model call per qualifying turn and is a separate
  repair-lane bug. This change gives the conversation path its own worker so a
  later repair cannot silently reuse the task worker, but does not re-enable it.

**Evidence.**

- Live journal `~/.clone/journal.sqlite3` on 2026-11-18 (the query is in the
  optimization log): 8 `memory.candidate.requested`, 8
  `memory.candidate.extracted` (all `count: 1`), 8 `memory.candidate.proposed`.
  The owner had rejected 2; the one-time cleanup rejected the other 6 with the
  reason above, leaving 0 pending. All 8 summaries are `候选流程：` followed by
  the exact task objective — for example
  `候选流程：只读审查 knowledge-base 项目的 RAG 实现，优先复用已有审查结果并给出可验证的优化建议。`,
  which is identical to that run's `task.created.objective`. None names a
  preference, decision, procedure, or project fact the objective did not
  already contain. This is the list in the owner's screenshot.
- The producer is `DeterministicMemoryWorker.extract` in
  `src/memory/memory-pipeline.ts`, selected by `createRuntimeAssembly` whenever
  `CLONE_AI_MEMORY_MINING !== "all"` (`src/core/runtime-factory.ts`);
  `runMaintenance` drains every request (`src/companion-server.ts`) and the
  desktop candidate list renders every pending one (`apps/desktop/ui/app.js`).
- `test/golden-path.test.ts` asserted the behavior ("a verified run produces
  exactly one candidate") and promoted the restatement, which is why the
  placeholder survived.

**What it costs.**

- Without a miner, task-run mining is silent: a reusable procedure visible only
  in a finished task's evidence is not captured. Durable learning then depends on
  conversation mining (currently unwired), owner-authored memories, or
  `CLONE_AI_MEMORY_MINING=all`. A task-specific lesson is lost until the owner
  turns on the model miner.
- The gate is exact-match only, deliberately. A model that paraphrases the
  objective, or restates evidence, is not dropped. That is a false negative,
  accepted because a looser similarity rule would drop legitimate memories that
  begin with the task's words; the owner still reviews every candidate. The two
  false negatives are pinned in `benchmark/gate/memory-cases.json`.
- The type guard keeps a typed preference/fact/decision/commitment that copies
  the objective. That is deliberate — a first-person statement is exactly the
  case where the objective and the memory can be the same text — but it means a
  model can bypass the drop by labelling a work-order copy `fact`.
- The one-time cleanup auto-rejects pending candidates the owner has not
  decided. They can re-author any they wanted. It is limited to candidates whose
  run has a `task.created` objective and whose summary matches it exactly;
  conversation candidates and orphans are left alone.
- Enabling `=all` later does not revisit runs that completed while no miner was
  configured: their extraction marker records zero candidates. Old work orders
  are not reinterpreted.
- `ImprovementService` lesson suggestions are a different proposal surface. They
  are built from failure signatures and are not `memory.candidate.proposed`, so
  this gate does not cover them.
- The one-time cleanup runs in the companion server's first maintenance tick. A
  CLI-only home keeps legacy pending candidates until a desktop daemon opens it.
- A run trace keeps the proposal event and its rejection event: the audit shows
  what was proposed and what the owner or policy decided. Only current surfaces
  — the review list, attention, and the dashboard's memory field — hide decided
  candidates.

**Reversal condition.** If measured journals show task-run candidates the owner
promotes (say more than 20% of mined tasks), the silent default is too strong:
give task mining a cheap miner by default, or mine only evidence that names a
standing rule. If the gate drops a legitimate memory in real use, narrow it to
the legacy `候选流程：` template only. If typed objective copies become common,
widen the automatic drop (or add a measured similarity layer) without
loosening the exact rule. Delete the legacy cleanup once no journal contains a
pending `候选流程：` proposal and one release has passed.

**Superseded by this entry:** the task-mining half of
[2026-11-05 — Supersedes: conversation mining defaults to a cheap local filter](#2026-11-05--supersedes-conversation-mining-defaults-to-a-cheap-local-filter).

## 2026-11-18 — A read-only request is a step, and tools use the turn's workspace

**Decision.** The fallback planner treats an explicit read-only request, and a
research request with no deliverable, as one read-only step executed by
`context-researcher` (or `direct-responder` when it is disabled), with no
subagent work orders and no required artifact. Generic container nouns (项目,
代码, 文件, 页面) are not delivery terms; a named output target or a delivery
verb still wins, and a no-write clause is removed before delivery matching. The
Main Agent's Kernel tools (`dispatch_task` and the runtime behind
`propose_work_plan`) receive the turn's workspace path, so a dispatched run
executes in the owner's workspace instead of `process.cwd()`; `execution.started`
records that workspace for the audit.

**Alternatives rejected.**

- *Keep the draft work order and make its artifact optional.* The plan would
  still tell a worker to "deliver a local draft" for a request that forbade
  writes; an optional artifact only hides the contradiction, and a read-only
  worker still cannot produce a required one.
- *Treat every no-write phrase as read-only without looking for delivery verbs.*
  "写一份报告，不要修改现有文件" would lose its report. The delivery verb or a
  named output target wins; only the no-write clause is removed.
- *Let the Main Agent retry with a read-only plan after the failure.* It did,
  and that retry succeeded, but the first failed run and its review noise are
  the defect; a retry is not a planner fix.
- *Leave the tool runtimes on `process.cwd()`.* The live run `b1e04b18` read
  `/Users/qihoo/work/knowledge_base/README.md` while its worker's workspace was
  `/Users/qihoo/study/clone-ai` (the checkout), so the worker reported the file
  as "outside the workspace". The prompt named the right workspace; the tool did
  not receive it.

**Evidence.** Runs `c03c7cea` and `cd74804b` were planned as a `prepare` step
with a `draft` subagent requiring `local-draft`; `subagent.verified` failed with
"Missing required artifact evidence: local-draft". Run `b1e04b18` had a
read-only plan but failed because `dispatch_task`'s runtime fell back to the
checkout. After both fixes, the live check on a knowledge-base workspace
(`CLONE_AI_LIVE_WORKSPACE=/Users/qihoo/work/knowledge_base`, native /
`360/openai/gpt-6.1-terra`) produced **one** run (`99504e85`): a single
`read-only-lookup` step with `agentId: context-researcher`, `delegated: false`,
`risk: read_only`; it read the absolute README, recorded the observation, wrote
the three-sentence answer as `execution.completed`, and reached
`waiting_review`. `test/fallback-planner.test.ts` and `test/main-agent.test.ts`
pin the planner shape and the tool-runtime workspace; typecheck passes.

**What it costs.** The intent check is lexical: a request that mentions only a
read-only marker but secretly needs a file must name an output target, or the
worker will ask instead of writing. The tool runtimes now take one more optional
argument; callers that omit it keep the old `process.cwd()` behavior.

**Reversal condition.** If the owner wants a single preparation role for
read-only work, keep the step but make its artifact optional; never require a
write from a read-only capability set. If per-step `files` scopes become the
normal way to reach a project outside the workspace, the read-only step can use
them and the workspace fallback becomes unnecessary.

## 2026-11-18 — One measured worker budget per clone home, not per assembly

**Decision.** Worker capacity becomes one process-wide `CapacityGate` per resolved
clone home (`paths.dataDirectory`), not one per `RuntimeAssembly`.
`createRuntimeAssembly` acquires the gate for its home from a module-level
registry keyed by that directory; the daemon, the Query workflow, the Main
Agent's per-call kernel sessions and the repair lane all draw from the same
instance. The registry reference-counts: each assembly holds one reference,
`assembly.close()` releases it, and the entry is deleted when the last reference
goes, so the many temporary homes a test suite creates do not accumulate. The
owner's `maxConcurrentWorkers` pin stays per home and is still re-read:
`refreshCapacityPin()` on any assembly writes the shared pin holder, and the gate
samples it on every acquire, so an owner settings change reaches every assembly
of that home without a restart. Each assembly still exposes its `capacityGate`,
now the shared instance, whose public `active`/`waiting` counts therefore
describe the whole home.

**Alternatives rejected.**

- *Keep one gate per assembly (the status quo).* `runQuery` builds an assembly
  per query (`src/application/run-query.ts`), the Main Agent's `withKernel`
  builds one per tool call and `native-runtime.ts` one per turn
  (`src/main-agent/tools/kernel-tools.ts`,
  `src/main-agent/native-runtime.ts`), and the daemon one at boot
  (`src/companion-server.ts`). Two concurrent Main Agent turns therefore each
  dispatch up to the machine's full worker budget: the Main Agent cap bounds
  model turns but not total worker load, which contradicts the owner's request
  that concurrency follow the machine. The previous entry in this file recorded
  exactly this gap ("sharing one worker gate across concurrent queries is a
  separate change"); this closes it.
- *A machine-wide singleton in the process.* The Main Agent's own pool is
  deliberately per clone home so a benchmark or a second `CLONE_AI_DATA_DIR`
  gets its own pool. Worker capacity must scope the same way, or the owner's
  daemon and a benchmark run contend for slots.
- *Key the registry on the workspace path.* The measured budget is about the
  machine, and one clone home routinely serves several workspaces (the daemon's
  configured workspace, a repair worktree, a query's injected path); keying on
  workspace would recreate the per-caller gate under another name. The clone
  home is also the address the Main Agent slot pool already uses.
- *Thread the daemon's gate into every caller through a new option.* `run-query`,
  `kernel-tools`, `native-runtime` and the repair lane would each have to pass
  it, and a caller that forgets silently returns to per-assembly behavior with
  no test catching it. A registry keyed by the home makes sharing the default.
- *A cross-process gate now.* Worker dispatch happens mostly inside one daemon
  process, and the multiplication observed here happens between assemblies in
  that process. `src/main-agent/main-agent-slots.ts` is the existing
  cross-process pool; restructuring worker capacity the same way is larger and
  has no failing measurement behind it yet.
- *No reference count — delete the entry on any `close()`.* Closing the Main
  Agent's short-lived per-call session would wipe a gate the daemon still uses,
  splitting the budget mid-run; hence the count, not a boolean.

**Evidence.** Before the change, `createRuntimeAssembly` constructs its own
`new CapacityGate(...)` (`src/core/runtime-factory.ts`), so the gate's lifetime
is the assembly's and every call site above gets a separate limit. The
deterministic eval `test/runtime-capacity-sharing.test.ts` assembles two
runtimes over one temporary home concurrently and asserts: both report the same
gate object; with `maxConcurrentWorkers: 1` a second acquisition through the
other assembly waits until the first releases; a config update followed by
`refreshCapacityPin()` on one assembly changes the limit the other samples; and
once both close, a later assembly for the same home gets a fresh gate, proving
the registry does not leak entries per temporary home.

**What it costs.** One map entry per open clone home, released at close. Closing
an assembly is now load-bearing for that cleanup; a caller that never closes
(e.g. `createKernelRuntime`) keeps its home's entry for the process lifetime,
which is one entry per home, not per call. `runtime.capacity()` now includes
activity from other assemblies of the same home — that is the intent, but a
per-assembly reading becomes a shared one. The gate remains per process: a CLI
process and the daemon still measure separately, so the total across processes
can exceed one budget.

**Reversal condition.** If a cross-process worker pool lands, delete the
registry and use that pool. If holding one budget per home starves ordinary
work — a single query's dispatch waiting minutes behind another query's wave —
raise the measured formula instead of unscoping the budget. If the reference
count proves error-prone (entries that never leave, or a gate deleted while a
live assembly uses it), replace the map with an explicit budget object created
at daemon boot and passed down.

## 2026-11-18 — The Main Agent knows its workspace, and a review carries the answer

**Decision.** The companion passes the running workspace into every Main Agent
turn, so project instructions, the situation briefing and the invocation ledger
all come from it. The compiled prompt names that workspace, says workers see
only inside it, and says that a project named outside it must be reported, not
replaced by whatever the workspace contains. A worker's instructions repeat the
same rule for the step's workspace. A single-agent step journals its final
answer as `execution.completed`; the task record and the review card render that
answer. A workspace saved in Settings returns `restartRequired`, and the
settings pane marks the saved path as pending until the app restarts. Worker
file tools resolve a path with `resolve`, exactly as the gate does, so an
absolute path inside the workspace or a granted read root reaches the file the
gate approved.

**Alternatives rejected.**

- *Leave the file tools on `join(workspace, path)` while the gate uses
  `resolve`.* The two disagreed for absolute paths: the gate approved
  `/ws/README.md`, the tool opened `/ws/ws/README.md`. Live run `b1e04b18`
  failed with "the README is outside the workspace" for a file at the root of
  the workspace because of that doubled prefix.

- *Keep `process.cwd()` as the Main Agent's workspace.* That is the defect:
  the prompt snapshot for turn `4c0ae6ca` has `instructionSources: ["AGENTS.md"]`
  loaded from `/Users/qihoo/study/clone-ai`, while the owner's configured
  workspace was `/Users/qihoo/Documents/Clone AI` and the project being asked
  about was `/Users/qihoo/work/knowledge_base`. The agent sounded like it was
  working on clone-ai because it was reading clone-ai's rules.
- *Let the Main Agent search the home folder for a named project.* Discovery
  outside the workspace widens the trust boundary. It needs an owner-authorized
  `files` scope and its own decision; until then the honest answer is "not in
  this workspace", with the path or a workspace switch.
- *Let the worker "find the project in the workspace" and accept what it reads.*
  Run `062716a9` did exactly that: `list_directory("..")` was refused, all nine
  evidence rows came from `/Users/qihoo/Documents/Clone AI`, and the run still
  reached `waiting_review` with a review card that asked the owner to accept it.
- *Keep only evidence and criteria on the review card.* A single-agent
  completion had no durable event: the worker's 565 output tokens were dropped,
  so the owner was asked to decide about a result that was stored nowhere.
- *Rebuild the runtime assembly in place when the workspace changes.* The
  assembly, queue consumer and scheduler capture the path at boot; a partial
  swap would leave two workspaces in one process. A restart is the boundary
  that actually holds.

**Evidence.** Run `062716a9` (and the earlier `91b685cf`) has four model calls,
565 output tokens, nine `observation` evidence rows — `README.md`,
`CHANGELOG.md`, `src`, `vendor`, `.git/config`, all from the Clone AI workspace —
and no `execution.completed` or `subagent.completed` event. The Main Agent's
prompt snapshot `a063d154…` names `AGENTS.md` from the clone-ai checkout as its
only instruction source. `~/.clone/config.json` says
`workspacePath: /Users/qihoo/Documents/Clone AI`; the RAG project is at
`/Users/qihoo/work/knowledge_base`. After the `resolve` fix, live run
`496d2061` read `/Users/qihoo/work/knowledge_base/README.md` through an absolute
`read_file` call (`isError: false`), journaled `execution.completed` with the
three-sentence answer, and reached `waiting_review`; the owner accepted it, and
the task record shows the answer above the acceptance line.

**What it costs.** The prompt grows by a short workspace paragraph. Every
single-agent step adds one journal event carrying the redacted answer, bounded
by the model's output. The review card repeats an answer that also appears in
the task record: one is the decision surface, the other is what remains after
the decision. The settings change remains a restart, now stated instead of
silently ignored. The `resolve` change grants no new trust: it removes a
disagreement between the gate and the tool, and relative paths behave exactly
as before.

**Live check.** The wiring and the prompt text are pinned by deterministic
tests; a live check against the configured model confirms the behavior for one
phrasing. Using `360/openai/gpt-6.1-terra` at `http://127.0.0.1:3425` and a fresh
temp workspace, the original request ("看一下knowledge-base这个项目…") first
produced an honest reply asking for the path but also dispatched one run that
failed (no false review). After adding the line "You have no filesystem tool of
your own: you cannot search the disk", the same request asked for the path or a
workspace switch and dispatched nothing (`newRuns: []`). This is one model and
one phrasing, not a benchmark; a wider prompt-compliance run is still missing.

**Reversal condition.** If the runtime learns to switch workspaces live, drop
the restart notice and apply the path to the running assembly. If the owner
decides cross-project lookup is required, add an owner-authorized `files` scope
and a discovery tool (the rejected alternative above) rather than widening the
workspace silently; then the "outside the workspace" rule becomes an
instruction to use that tool. If absolute paths must be refused instead, refuse
them in `decideTool` as well; never let the gate and the tool disagree.

## 2026-11-18 — The main pane is a dispatch log, not a chat transcript

**Decision.** A conversation's main pane renders one log entry per Main Agent
turn instead of chat bubbles. Each entry shows the owner's query, how the turn
assembled its context (provider, model and effort; the prompt snapshot's
charter version, tool table and material hashes; deterministic compactions; how
many completed turns the history carried), how it dispatched work (every tool
call with its input summary and duration, and the runs the turn spawned with
their titles and statuses), and the result (the reply or the error). Approval
and review cards, the task-record view and the composer are unchanged. The
searchable, global turn log stays in 设置 → 审计与轨迹 → 回合.

**Why it won.** Every new task dispatches its work as Kernel runs, which the
sidebar already lists under the conversation. The chat bubble between them
repeats a one-line summary those runs already carry, while the two facts the
owner needs when a turn goes wrong — what context the model was given and what
it dispatched — exist only in the audit tab. The screenshot that motivated the
change shows the main pane spending its reading column on "已派发任务，运行 ID …"
while the failed run's evidence sat in a card below. The owner's stated
preference plus the observed duplication justifies the change; the user-facing
gain is an assumption until a usability check confirms it.

**Alternatives rejected.**

- *Keep the chat bubbles and add a collapsed log under each turn.* Two
  renderings of the same turn; the bubble still owns the column, and the log
  stays a second-class detail.
- *Move the log to the audit tab only.* The audit tab is global and searchable,
  but it cannot show this conversation's turns beside the composer, and
  answering "what did it dispatch?" would mean leaving the task.
- *Hide everything but the composer.* Loses the reply and the failure reason,
  which are the turn's result.

**What was given up.** The conversational rhythm of the Main Agent's prose: a
long reply still takes the same space, but inside a log entry with context and
dispatch around it. Turns written before the turn ledger existed (legacy Pi
session files) render as compact history rows inside the same log, so they stay
visible without being styled as a conversation.

**Evidence.** `test/main-agent-turn-audit.test.ts` projects the new fields
(conversation id, compactions, prompt snapshot) and
`test/ui-structure.test.ts` asserts a conversation renders the log while a task
record still renders its messages; both fail before the change. `npm test`,
`npm run typecheck` and `npm run gate` pass.

**Reversal condition.** If a usability check shows owners scroll past the
context and dispatch rows to read the reply, or ask for the back-and-forth
rhythm a log entry cannot carry, restore the chat transcript for the reply and
keep the log as a collapsed section under it.

## 2026-11-18 — Each task runs its own Main Agent, sized by the machine

**Decision.** A Main Agent turn belongs to a conversation (task) id. The turn
ledger records that id, the model's history is rebuilt only from turns of the
same conversation, and the prompt lock is per conversation: a second prompt in
the same conversation is still refused, while prompts in different
conversations run concurrently. A cross-process slot pool caps how many Main
Agent turns run at once. In auto mode the cap is sampled on every acquisition
from CPU and load: half the CPU cores (two when the machine has room), halved
when the 1-minute load is at or above half the cores, never above eight, and
reducible to one under load. Memory is deliberately not a bound: macOS reports
only free pages, so a memory term serialized every task on the primary
platform, and worker memory is gated where workers actually run. The owner may
pin `maxConcurrentMainAgents`; a pin is capped at the core count. A turn above
the cap waits for a slot (abortable) instead of being refused. The cap is per
clone home, not machine-wide: a benchmark or a second `CLONE_AI_DATA_DIR` gets
its own pool. In the desktop, "新建任务" starts a new conversation, and the
sidebar lists conversations alongside the task runs they spawned.

**Alternatives rejected.**

- *Keep one lock and queue every turn.* History is still one transcript: two
  tasks would read and write each other's context, which is the reason the
  owner asked for separate Main Agents.
- *Per-conversation locks without a global cap.* Every conversation could issue
  model calls and worker dispatches at once; the only bound would be the
  provider and the OS.
- *An in-process semaphore.* The daemon, the CLI and the WhatsApp bridge are
  separate processes; a per-process counter cannot see the others, so the cap
  would be false as soon as two surfaces are used.
- *Let the model choose the number of concurrent Main Agents.* Concurrency
  would depend on a sampled token rather than the machine — the same reason
  worker concurrency is measured deterministically.

**Evidence.** `withMainAgentLock` (`src/main-agent/prompt-lock.ts`) holds one
`prompt.lock` per clone home, and `runMainAgentQuery` wraps the whole turn in
it; `test/prompt-lock.test.ts` asserts the second caller is refused and
`test/companion-control-plane.test.ts` expects the 409 this produces.
`buildHistory` (`src/main-agent/native-runtime.ts`) reads every completed
ledger row with no conversation filter, so separate tasks share one transcript.
The parity study already lists "concurrent Main Agent prompt → 409/queue" as
gap D11 (`docs/study/claude-code-parity.md`). The worker gate
(`src/core/capacity.ts`) is the existing precedent for a measured limit with an
owner pin. A live sample on the 18-core / 24 GB verification host reported
456 MB free (macOS counts only free pages) and produced a limit of 1 with a
memory term; with the memory bound removed the same machine admits its CPU
budget, which is what makes the feature usable on the primary platform.

**What it costs.** Concurrent turns spend provider tokens in parallel and share
the provider's rate limit; a turn made to wait shows no progress until it
starts, and the desktop's 3-minute stall still applies to a very long wait. A
turn that none of its callers aborts can hold a slot until it ends: there is
deliberately no default round or duration cap, so the pool cannot reclaim a
hung turn while its process lives. The cap is per clone home, so two homes on
one machine each get their own pool. The ledger stays one append-only file, so
scope is a field rather than a file, and a row written before this change
belongs to the main conversation. Runs and work updates created before this
change also stay under the main conversation. Each dispatched run still builds
its own worker capacity gate, so N concurrent Main Agents can each dispatch up
to the machine's worker budget; sharing one worker gate across concurrent
queries is a separate change.

**Reversal condition.** If concurrent Main Agent turns corrupt Kernel or
journal state, or two agents' simultaneous dispatches oversubscribe the
provider or the machine despite the cap, reduce the pool to one and keep the
per-conversation scoping until the failure is understood. If per-conversation
history is shown to fragment the owner's memory — a fact stated in one task is
expected in another and is not found — merge the histories again and keep only
the per-conversation lock. If waiting for a slot makes the desktop feel hung in
ordinary use, return a readable 429/409 instead of waiting and let the owner
retry.

## 2026-11-18 — A verification record states a count, not a repeated list

**Decision.** `VerificationResult.summary` no longer embeds the unverified
criteria. The step verifier writes "Automatic checks passed; N of M acceptance
criteria still need the owner's review", the test plugin writes "Test evidence
needs the owner's review", and the criteria stay only in `unverifiedCriteria`.
The record UI renders that field as numbered rows with the step title on a muted
line, shows the owner's decision as the pill (`已接受结果` / `已驳回结果`) instead
of a separate "你的决定" line, and rewrites the legacy summary sentence, which it
identifies by its opening text, into the same count.

**Alternatives rejected.**

- *Keep the summary and drop the criteria list.* The criteria are the thing the
  owner reviews; the list is the record.
- *Migrate the stored events.* The journal is append-only history; rewriting it
  to change a sentence a reader can interpret is worse than interpreting it.
  The UI does that rewrite for old records.
- *Shorten each criterion in the verifier.* The step title repeated in every
  row is what turned six rows into a wall of text; splitting it in the view
  fixes every record, including ones already stored, without losing the title.

**Evidence.** App run `18569eb4` showed a six-row review list repeating
"完善故宫模型并进行契约和浏览器验收：" before each clause, and the same six
clauses again inside the summary paragraph; the pill said "通过" while the line
beside it said "你的决定：接受结果". The stored payload has
`unverifiedCriteria.length === 6`, `checkedEvidenceIds.length === 11`.

**What it costs.** Old records without `unverifiedCriteria` keep their summary
verbatim and gain no list; the summary is no longer self-contained evidence (a
reader who only stores the summary loses the criteria text — the structured
field is the contract now). The UI's legacy rewrite is a string prefix match;
a record whose summary was edited to start with that sentence would be shortened.

**Reversal condition.** If a consumer outside the UI (an export, an email
report) needs the criteria inside the summary, add a rendered composer that
joins them at that boundary instead of putting them back in the stored summary.
If a record type appears whose summary is the only carrier of the criteria,
keep that type's summary as-is and mark it in the UI.

## 2026-11-18 — A checkout-served daemon re-reads its client files per request

**Decision.** The resident daemon runs with `CLONE_AI_DEV_MODE=1` (set by
`scripts/install-daemon.mjs`). In that mode the companion re-reads the client
asset it is about to serve — `app.js`, the stylesheets, the other view
scripts — on each request, falling back to the startup snapshot if a file
cannot be read. The packaged app, which serves its bundled runtime, keeps the
snapshot for every file except the HTML, which already re-injects the token per
request.

**Alternatives rejected.**

- *Restart the daemon after every UI edit.* The window follows the endpoint, so
  a restart is survivable, but a two-minute edit cycle that requires a restart
  is exactly what the resident job was meant to remove.
- *Have the page reload only on an explicit action.* The failure observed on
  2026-11-18 was not a stale page — the *served* script was missing a function
  a concurrent edit had moved, so the first click threw "Can't find variable".
  A manual reload cannot fix a script that is wrong at the source of truth.
- *Drop the snapshot and re-read everything in production too.* The bundled
  runtime cannot change under the process; re-reading it buys nothing and adds
  a failed-read fallback path to the packaged product.

**Evidence.** The daemon started at 16:09:41 read `app.js` once
(`src/companion-server.ts:370-381`). A concurrent edit landed at 16:12:00 and
wrote `verificationMarkup`; the process kept serving the 16:09 copy, which
called `recalledMemoryMarkup` after that function had moved, so clicking a task
threw `Can't find variable: recalledMemoryMarkup`. `curl app.js` against the
live daemon returned 150,805 bytes, `rg` found the call but no definition, and
the disk copy at the same moment had the definition. After the change and a
reinstall, appending a line to `app.js` changed the served length on the next
request (152,768 → 152,778 bytes) without restarting the job.

**What it costs.** Up to nine small file reads per request in development, each
with an error fallback; a syntax error written to a client file reaches the
window immediately instead of being frozen out. The packaged app is unchanged.

**Reversal condition.** If per-request reads show up in profiling or a
watcher-based cache (fs events) proves simpler, replace the re-read with the
watcher. If a shipped build is ever served from a checkout, remove the flag
from the installer and gate it on an explicit developer command instead.

## 2026-11-18 — A plan step's label names its risk, not a pending approval

**Decision.** The plan row labels the step's risk class — `直接处理` for reads,
`本地写入` for reversible writes, `外部动作` for external side effects,
`不可逆` for irreversible steps — instead of the single `需确认` it showed for
every non-read step.

**Why it won.** Run `abf7e3e4` planned a `reversible_write` step; the policy
decided `allowed` ("The step is local and reversible"), so no approval was
raised. The plan still said `需确认`, and the owner asked where that confirmation
was. The label described an action that never existed.

**What was given up.** The label no longer hints that a confirmation might
appear. Where a confirmation really is pending, the run is `waiting_approval`
and the approval card in the main conversation remains the authoritative place;
the plan row is only a risk description.

**Evidence.** `journal_events` for run `abf7e3e4`: `plan.created` risk
`reversible_write`, `policy.decided` outcome `allowed`; the task record showed no
approval card. `test/ui-structure.test.ts` pins the four labels and rejects
`需确认`.

**Reversal condition.** If planners gain a flag that a step needs the owner's
confirmation regardless of policy, label that flag explicitly. If the owner
wants every reversible write confirmed, change the policy, not the label.

## 2026-11-18 — A finished run opens its trace by default

**Decision.** `traceMarkup` opens the execution trace for every task record,
finished or not; a collapse the owner makes is still remembered per session.
This reverses the "finished runs keep it collapsed" half of the entry below.

**Why it won.** The owner opened a finished review and asked why the work record
was folded and unlike every other agent they use. The trace is the record of
what the run did: collapsed, the task looks empty even though 43–214 rows exist.
The trace container is already bounded (`max-height: min(360px, 45vh)` with its
own scroll), so opening it does not push the verification off screen.

**What was given up.** A long trace (214 rows in `4ce0db3d`) occupies the
viewport by default. The verification card sits above it and stays visible; the
owner can collapse the trace in one click and that choice is remembered.

**Evidence.** In an isolated copy of the owner's journal, run `4ce0db3d`
(completed, 26 evidence rows, 214 trace rows) renders the trace open without
displacing the verification card; `test/ui-structure.test.ts` asserts the trace
is open for both `waiting_review` and `completed`.

**Reversal condition.** If a typical completed run's trace buries the
verification or makes the record feel like a log dump, return to
collapsed-on-finish, or keep a compact summary (counts by event type) and put the
full list behind the disclosure.

## 2026-11-18 — A finished run keeps its verification, evidence and trace on screen

**Decision.** A task record always shows what the run produced: an evidence list
(kind, locator, summary) separate from the artifact files, a verification block
that survives the owner's decision (system verdict, the owner's verdict, the
criteria and the summary), and an execution trace that is open for a run that
still needs the owner and collapsible but visible for a finished one. The
server returns `evidence` and the trace already exists; the UI stops hiding it.

**Alternatives rejected.**

- *Keep the verification card only while `waiting_review`.* That is why the
  owner saw "核验结果呢，为什么没有显示记录" after accepting: the decision wrote
  a second `verification.completed` with `reviewedBy: "owner"`, but the card's
  first condition (`status === "waiting_review"`) made it disappear, so the
  accepted verdict was invisible in the record that it belongs to.
- *Leave evidence as a count.* `evidenceCount` told the owner "9 条可验证证据"
  and nothing else; the nine rows existed in the journal (kind, locator,
  summary) and in the audit view, but the task record — the place the owner
  actually opens — never listed them.
- *Put artifacts inside the trace.* A `write_file` call is evidence with
  `kind: "artifact"`; folding it into 100+ trace rows makes the deliverable
  impossible to find. The artifact block is a separate, short list of files.
- *Expand all 100+ trace rows by default for every run.* That buries the plan
  and the verification. The trace opens by default only while the run is still
  waiting for the owner; a finished run keeps it collapsed but one click away.

**Evidence.** Run `91b685cf` (a RAG review that later evidence showed had read
the Clone AI workspace, not the project it named) has 9
`evidence.recorded` events, 9 `agent.tool_*` calls and a
`verification.completed` with `needsReview: true`, yet its task record showed
only the plan, the evidence count and a collapsed trace. Runs `709e9ab5`,
`4ce0db3d` and `18569eb4` each have two `verification.completed` events — the
system's and the owner's; only the first was ever rendered, and only until the
owner decided. `test/ui-structure.test.ts` and
`test/main-conversation-approvals.test.ts` pin the new blocks.

**What it costs.** The session payload grows by the evidence list (bounded by
the run's evidence, typically under 50 rows). The verification block repeats the
criteria the review card already showed: the duplication is deliberate, because
one is an action prompt and the other is the record of what was decided.

**Reversal condition.** If a run's evidence list routinely exceeds a screenful,
summarize by kind with an expander instead of removing it. If the owner says the
duplicated criteria are noise, keep the verdict line and move the criteria into
the trace.

## 2026-11-18 — The owner's message renders through the markdown path

**Decision.** `messageMarkup` renders both the owner's and the agent's messages
with `richText`, and the optimistic echo uses the same function. The markdown
block styles (`.md-heading`, `.md-list-line`) are extended from `.clone-text` to
`.message-copy`.

**Alternatives rejected.**

- *Leave owner messages escaped with `<br>`.* A pasted task brief showed its
  `#`, `**`, backticks and list markers literally, which is what made the
  sent bubble look wrong next to the agent's rendered reply.
- *Add a "preview" toggle.* Pasting a brief is the common case; making the
  readable form a second click hides the problem instead of fixing it.
- *Write a second renderer for owner text.* `richText` already escapes its input
  before adding markup, which is the security property owner-authored text
  needs; a second implementation would drift.

**Evidence.** The owner pasted a multi-section Forbidden City brief (headings,
inline code, bold, lists) and the sent bubble displayed the literal markdown
while the agent's replies rendered normally. `richText`
(`apps/desktop/ui/app.js:1348`) is the same renderer used for replies and
escapes first; the block styles existed only under `.clone-text`.

**What it costs.** Owner text is no longer visually byte-exact: headings grow,
list markers become bullets, code gets a background, and blank-line spacing can
compress. Selecting the bubble still yields the rendered text. A message is
HTML-escaped before any markup is added, so injection is not possible.

**Reversal condition.** If an owner needs the exact raw text, add an explicit
"show raw" toggle rather than removing the renderer. If rendering distorts short
plain replies, scope it to messages with a heading, list, fence or bold span.

## 2026-11-18 — Maintenance automation runs in its own clone home

**Decision.** The repair lane, nightly RSI, the eval companion and any script
that starts an automation companion resolve their data directory through
`scripts/automation-home.mjs`: `CLONE_AI_AUTOMATION_HOME` when set, otherwise
`<repo>/.automation/<purpose>`. The resolver refuses a path equal to the
owner's live clone home unless `CLONE_AI_ALLOW_OWNER_HOME=1`. The isolated home
is seeded once with the small config files (`config.json`, `settings.json`,
`providers.json`, `mcp.json`, `policies.json`), never the journal, memory,
sessions, turn ledger, token, endpoint or locks; `CLONE_AI_AUTOMATION_REFRESH=1`
re-seeds them. The repair lane still reads failed traces from the owner's home,
read-only. `scripts/companion-dev.mjs` falls back to `.automation/preview` when
no home is supplied, so the preview launch config keeps working without an
explicit variable, and refuses `~/.clone` unless
`CLONE_AI_ALLOW_OWNER_HOME=1`.

**Alternatives rejected.**

- *Keep sharing `~/.clone`.* On 2026-11-18 the app and the repair lane shared
  one data directory and produced the raced `failed -> verifying` journal event;
  the same day an automation prompt sent to the live daemon held the Main Agent
  prompt lock for 149.9 s and rejected the owner's two messages with "The Main
  Agent is already answering another request".
- *Copy the whole owner home.* Duplicates the journal, memory and tokens, and
  recreates the two-writer hazard under a new path; automation only needs the
  config files.
- *Require an environment variable with no default.* A dry run or a cron entry
  would silently fall back to `~/.clone` again; the safe default has to be the
  isolated one.

**Evidence.** Journal turn `6d04f0ac` (source `companion`, model
`360/openai/gpt-6.1-terra`) started 2026-11-18T07:18:22.108Z and completed
07:20:51.974Z, holding `~/.clone/pi-sessions/main-agent/prompt.lock` (pid 78156,
open write handle) for 149.9 s; the owner's sends at 07:19:39Z and 07:19:43Z
were recorded `interrupted` with the busy error. `scripts/repair.mjs` resolved
`resolveClonePaths()` with no override (default `~/.clone`), and
`scripts/companion-dev.mjs` started a server with no explicit data directory,
so any invocation without `CLONE_AI_DATA_DIR` landed on the owner's home.

**What it costs.** A second small home per automation purpose, holding a snapshot
of the config files; rotating a credential needs `CLONE_AI_AUTOMATION_REFRESH=1`
or deleting the seeded file. Reports, consumed-trace state and nightly locks now
live under `.automation/`, so they are not in the owner's export. An
owner who deliberately wants automation in `~/.clone` must set
`CLONE_AI_ALLOW_OWNER_HOME=1`.

**Reversal condition.** If the companion gains per-client queues so an
automation prompt cannot hold the owner's Main Agent lock, or if every client
gets its own session-scoped runtime, remove the separate home. If the config
snapshot cannot be kept in sync, replace seeding with a read-through config
reader that never copies the file.

## 2026-11-18 — A worker stops when the model stops; no default round cap

**Decision.** `maxRounds` is optional everywhere. Without an explicit plan budget
or owner setting, the shared loop has no round cap: it continues until the model
returns no tool calls, the turn is aborted, or a duration/tool/token budget
stops it. The planners no longer write `maxModelCalls` into their budgets. The
round-tail notice ("only N rounds remain") applies only when a limit is set.

**Alternatives rejected.**

- *Keep the 40-round default.* It is still an arbitrary number that cuts a
  legitimate step mid-edit: Qwen3.8 Max had written a regression test and was
  still editing it when the 24-round owner setting stopped phase 1 at 594 s
  (405,850 tokens). The number moved from 12 to 24 to 40 across incidents; each
  raise only moved the cliff.
- *A very high cap (100, 500).* The same cliff, harder to notice; the model still
  cannot decide.
- *Remove all guards.* Duration, tool-call and token budgets remain; those
  measure cost and can stop a runaway loop even when the model keeps calling
  tools.

**Evidence.** `test/native-agent-worker.test.ts` asserted `effectiveRoundLimit(
undefined, undefined) === 40`; the repair runs on 2026-11-18 stopped at 24
(Qwen, 594 s, 405,850 tokens) and at 40 (Kimi's phase 1 finished but phase 2
spent its rounds editing). The loop has `maxDurationMs`, `maxToolCalls` and
`maxTotalTokens` guards independent of rounds.

**What was given up.** A deterministic upper bound on model calls per turn. A
model that loops without progress now runs until the duration/tool/token budget
or the owner's abort. The round-tail notice no longer fires unless a limit is
explicitly set.

**Reversal condition:** if a step runs far past its useful work without a
duration/tool/token budget stopping it, add an explicit per-step budget in the
plan (not a global default), or restore a high default cap with a documented
number and the incident that justifies it.

## 2026-11-18 — The invocation list exposes a per-row delete control

**Decision.** Each Agent-invocation row becomes a container with two sibling
controls: a pick button (`data-au-invocation`, selection + `aria-pressed`) and a
compact delete/restore action (`data-au-inv-delete` / `data-au-inv-restore`). The
bulk "删除这 N 条" remains and still counts pick buttons.

**Alternatives rejected.**

- *Keep delete only in the detail panel.* That shipped first; the owner could not
  find it — the detail's action sits below a potentially long prompt, while the
  toolbar's bulk button is the only visible control.
- *Nest a delete button inside the row button.* Invalid HTML; browsers drop or
  mis-handle nested interactive elements.
- *A context menu or swipe action.* Hidden behind a gesture, and this list has no
  established context-menu pattern.

**Evidence.** The owner's Agent-invocation view showed a selected record whose
request body filled the panel; `删除记录` was below the fold, while `删除这 27 条`
was visible in the toolbar. The row was a single `<button>`, so no per-row control
could exist without restructuring it.

**What was given up.** One more small control per row, and the row itself is no
longer the button — keyboard focus lands on the pick button. Delete stays
confirmation-gated and soft (tombstone, restorable).

**Reversal condition:** if accidental deletes increase, move the action back to
the detail or require selecting the row first. If the row grows more actions,
switch to a compact overflow menu instead of adding buttons.

## 2026-11-18 — A packaged launch attaches when the LaunchAgent is loaded

**Decision.** The window decides resident mode once, at launch. An explicit
`CLONE_AI_RESIDENT_DAEMON=1` wins; otherwise, for a packaged build (no
`CLONE_AI_DEV_ROOT`), it runs `launchctl print gui/<uid>/ai.clone.companion`
and attaches when the job is loaded; without the job it spawns its own runtime.
Developer builds keep their private runtime unless the variable is explicit.

**Alternatives rejected.**

- *Put `CLONE_AI_RESIDENT_DAEMON=1` in the bundle's `LSEnvironment`.* Every
  build would become attach-only: a checkout that never installed the daemon
  (`npm run desktop:mac:build && open "dist/Clone AI.app"`) would wait on an
  endpoint no process publishes.
- *Attach whenever `companion-endpoint.json` exists.* The file outlives its
  writer: on 2026-11-18 it held pid 11243 and port 4317 after that sidecar was
  gone, while the launchd daemon listened on another port. A window trusting
  the file would load a dead URL.
- *Always spawn the runtime.* With the LaunchAgent installed that is two
  processes writing one journal — the 2026-11-18 `failed -> verifying` race.

**Evidence.** The 14:28 app, launched from Finder, carried no `CLONE_*`
environment (`ps eww`), so the environment-only `residentRuntime` was false
while `ai.clone.companion` was running (pid 77407); the window spawned a second
sidecar. The endpoint file's pid (11243) was already dead, which is why file
presence is not a liveness signal.

**What it costs.** One `launchctl print` at startup (milliseconds). The mode is
fixed for the window's lifetime, so installing or removing the daemon does not
change a running window; the pump installer must tell the owner to relaunch.
A loaded-but-broken job makes the window wait and retry every 30 s instead of
falling back to a private runtime — deliberate, because a fallback recreates
the two-writer state.

**Reversal condition.** If the app can establish the daemon's liveness without
launchd (a healthy published endpoint probed before deciding), use that and drop
the `launchctl` call. If the installer can launch the window with the
environment variable set, set it there and keep this detection only as a
fallback.

## 2026-11-18 — Paired halls may live under props, and the grader looks there

**Decision.** The symmetry check accepts a paired hall found either in
`model.buildings` or in `model.props.sideHalls` / `model.props.buildings`, as
long as both members of the pair carry mirrored positions.

**Alternatives rejected.**

- *Require every building in `buildings`.* The contract says `buildings` is the
  axial roster; a page that keeps the ten axis halls there and exposes the
  flanking halls under `props` is following the contract, and run `18569eb4`
  did exactly that. Failing it graded an array layout, not symmetry.
- *Add the pair to `buildings` regardless.* That would forbid a legitimate
  representation and make `namedHallCount` ambiguous.

**Evidence.** Run `18569eb4` added 体仁阁/弘义阁 at x = ∓150, z = 235 with
`symmetryPair` pointing at each other, under `props.sideHalls`; the check still
reported "体仁阁/弘义阁 absent" because it only searched `buildings`. After the
lookup change the same workspace passes 28/28.

**What it costs.** The grader now accepts two shapes, so a page that splits
buildings across both arrays is harder to reason about; the check tolerates it
rather than enforcing one layout.

**Reversal condition.** If the contract is tightened to a single `buildings`
roster, remove the props lookup and state the requirement in the prompt.

## 2026-11-18 — The default view is graded on composition, not only on data

**Decision.** The interactive checker measures how much of the frame height the
hero hall (太和殿) covers from `getForbiddenCityView()` at load, and requires at
least 25%; the eval prompt states the same rule. The measurement projects the
hall's eight corners with the page's own camera numbers (forward/right/up derived
from position and target, `fovDeg` for the frustum), so it cannot pass by
reporting a camera the page does not use.

**Alternatives rejected.**

- *Grade only the model data and the interaction APIs.* Run `4ce0db3d` passed
  26/27 by those measures and still looked like a floor plan: the default camera
  sat 820 m away and 28° up, so 太和殿 covered 9% of the frame height. The
  owner's complaint ("跟一个平面图一样") was about exactly this, and no check
  could see it.
- *Judge the screenshot with a vision model.* Non-deterministic, costs a model
  call per grading, and would need its own calibration; the projection is exact
  and free.
- *Require a fixed camera position.* That grades one author's taste instead of
  the observable property (the hall fills the frame), and forbids equally good
  compositions from other angles.
- *Set the threshold at 50%.* At `fovDeg` 42 a 35 m hall at 50% would have to be
  within ~90 m, which hides the courtyards and walls that make the scene read as
  the Forbidden City; 25% keeps the city as context while making the hall the
  subject.

**Evidence.** `4ce0db3d` graded 26/27 before this check; the same workspace then
measured `hero covers 9.0% of frame height, inside=true` with the new check. The
screenshot at that view shows the axis as a thin strip in a large empty plaza.

**What it costs.** A model that composes a wide establishing shot now fails
until it moves the default camera closer; the prompt has to say so, or the
requirement reads as a hidden rule.

**Reversal condition.** If owners prefer a wide establishing view by default,
lower the threshold or grade the closest of the three required screenshots
instead of the load-time view.

## 2026-11-18 — The installed daemon resolves the workspace the app uses

**Decision.** `scripts/install-daemon.mjs` writes
`CLONE_AI_DESKTOP_DEFAULT_WORKSPACE=$HOME/Documents/Clone AI` into the generated
LaunchAgent, so a resident daemon started from the repository resolves the same
workspace as the packaged app instead of treating `process.cwd()` (the source
tree) as the workspace.

**Alternatives rejected.**

- *Set the workspace only in `config.json`.* `resolveDesktopLaunchConfig` reads
  it only when the default-workspace variable is present, and
  `resolveClonePaths` falls back to `process.cwd()`; a daemon with no variable
  ignores the saved value. The UI meanwhile displayed the saved path, which made
  the mismatch invisible.
- *Default the workspace to the app folder inside `resolveClonePaths`.* That
  changes the meaning of the variable for every caller, including tests and
  server deployments whose workspace is legitimately their cwd.
- *Leave it to the owner to edit the plist.* Re-running the installer would
  silently drop the edit.

**Evidence.** Run `9d706a27` was executed by the launchd daemon and failed with
`Required input missing: vendor/three.module.js` after 3 model calls and 8.9 s,
although `~/.clone/config.json` names `/Users/qihoo/Documents/Clone AI` and that
folder holds the 1.3 MB vendor file. `launchctl print` showed
`working directory = /Users/qihoo/study/clone-ai` and no default-workspace
variable; `lsof` confirmed the daemon's cwd was the repository, where `vendor/`
does not exist.

**What it costs.** The installer now assumes the app's default workspace path;
an owner who keeps deliverables elsewhere must change `config.json` (which the
app writes) or the installer line.

**Reversal condition.** If the app stops using `~/Documents/Clone AI` as its
default workspace, the installer must read the path from one shared constant
rather than duplicating it.

## 2026-11-18 — Interactive grading stops asking for video-only fields

**Decision.** The Forbidden City checker's `--interactive` mode no longer grades
`browser.timeline-differs`, `browser.frame-throughput` via `setVideoTime`, or
`model.features.cameraKeys`; `src.modules` uses a separate minimum of 1 for the
interactive contract.

**Alternatives rejected.**

- *Keep one contract for both deliverables.* The 2026-11-18 decision to grade an
  interactive model replaced the video, but the checker kept three video-only
  assertions; they failed every interactive model regardless of quality, which
  makes the score useless as a signal.
- *Drop the timeline checks for both modes.* The video contract still needs them;
  its frames must differ and its seek path must stay fast.
- *Treat the failures as soft checks.* A soft check still prints FAIL and hides
  the fact that the model was never graded on that dimension.

**Evidence.** Grading App run `91a50a87` with `--interactive` before the change:
23/28 with `browser.timeline-differs 1/5 distinct screenshots` (an interactive
page has one view, not a timeline), `model.features missing: cameraKeys` (the
model has a live camera, not keyframes), and `browser.run TypeError:
window.setVideoTime is not a function` — the last one aborted the rest of the
browser section, including the frame-throughput measurement. After the change:
26/27, with only `model.symmetry` failing because the eval prompt omits
体仁阁/弘义阁 that `expected.json` requires.

**What it costs.** Interactive models are no longer checked for having a
timeline — by design; their interaction is graded by `interaction.orbit` and
`interaction.zoom`, which a static render cannot pass.

**Reversal condition.** If an interactive deliverable is later expected to
animate over time, add a mode flag rather than reusing the video timeline checks;
if the two contracts converge again, collapse the interactive branch.

## 2026-11-18 — The native worker's default round budget is 40, not 12

**Decision.** `effectiveRoundLimit` keeps its precedence — the plan's
`maxModelCalls`, then the owner's `CLONE_AI_NATIVE_MAX_ROUNDS`, then a default —
but the default becomes 40 model calls instead of 12.

**Alternatives rejected.**

- *Leave 12 and require every plan to carry a budget.* The LLM planner emits
  steps without a budget (`budget: null` in `plan.created`), so the default is
  what runs in practice; requiring the planner to budget model calls makes a
  working default depend on a field no one fills.
- *No default (unbounded).* The duration budget then becomes the only stop, and
  a loop that keeps making cheap calls can burn the whole step before any
  round-level signal appears.
- *Raise it to 100.* The observed cost per round is a few seconds and ~8k
  tokens; 40 already covers a build-read-verify-fix pass, and a larger default
  hides a plan that should have budgeted explicitly.

**Evidence.** App run `91a50a87` (2026-11-18) wrote `index.html`,
`src/main.js`, `README.md` and five screenshots through the Playwright MCP, then
stopped at its 12th model call with
`The agent reached its 12-round limit without a final answer` — 14 tool calls,
102,872 tokens, 112.2 s, and a scene that already loaded and orbited. The
fallback planner carried 40 for the same reason: "20 cut a working FPS off
mid-verification; 40 lets the same one-shot request finish"
(`src/planning/fallback-planner.ts`). Interactive 3D adds a screenshot-review
loop on top of the write pass, which 12 cannot cover.

**What it costs.** A step that would have failed at 12 now may spend up to 40
rounds of tokens; the 10-minute work-order duration and the tool-call budget
still bound it. A model that loops without progress now wastes more before the
round limit stops it.

**Reversal condition.** If per-step cost becomes the binding constraint, lower
the default and make the planner emit `maxModelCalls` on each step; if runs
still stop at 40 while producing, raise it only together with a duration budget
that covers the extra rounds.

## 2026-11-18 — Approvals live in the main conversation; child tasks collapse under it

**Decision.** Every `waiting_approval` run is confirmed from the Main Agent
conversation, not from its own task record. The main conversation aggregates the
pending approvals of all visible runs, each with its task title and a
confirm/reject pair that posts to that run's id; a child task record shows a
pointer back to the main conversation instead of a second set of buttons. The
main conversation also aggregates the visible subagents into its collapsible
Agent 协作 card. In the sidebar, derived child runs are grouped under the
conversation that spawned them inside a collapsed `<details>` block; its summary
shows the count and running/failed split, and expanding reveals the child rows.

**Alternatives rejected.**

- *Keep approvals inside each child task.* The owner has to hunt through task
  records to find what needs a decision, and the main conversation looks finished
  while a run waits. The screenshot this change answers showed a task record
  with "需确认" steps and no single control surface.
- *Put approvals in a global Settings/Audit inbox.* It separates the decision
  from the conversation and the task context; the Main Agent conversation is
  already the owner's control surface.
- *Flatten all child tasks in the sidebar.* With 11 tasks the list reads as
  siblings of the conversation; the parent/child relation is lost.
- *Auto-approve low-risk steps.* External actions still cross the authority
  boundary; the owner's explicit decision stays mandatory.

**Evidence.** `buildMainAgentConversation` returns `approvals: []`,
`buildSession` returns one approval per run, and `approvalMarkup` posts to
`session.id`; on the main conversation that id is `main-agent-conversation`, so
the existing card cannot approve a child run. `renderSessions` already knows
`parentId` and `childCount` but flattens children into the today/earlier groups.
The eval is deterministic: a server-side test that the main conversation view
carries a pending approval with the run id, and a UI contract test for the
aggregated approval card and the collapsible child group; `npm test`, typecheck
and the regression gate.

**What it costs.** The main conversation can show several approvals at once
(capped by the dashboard's visible runs); approving from there reveals the task
title but not the step detail in the child record, so a pointer link remains.
Child task records lose their inline action and need one navigation. The sidebar
group needs remembered open state per parent; its count can lag until refresh
(the normal session refresh cadence).

**Reversal condition.** If approvals need step-level context that a title cannot
carry, add a per-run "open task" link beside the main card before restoring task-local
buttons. If the child list grows beyond a readable count, add filtering or a
dedicated task list instead of an unbounded details block. If owners report that
the main card is too far from the task they are reading, restore a single
read-only reminder in the child record while keeping the decision in the main
conversation.

## 2026-11-18 — OCR and legacy .doc go through a native macOS helper

**Decision.** A second Swift executable, `CloneAIDocumentTool`, is compiled into
the app bundle. It reads the file bytes on stdin and writes plain text on stdout;
the Node side never writes a temp file. `ocr-pdf` renders each page at 2000 px
and runs Vision's accurate OCR over 1024 px bands with row grouping (20-page and
50k-character caps); it is used only when `unpdf` finds no text. `doc` parses a
legacy Word 97 file with AppKit's `NSAttributedString`. The Node side resolves
the helper from `CLONE_AI_DOCUMENT_TOOL` (set by the Swift shell) or a sibling
of the bundled Node; when absent, OCR and `.doc` are refused with a clear
message. The extractor accepts a test-injected runner, so unit tests do not need
the binary.

**Alternatives rejected.** `tesseract.js`/WASM adds a large runtime and language
data and is slower than the system framework; `tesseract` is not installed.
`textutil` for `.doc` needs a path and a temp file. Cloud OCR sends the owner's
documents off-device. PDF.js plus canvas still needs an OCR engine; PDFKit and
Vision are system frameworks.

**Evidence.** `command -v tesseract` returns nothing. AppKit parsed a `.doc`
generated by `textutil`. Vision OCR of a rendered scanned PDF was poor on the
full page (`Second fine with fom & ferry.`) but correct when tiled
(`Hello from a PDF fixture.` / `Second line with Tom & Jerry.`). A 45-line dense
fixture produced 33 rows starting with `Line` and 32 unique line numbers from a
53-row output — usable, not perfect; OCR accuracy is marked as variable.

**What it costs.** A second compiled executable and a helper-path env var; a
daemon started outside the app has no OCR/`.doc` unless the path is provided.
OCR is CPU-bound (20 pages at 2000 px can take seconds to tens of seconds) and
the request waits. Tiled row grouping can split or duplicate a line at a band
boundary. Legacy `.doc` depends on AppKit's Word 97 parser. Unit tests use a
fake runner; only the built app verifies the real Vision/AppKit path.

**Reversal condition.** If Vision accuracy is insufficient, switch to a vetted
Tesseract or another engine. If the daemon must support OCR, pass the helper
path. If `.doc` parsing fails, fall back to `textutil` with a short-lived temp
file. If OCR becomes common, make page/language options explicit and move it to
a bounded worker.

## 2026-11-18 — The window supervises its runtime: retry, probe, and say why

**Decision.** In the non-resident path — the packaged app spawned its own
sidecar — an exit is no longer terminal. The shell relaunches the sidecar with
exponential backoff (1 s doubling to a 30 s cap) and keeps the last four lines
of its stderr on the startup view. Both modes run a 5-second `/api/health`
probe once a URL is loaded; two consecutive failures count as a lost runtime,
and the shell re-attaches (resident) or terminates and relaunches the child. A
start that reaches 30 s without `CLONE_AI_READY` is treated the same way. A
resident attach that finds no endpoint retries every 30 s instead of stopping
after 60 s.

**Alternatives rejected.**

- *Keep the static "close and reopen" message.* On 2026-11-18 the runtime
  exited in `hydrate()` on every launch; the window told the owner to reopen,
  the owner did, and the next process died the same way. The message named no
  cause, and the stderr that carried it was captured into an in-memory buffer
  nothing read.
- *Rely on launchd alone.* `KeepAlive` keeps the daemon alive, but a packaged
  app launched from Finder never enters resident mode: the flag exists only in
  the LaunchAgent's environment (`apps/desktop/macos/main.swift:42`,
  `scripts/install-daemon.mjs:57`) and the bundle's Info.plist has no
  `LSEnvironment`. The window therefore spawns its own runtime and owns its
  liveness itself.
- *Show the error but do not restart.* Leaves a hung runtime as a window that
  never recovers; the first incident needed a restart that nothing performed.

**Evidence.** The 2026-11-18 incident: the 14:24 bundle's sidecar exited in
`CloneRuntime.hydrate` with `Invalid run status transition: failed -> verifying`
(journal sequences 525 and 545 for run `19252252…`). `main.swift` had no
`/api/health` caller and no timer after the termination handler; the page's
3-second retry (`apps/desktop/ui/app.js:1958`) never ran because the WebView was
never loaded. Reproduced by running the bundled runtime against a copy of
`~/.clone` (crash) and an empty home (ready). launchd logged 588 failures before
removing the job.

**What it costs.** A runtime that crashes deterministically now restarts every
30 s forever instead of stopping once — the attempt count, the backoff and the
stderr tail are what make that loop diagnosable instead of silent. The window
holds one loopback request per 5-second tick. The last stderr lines may name a
provider or a path; they are truncated to four lines / 600 characters and stay
in the local window. Quitting still stops a non-resident child; resident mode
still only detaches.

**Reversal condition.** If the runtime gains a supervisor-independent liveness
channel (a socket, or launchd socket activation), replace the HTTP probe with
it. If restarts are observed to duplicate scheduled work or to resurrect a
runtime the owner stopped on purpose, remove automatic relaunch and leave one
explicit "reconnect" action. If `/api/health` becomes authenticated, move the
probe to an authenticated client instead of widening the unauthenticated route.

## 2026-11-18 — A journal replay reflects what was recorded; writers validate

**Decision.** `reduceEvent` applies a recorded `run.status_changed` without
re-checking the transition table. The live writer (`CloneRuntime.changeStatus`)
asserts the transition before appending, so an executor's mistake is still
refused before it becomes a journal event. `assertTransition` remains exported
and used by `failRun`.

**Why it won.** The desktop app and the repair lane shared one data directory on
2026-11-18. The app's queue consumer recovered run `19252252` as failed at
06:14:08 because its lease looked dead, while the lane's own process kept
executing the same run and appended `verifying` at 06:14:21 — an illegal
`failed -> verifying` transition. Because the reducer validated transitions
during replay, the companion could no longer start: `hydrate()` threw, the
sidecar crashed, and launchd retried it into the same error every 30 s. One
raced event made the whole journal unreadable. The journal is the audit truth; a
reader must be able to reconstruct it even when a writer recorded something it
should not have.

**What was given up.** Replay no longer flags an illegal recorded transition.
The write-time assert in `changeStatus` keeps the guard on the normal paths;
`recoverOrphanedRuns` writes its own recovery transitions directly and only uses
allowed ones. The illegal event stays in the journal as evidence and surfaces in
the audit instead of crashing every projection rebuild.

**Reversal condition:** if an illegal transition appears in the journal with no
matching live-writer assertion, add a recovery-time warning (not a throw) that
names the run and event, or move validation into the journal's append path so a
bad writer is refused before the event exists.

## 2026-11-18 — A repair plan carries the working agent's decision

**Decision.** `npm run repair` gains `--decision <file>`: a short brief from the
working agent is included verbatim in both phase instructions, marked as expected
behavior rather than trace data. The regression phase must encode the behavior
the decision states; the fix phase must implement it. The lane records the brief
in its report.

**Alternatives rejected.**

- *Let the worker read the trade-off entry in `docs/`.* The plan deliberately
  forbids reading `docs/` to save rounds and because the tree describes the
  project, not the failure. Opening one file for one run would erode that rule
  for every run.
- *Put the decision inside a trace.* The traces are untrusted evidence; writing
  instructions into them would corrupt the boundary the prompt already warns the
  model about.
- *Only repair traces that name the production file and the wrong behavior.*
  That leaves decision-level changes — behavior an older rule intended, now
  reversed — unrepairable by the lane, which is the gap this run exposed.

**Evidence.** The 2026-11-18 Forbidden City repair stopped at its `not-red` gate:
phase 1 (run `19252252`) read all three traces, read `vendor/three.module.js`
(ENOENT), and answered without writing anything. The intended behavior lived in
the trade-off entry under `docs/architecture/trade-offs.md`, which the plan tells
the worker not to read. `git status` in the worktree showed only `.rsi/`; no
production file changed. The gate correctly refused a fix without a failing
reproduction.

**What was given up.** A few thousand characters of step context, and a new way
for the working agent to steer a repair. A brief can bias the regression case; the
lane still requires the case to be red and the fix to pass the full suite, so an
invented reproduction fails the same gate.

**Reversal condition:** if decision-carrying repairs still produce no red case,
or the brief biases the worker into a reproduction the trace does not support,
remove the option and restrict the lane to traces that name the production file
and the wrong behavior.

## 2026-11-18 — Untracked workspace files are copied into the isolated worktree

**Decision.** When an external step runs in an isolated git worktree, the owner's
untracked, non-ignored regular files are copied into that worktree after
`git worktree add`. Tracked content still comes from HEAD; ignored files and
symlinks stay out. The owner authorized this as a hand fix ("改隔离复制") outside
the repair lane, for the same reason as the earlier verifier exception: the fix
has to land before the next App run can produce a model at all.

**Alternatives rejected.**

- *Commit the vendor directory into the workspace repository.* Done as an
  interim workaround (`a2ae04e`), but any input the owner has not committed — a
  downloaded model, a generated asset — would fail the same way, and importing
  files into the owner's repository is a change they did not ask for.
- *Copy every uncommitted change, including modified tracked files.* That turns
  the snapshot from "HEAD of the owner's repository" into "a moving copy of the
  working tree"; a black-box CLI's run would no longer start from a reproducible
  base.
- *Copy ignored files too.* `node_modules` and build output make sandbox
  creation large and slow for no observed benefit; ignored files are derivable
  from the tracked tree.
- *Refuse to start and ask the owner to commit first.* The owner's request was a
  one-query run; requiring a git commit is another manual step in the loop this
  work exists to remove.

**Evidence.** Runs `560e7a43`, `5909c705` and `87c526d5` failed with
`Required input missing: vendor/three.module.js` inside
`~/.clone/isolated-workspaces/...` although the file existed in the workspace:
`git worktree add` materialises HEAD only. `git ls-files --others
--exclude-standard` run from the workspace root lists exactly the untracked
inputs (`vendor/three.module.js`) and excludes an ignored `.log` fixture in a
scratch repository — the command the patch uses.

**What it costs.** The sandbox can now carry files the owner never committed,
including an untracked secret; the worker can read them. Sandbox creation pays
for copying those bytes.

**Reversal condition.** If an untracked secret reaches model context where it
should not, restrict the copy to files the plan names as inputs, or to a
configured allowlist. If sandbox creation becomes slow, cap the copied bytes and
report what was skipped.

## 2026-11-18 — A path mentioned in instructions is not a required input

**Decision.** The native worker fails a step for a missing required input only
when the plan declares that path as an input it must have — not because the path
merely occurs in the objective, instructions or acceptance criteria. A path that
was once missing but is later read successfully or written during the run no
longer counts as missing at the end. The patch itself is produced by the repair
lane (`npm run repair`) from the exported trace, as AGENTS.md rule 4 requires;
this entry records the decision the patch must satisfy.

**Status (2026-11-18).** Implemented by the repair lane in commit `fb496e5b`
(branch `rsi/auto-fix-20261118T0913`, fast-forwarded into `main`): the worker
reads `workOrder.inputs` where `required: true`, clears an input that is later
read or written, and its prompt stops only for declared inputs. The
two-direction regression test is `test/regression/native-missing-input.test.js`.

**Why it won.** Run `87c526d5` planned "first re-check vendor/three.module.js:
the previous two runs reported it missing", and its acceptance criterion asked
for the file to exist. The worker's first read returned ENOENT, the missing set
is never cleared, and the guard at `native-agent-worker.ts:348` failed the step
before any terminal reason — even though the model then found three usable
copies under `eval-runs/` and never wrote anything. It used 11 of 12 rounds and
42.7 s, then stopped because the worker prompt also says to stop and report a
missing file. Three separate submissions failed the same way. The 2026-11-05
entry that introduced the rule named this reversal condition: legitimate work
aborted because a path that merely appears in text is treated as required.

**What was given up.** A worker may now spend a step on a path the plan did not
declare as an input, and report a partial result where the old rule would have
aborted. The strict check remains for declared inputs, so a missing declared
input still fails; only the heuristic that turned prose into a requirement is
gone.

**Reversal condition:** if a worker reports success on a step whose declared
required input was missing, restore the strict check for declared inputs and
narrow elsewhere. If planners start declaring inputs broadly to satisfy the
check, fix the planner instead of widening the rule.

## 2026-11-18 — Archived memories can be permanently deleted, and archiving comes first

**Decision.** The memory panel gains a permanent delete. An archived memory can
be removed from disk — its `.md` file under `memory/archived/`, its
`memory-index.db` rows (`memories`, `memory_terms`, `memory_term_weights`,
`memory_versions`, `memory_mutations`) — and the decision is journaled as
`memory.deleted`, with the summary, before anything is unlinked. An active
memory must be archived first. The `已归档` stat card also becomes a filter
control, so the archived set is one click away instead of hidden behind the
status `<select>`.

**Alternatives rejected.**

- *Keep archived files forever.* `MdMemoryStore` exposes commit, update, archive,
  restore, expireDue, syncFromFiles and stats; `MemoryGovernance` journals
  promote, reject, author, update, undo, archive and restore. Nothing can remove
  an archived file. The installed home shows the result: the panel counts one
  archived memory, and `~/.clone/memory/archived/mem-30cddb43-5da.md` sits there
  with no control that reaches it. "Your files" is only true while you can
  delete them.
- *Delete from any status in one step.* The only irreversible memory action
  would sit one click from the default view. Archive is already the reversible
  step (`restore()`), so requiring it keeps the lifecycle legible.
- *Soft-delete or hide the id.* The file, terms and version rows would still be
  scanned and counted; the owner asked for deletion, not for a hidden row.

**What was given up.** One extra click to delete an active memory; the version
rows of a deleted memory disappear with it, so a delete cannot be undone. The
physical delete removes the `.md` file and the index rows, not the audit trail:
earlier journal events (`memory.authored`, `memory.updated`, `memory.archived`,
`memory.recalled`) still carry the id and often the summary. Erasing the audit
is a second, larger decision; this entry does not take it. The store unlinks both
possible files before deleting rows: if a crash lands between the two, the next
`syncFromFiles()` folds the row-less file into a new archived entry rather than
silently resurrecting a deleted active one. In the other order an orphan `.md`
would be re-added as a new memory.

**Reversal condition:** if owners routinely abandon the archive-first step, add
a one-step delete with a stronger confirmation. If a retention or recycle-bin
policy lands, replace the hard delete with it. If a later audit requirement
needs version rows to outlive the memory, stop deleting `memory_versions` and
keep a tombstone instead.

## 2026-11-18 — Deleting an audit invocation is a tombstone, not an erased ledger line

**Decision.** The Agent-invocation view gains server-side search across the whole
shared ledger plus delete/restore. Deleting appends
`{"phase":"deleted","id":…}` to `~/.clone/audit/invocations.jsonl`; a later
restore appends `restored`. Reads fold the last such line into a `deleted` flag
and hide flagged records unless the caller asks for them (`includeDeleted=1`).
The original `started`/`completed`/`failed` lines are never removed. Bulk delete
marks only the records currently loaded in the filtered list, so the owner
always sees what is about to go.

**Alternatives rejected.**

- *Rewrite the JSONL to remove the lines.* The ledger is shared by every surface
  (CLI, desktop, WhatsApp, external agents) and appended by several processes at
  once; a read-modify-write can drop a concurrent append. It would also destroy
  the only evidence of what was asked and answered, which is the opposite of an
  audit ledger's purpose.
- *Hide deleted records only in the browser.* Other surfaces and the API would
  keep showing them, and a refresh would resurrect them.
- *Keep a separate deleted-ids file.* That splits one append-only truth into two
  files that can disagree after a crash; a record could stay visible though the
  owner deleted it, or disappear though it never was.
- *Delete the Run journal together with the invocation.* They answer different
  questions (who called versus what ran); deleting one must not silently delete
  the other's evidence.

**Evidence.** `readInvocations` already folds multiple lines per id (start plus
end), so a third phase is the same merge, not a new storage path; the ledger
writes are best-effort appends. The session sidebar already applies the same
principle: a deleted session is hidden from the list while its audit record
stays marked deleted, so an eval never loses a run. The hide → search → restore
path is covered by `test/invocation-ledger.test.ts` and
`test/companion-control-plane.test.ts`.

**What it costs.** The file still grows; deletion reclaims no disk. A deleted
record remains readable through `includeDeleted=1` and the REST detail endpoint,
which is intentional but means this is privacy hygiene, not erasure. Search
reads and scans the whole ledger per query (debounced in the UI); at the current
size that is milliseconds, but it is O(file) per search.

**Reversal condition.** If the ledger needs true erasure (a secret in an old
prompt, a legal deletion request) or compaction because search latency becomes
visible, add a compaction/redaction step that rewrites the file under an
exclusive lock; until then tombstones stay.

## 2026-11-18 — PDF and .docx are extracted before the turn, not handed to the model

**Decision.** The composer accepts PDF and `.docx` files up to 10 MB each, next
to images, videos and text documents. The backend extracts their text inside the
request — PDF through `unpdf` (a serverless PDF.js build), `.docx` through a
small built-in OOXML reader over `node:zlib` — and treats the result exactly like
a text document: it reaches the model in that turn as a delimited data block,
while the ledger keeps only a name/size manifest. Extracted text shares the
50,000-characters-per-document and 100,000-characters-total caps; a longer
document is truncated with an explicit marker and a completion notice rather
than refused, because the owner cannot know a PDF's character count before
attaching it. A PDF with no extractable text (a scan) and legacy `.doc` are
refused with reasons; OCR is not part of this change. No file is written to the
workspace or a temp directory; the bytes stay in memory.

**Alternatives rejected.**

- *A native PDFKit/textutil helper compiled into the app.* The app is macOS-only
  today, but this would add a second executable, path plumbing through the Swift
  shell and the launchd daemon, and tests that depend on system tools. An
  in-process parser keeps one extraction path for the app and the tests.
- *`pdfjs-dist` directly.* It is 37.6 MB unpacked; `unpdf` is a 3.1 MB MIT
  serverless build of the same parser, which is enough for text extraction.
- *`mammoth`/JSZip for `.docx`.* A `.docx` is a ZIP of XML; a small reader over
  `node:zlib` handles the document body without another dependency (and its
  transitive tree) for one format.
- *OCR (Tesseract) for scanned PDFs.* A large platform-specific dependency for a
  case that is better refused explicitly until it is requested.
- *Writing the file into the workspace and letting the model read it.* The Main
  Agent's file tools are disabled; attachments stay turn-local and do not create
  a second authority path.

**Evidence.** `npm view` reports `unpdf@2.2.1` under MIT at 3,143,154 bytes
unpacked, `pdfjs-dist@6.5.438` under Apache-2.0 at 37,616,588, and
`mammoth@1.13.0` under BSD-2-Clause at 1,671,388. The repository has no
production PDF, ZIP or Word parser; `unzipper` exists only as a transitive
development dependency. The app is packaged as a Node runtime, so an
in-process parser resolves from the bundle like every other dependency. The
50,000/100,000-character caps already bound the context cost of text documents;
binary extraction adds CPU, so a 10 MB file cap and a page cap are needed. The
assumption that `unpdf` extracts the common text-based PDFs used here, and that
scanned PDFs yield no text, is marked and is checked by the eval fixtures below.

**What it costs.** A 3.1 MB dependency and its transitive tree; lazy-loading
keeps it out of the sidecar's startup path. PDF parsing is CPU-bound inside the
request, so a 10 MB or many-page PDF delays the reply; the page cap bounds it.
Extraction quality depends on the producer: scanned or image-only PDFs are
refused, and complex layouts lose structure. The `.docx` reader covers standard
OOXML text runs and paragraphs, not legacy `.doc`, encrypted files or unusual
field structures. Untrusted PDFs now reach an in-process parser; the owner
selects the file and the app is local, but this is a new parser surface.
Truncation means a long document is only partially read.

**Reversal condition.** If `unpdf` fails on common PDFs, switch to
`pdfjs-dist` or a sandboxed PDFKit helper. If the built-in `.docx` reader fails
on ordinary Word files, adopt `mammoth`. If scanned PDFs become a common input,
add OCR deliberately or move extraction to a bounded worker with a timeout. If
the Gateway gains native document parts, carry the file as a native part
instead.

## 2026-11-18 — Text documents attach inline; PDFs and cross-turn document text wait

**Superseded (same day).** PDF and `.docx` are now extracted on the backend; see
the newer entry above. The inline, turn-local decision for text documents still
stands.

**Decision.** The composer accepts text-like documents alongside images and
videos, from the file panel or a drag-and-drop: any `text/*` file plus the
common source/config extensions, up to 4 attachments per message, 50,000
characters per document and 100,000 characters across documents. The UI reads
the file as text and sends it in the request; the Main Agent renders each
document as a bounded, clearly delimited data block in the current turn. The
turn ledger and conversation history record the owner's typed message plus a
manifest (names and sizes), not the document bodies. PDF, binary and compressed
files are refused with a reason. The native `NSOpenPanel` now allows `.text`,
`.json` and `.commaSeparatedText` in addition to `.image` and `.movie`, and the
WebView accepts a drop anywhere in the window.

**Alternatives rejected.**

- *Write the document into the workspace and let the model read it with a tool.*
  The Main Agent runs with built-in file tools disabled; adding a read path for
  attachments would hand the model a broader filesystem surface, persist the
  owner's documents on disk, and need a new authority decision. Inline text
  keeps the attachment inside the governed turn.
- *Add a PDF parser (pdfjs-dist or a native helper).* The bundle ships only
  `typebox`; a parser would add a dependency and a second decode path for one
  format. PDF support waits until it is actually requested.
- *Use provider-native document/file content parts.* The Gateway is
  OpenAI-compatible and today carries images as `image_url`; document parts are
  not guaranteed across models and a text-only model would 400. Inline text
  works with every model that can read text.
- *Persist the full document text in the ledger and history.* Up to 100,000
  characters would be repeated to the provider on every later turn and stored a
  second time. The manifest keeps the audit honest about what was attached
  without that cost.

**Evidence.** The composer before this change accepted only
PNG/JPEG/GIF/WebP/video (`apps/desktop/ui/index.html` accept list) and
`parseAttachments` accepted only four image signatures
(`src/main-agent/attachments.ts`); the owner reported adding files was clumsy.
`package.json` has no PDF or document parser dependency. The 100,000-character
total is about 25,000 tokens under the existing 128,000-token window, leaving
room for the system prompt and history; the loop's token-aware compaction still
runs if the rest exceeds the threshold. This is an assumption based on the
common four-characters-per-token estimate, not a measured provider count for
the attached files. The eval is deterministic: `test/attachments.test.ts` gains
accept, reject and compose cases, `test/native-main-agent.test.ts` captures the
provider request and asserts the ledger keeps only the manifest, and
`test/desktop-shell.test.ts` asserts the drop handlers and the native panel
types.

**What it costs.** Documents live in the turn that carried them: a later
follow-up that asks about their contents must reattach the file, because history
holds only the manifest. A 100,000-character attachment can cost roughly 25k
input tokens per turn. PDF, Word, and other binary formats stay unsupported.
Adding `text/*` to the native panel also widens what the picker shows, so the UI
must reject a text file that is too large or binary after reading it.

**Reversal condition.** If the Gateway gains native document parts or a
document-aware model, carry documents as native parts instead. If owners
routinely ask follow-ups about an earlier document, add a governed attachment
store and a read tool rather than growing the manifest. If PDF requests become
common, add one vetted extractor and cover it with the same size and signature
tests. If a 100k-character attachment regularly triggers compaction, lower the
cap or extract only the relevant sections.

## 2026-11-17 — The desktop app is the only product surface; the CLI and headless server are removed

**Decision.** `src/cli/clone-ai.ts` (33 command surfaces), its `bin` and `cli`
npm entries, `src/server-main.ts`, `Dockerfile`, `compose.server.yml`, `deploy/`,
and the developer `npm run main` entry are removed. The macOS desktop app — a
native shell over `src/desktop-sidecar.ts` and the loopback companion server —
is the only way to talk to the twin. Owner capabilities that existed only in
the CLI are added to the desktop: an authority editor in 权限与安全, owner-data
export in 记忆与数据, bad cases and improvement approvals in 审计与评估, and a
cancel action for active runs. The maintenance loop keeps non-product entry
points as npm scripts — `traces`, `selfcheck`, `repair`, `audit:export`, and the
existing `bench` — because they are automation, not a second user interface.
The standalone WhatsApp bridge stays: the desktop's 手机通道 panel depends on
it.

**Evidence.** A dependency map of the whole repository found that every desktop
launch mode runs `node --experimental-strip-types src/desktop-sidecar.ts`
directly — the dev driver (`scripts/desktop-dev.mjs`), the packaged shell
(`apps/desktop/macos/main.swift:533-563`), and the launchd job
(`scripts/install-daemon.mjs:38-52`) — and no `src/` module imports the CLI; only
two tests and documentation reference it. 23 of the CLI's 33 surfaces were
duplicates of an existing HTTP route or desktop panel. The remaining eight were
`export`, `traces`, `repair`, `bench`, `selfcheck --repair`, `resume`, `doctor`,
and `--help`/`--version`; among them, `exportOwnerData`, `exportFailedTraces` and
`runRepairLane` had no caller outside the CLI. Four owner capabilities existed in
the HTTP API but had no desktop caller: authority, improvement, bad cases, and
run cancellation. The macOS bundle already copied the whole `src/` tree, so the
CLI shipped inside `Clone AI.app` unreachable.

**What it costs.** Terminal users lose a scriptable interface, and external
automation that calls `clone-ai` breaks; we cannot inspect callers outside this
repository, so that breakage is marked unverified. Owner operations now
depend on the app window (or the maintenance npm scripts); if the app cannot
start, there is no fallback owner console. The desktop UI grows by four panels
and one action, and the repair lane's documented first step changes, so
`AGENTS.md` rule 4 must change in the same commit. Removing the server entry and
Docker deployment gives up Linux/headless hosting; that path would have to be
rebuilt deliberately if it is wanted again.

**Not ported, and why.** `doctor` printed the clone home, Node version, model
endpoint and worker list; the desktop already shows the first three across
Agent/情境, and the worker list is a constant now that black-box worker CLIs are
gone. `resume <n>` wrote a pointer that only the CLI wrote and only the context
view read; desktop conversation selection lives in `localStorage`, and the
Main Agent turn ledger does not use the pointer, so porting it would create a
second source of truth. `install` and `workers` were stubs that always failed or
printed a constant; `model` and `effort` are already editable in desktop
settings. `app` and `gui` only launched or announced the app itself.

**Reversal condition.** If a headless or scriptable owner interface is needed
again (CI, a remote host, or a phone-only workflow), add a separate thin client
or API package rather than re-growing a CLI inside the desktop product. If an
owner action cannot be expressed in the desktop UI, add it there first; only if
that is impossible should a dedicated script become a documented entry point. If
external users report relying on the `clone-ai` binary, restore a compatibility
shim or publish a migration path before removing the workaround.

## 2026-11-18 — The audit names every tool a worker called, and 3D is judged by interaction

**Decision.** A Run audit record now carries `executions[].tools`: the ordered
tool calls of each execution (name, redacted input summary, duration, error),
capped at 200 with an explicit `…` marker when more were dropped. The audit
detail renders it as a collapsible list under every execution. Separately, the
3D capability task is now an **interactive model**: the page must render on
load, left-drag must change azimuth by ≥10°, wheel must reduce the camera
distance to ≤0.9×, and `window.getForbiddenCityView()` must report the real
camera state. A static PNG or a fixed-camera video no longer satisfies the task.

**Evidence.** The owner's report was "我要在 clone app 的审计轨迹看到这些执行的具体
信息" after a run whose worker had navigated, evaluated and taken four screenshots:
those calls left **no evidence rows** because MCP tools declare no `pathOf`, and
the audit record carried only `progressEvents` (a count) plus path-based
evidence. `AuditExecution` had no field for tool calls at all. The same owner
rejected the earlier deliverable as "我不想只要一个 png ... 能放大进不同的角度":
the task demanded a 30-second timeline and a rendered MP4, which is exactly a
fixed camera, and every check graded data or a still image — none of them could
tell an inspectable model from a picture of one.

**Owner turns are labelled `desktop`.** A query that arrives without an
`x-clone-caller` header is the owner through the app; recording it as `unknown`
made every owner turn in the audit unreadable. An explicit caller (a benchmark,
a bridge) still wins. This is the same record, not a second one: a reader should
never have to guess who started a run.
所有者的回合标记为 `desktop`。没有 `x-clone-caller` 头的查询就是所有者通过 App 在说话；记成
`unknown` 会让审计里每一回合都读不出是谁。显式调用方（评测、桥接）仍然优先。这属于同一条记录，
不是第二条：读者不应该需要猜是谁启动了 Run。

**What it costs.** The record grows by up to 200 small entries per execution;
`inputSummary` is already redacted and bounded to 240 characters, and the cap
is stated rather than silent. Interaction checks run two synthetic gestures
against the page, so a model that supports orbit through keyboard or touch but
not mouse-drag fails; the requirement is written in the prompt, so this is a
declared contract rather than a hidden preference. A page that fakes
`getForbiddenCityView()` could report changes without moving the camera; the
screenshot at three angles is the evidence that keeps that honest, and a later
reader can add a pixel-difference check between the post-drag and pre-drag
frames.

**Reversal condition.** If owners never open the tool list, fold it into the
existing trace view instead of duplicating it in the record. If mouse-drag-only
gating blocks a legitimate touch-first model, accept a keyboard/touch gesture as
an alternative and test whichever the README documents. If a page passes the
view API checks but its screenshots do not change between angles, replace the
declared deltas with a frame-difference check.

## 2026-11-17 — A tool result can carry an image, so a worker can see what it rendered

**Decision.** Tool results may now return images, and MCP image blocks are
forwarded instead of replaced by `[image block omitted]`. The worker can be
given the owner's installed **Playwright MCP** server (`browser_navigate`,
`browser_resize`, `browser_evaluate`, `browser_take_screenshot`) through the
existing `mcp.json`, so it renders its own scene and *looks at it* inside one
turn, instead of writing code it cannot see and being judged by an external
checker afterwards. No new bespoke screenshot tool is written: the first choice
is the existing, maintained server.

**Evidence.** Worker tools were exactly `read_file`, `list_directory`,
`write_file`, `edit_file`; `NativeToolSpec.run` returns `{ output: string }`
(`src/workers/native-agent-worker.ts:58`), `AgentToolResult.content` is
`string` (`src/agent/loop.ts:43`), and the OpenAI-compatible serializer turns any
non-string tool content into `""`
(`src/workers/openai-compatible-client.ts:135-140`). `textContent` in the MCP
client replaced every non-text block with `[image block omitted]`
(`src/workers/mcp-client.ts:744-756`). The consequence was measured over five
attempts: the worker could satisfy a data contract 24/24 while the render was
"建模的细节完全不够，跟一个平面图一样", and the only way to close the gap was
external checks plus prompt edits — repeated query-adjust cycles the owner
explicitly does not want ("一次 query -> answer 好"). Playwright MCP is already
installed at
`~/.config/magpie/mcp-npm/1b491aa4633d80d1/node_modules/@playwright/mcp/cli.js`
and exposes those four tools, one of which returns PNG content blocks.

**What it costs.** An image in a tool result is re-sent on every later round of
the same turn, so one 1920×1080 screenshot costs roughly 1.5k tokens per round
(a fixed per-image charge already exists in `token-estimate.ts`); a worker that
screenshots every iteration will spend its budget on images. The MCP server is
an execution surface: Playwright launches a real browser and can reach
`file://` and the network, so it must be declared with an explicit risk in
`mcp.json` and limited to the workspace, not offered by default. Images are
untrusted input rendered by a third-party page, which is why they travel as
`image_url` data with no tool-call semantics attached.

**Reversal condition.** If workers burn their round or token budget re-reading
screenshots, cap images per turn or downscale to 1280×720 before forwarding. If
the MCP image path proves flaky across providers (some gateways reject image
parts in tool messages), fall back to a first-party `render_scene` tool that
returns one PNG and a numeric summary. Do not go back to string-only tool
results: that is what forced the external-checker loop this replaces.

## 2026-11-17 — Detail is graded by counts and shadows, not by prose

**Decision.** The Forbidden City benchmark gains four hard checks that make
"detail" falsifiable instead of aesthetic: `model.roof-detail` (≥3 roof
segments and ≥24 tile ridges per listed hall), `model.dougong` (≥40 bracket
pieces), `model.facade-detail` (≥32 mullions and ≥36 door studs), and
`browser.shadows`, a pixel probe that reads the WebGL framebuffer and asks
whether the ground under the eaves is measurably darker than the median
pavement tone (≥2% of sampled pavement pixels more than 8 levels below the
median). The model must report these counts under `detail: { roofSegments,
tileRidges, dougong, windowMullions, doorStuds }`, built from the construction
data rather than written as constants.

**Evidence.** The owner's judgement of the 24/24 re-run was "建模的细节完全不够，
跟一个平面图一样", and the pixels agree: in the center crop, 83–87% of pixels are
near-flat (luminance gradient < 1.5) and the fragment has ~650 distinct 5-bit
colors. Cropped at 1:1 the roof is one smooth yellow sheet, the bracket layer is
a single green band, and the pavement has no shadow anywhere. The render holds
only 221,850 triangles and 71 batched `add` sites, and
`grep castShadow\|receiveShadow\|shadowMap` over its `src/` returns nothing. The
earlier checks could not see any of this because every one of them grades data
or geometry, never the rendered surface. The shadow probe is the one signal that
distinguishes the two runs: attempt E scores **0.0%** darker pavement, below the
2% floor, while the probe's own calibration on a shadowed reference frame clears
it.

**What it costs.** The counts reward *quantity*, not taste: 24 tile ridges and 40
brackets can be ugly, and a model that pads counts will pass. That is accepted
because the alternative — a prose criterion — is what already passed a floor
plan. The pixel probe assumes the frame's lower-middle band contains pavement,
which is true for the three-shot camera the task requires but would misread an
aerial-only camera; the threshold is deliberately low (2%) so it detects "no
shadows at all" rather than grading shadow quality. The center-crop flatness
metric is **not** used as a check: measured across C, E and the game/video
references it did not separate good from bad (E 83.2% vs C 84.9%), so it stays
in `pixel-detail.mjs` as a diagnostic and a reader must not treat it as a gate.

**Reversal condition.** If a run passes all four counts and its screenshots
still read as a floor plan, replace the counts with a human screenshot review —
do not add more counts. If the shadow probe produces a false pass (darker
pavement from a painted texture rather than a shadow map), read the renderer's
`shadowMap.enabled` instead and keep the pixel probe as a second signal. If most
tasks move to aerial-only cameras, crop the probe to the platform band.

## 2026-11-17 — The verifier reads negation, and naming `tests/` no longer demands a test run

**Decision.** Two judgment bugs found by the Forbidden City benchmark are fixed
by hand, as an explicit, recorded exception to AGENTS.md rule 4 (see the last
paragraph). `extractFileExpectations` no longer treats a path the plan says
*not* to claim as a promised file, and `mentionsTests` only classifies a step as
a test step when it asks for a test *run* — an acceptance criterion like
`npm test passes`, a run request in either language, or a shell command in a
command context — not when `tests/` is merely a deliverable or the plan honestly
says the tests were not executed.

**Evidence.** The 2026-11-17 benchmark: attempt C delivered 20 files, 6/6 tests
and 21/21 external-contract checks, and the Kernel still failed the Run with
`"out/video.mp4" was promised but does not exist on disk` — from the sentence
`不要声称 out/video.mp4 已生成` — and `a test step needs test evidence with a
locator` — from `tests/` listed as a deliverable. Both reproduced in one-line
calls before the fix, and both are now gate cases
(`benchmark/gate/verdict-cases.json`: `negated-path-is-not-a-deliverable`,
`tests-named-as-deliverable-needs-no-test-evidence`) plus unit cases in
`test/verification.test.ts`. The failure mode was the worst kind for this
project: **honest disclosure punished**, which trains the agent to stop saying
what it did not do.

**What it costs.** Negation detection reads only the clause before the path, so
an unusual construction ("not only X but out/video.mp4") could hide a real
deliverable; the mixed-case unit test pins the common form. `mentionsTests` is
now a heuristic over run-request phrasings rather than a single word, so a
plan that expects a test run using wording none of the patterns cover would
not be gated — a miss is safer here than the false failure it replaces, because
the file and evidence verifiers still apply. Both functions are on the repair
lane's `PROTECTED` list, so the lane cannot produce this fix: AGENTS.md rule 4
("fixes come from the repair lane") and the lane's own invariant ("a repair must
not edit its own verifier") directly conflict for this class of bug. The owner
authorized a hand fix for this case and it is recorded here rather than hidden;
the other defects from the benchmark (§ the specification dropped by
`dispatch_task`) are not verifier code and remain for the repair lane.

**Reversal condition.** If the negation heuristic starts hiding real promised
files in production, restrict it to the exact "do not claim" phrasings and log
the dropped paths as an observation instead. If `mentionsTests` misses a real
test step and a run completes without tests, add the phrasing to
`TEST_RUN_REQUEST` and add the case to the gate. Do not restore the bare
`\btests?\b` match: it is what punished honesty.

## 2026-11-17 — The Forbidden City benchmark grades an external contract, and keeps harness and modeling apart

**Decision.** A new capability benchmark,
[`benchmark/capability/forbidden-city/`](../../benchmark/capability/forbidden-city/README.md),
asks clone-ai to model the Forbidden City's central axis and grades it against
an external contract rather than internal consistency: named halls, the
historically correct roof form for each, the shared three-tier platform, a
measured axis, and the published 太和殿 dimensions, all exposed through
`window.getForbiddenCityModel()` and read by a supervisor checker from the
running page. It runs in two variants — a **natural** prompt that lets the Main
Agent choose its tool, and a **plan-steered** prompt that requires
`propose_work_plan` with one self-contained step — and reports modeling only
when the specification is proven to have reached the worker.

**Evidence.** The 2026-11-17 capability eval graded its 3D task 3.6/5 on a scene
that rendered correctly; the supervisor's own notes record that the cloud sea
was below the camera path and never visible, and that no post-processing pass
existed. Every automated check that task had (tests, seeded timeline, a render
script) is internal: a city with arbitrary composition would have passed. The
first Forbidden City runs then measured the harness half directly: both natural
attempts produced **zero artifacts** because `dispatch_task` → `runQuery` →
`buildFallbackPlan` replaced the Main Agent's task with a generic
`local-draft` work order, and `buildInstructions` passes the work-order
objective (`src/workers/native-agent-worker.ts:460`), so the worker received
“只在本地准备可修改、可回退的结果” instead of the task. The plan-steered variant
did reach the worker, which is why it is the run that can score modeling.

**What it costs.** A second 3D-shaped task and checker to maintain, and the
expected values (roof forms, 961 m axis, 64×37×35 m hall) are the checking
model's training knowledge, not a citable source — `expected.json` says so and a
reader with a better source can replace it without touching the checker. The
natural variant spends two runs to say “the specification did not arrive”, which
is cheap and is the point. The checker's render step is opt-in because 900
frames take minutes; the default run measures the model, the tests and the
browser.

**Reversal condition.** If `dispatch_task` starts routing the task's
objective/criteria into the work order (the P0 in
[`ANALYSIS.md`](../../benchmark/capability/forbidden-city/ANALYSIS.md)), re-run
the natural variant and, if it produces artifacts, drop the plan-steered variant
and keep one prompt — two variants exist only to separate the two questions. If
a sourced architectural dataset (for example a surveyed BIM or gazetteer) becomes
available, replace `expected.json` with it and treat the current ±10% dimensions
as a fallback for readers without one. If the benchmark's modeling checks stop
discriminating (a model that satisfies all of them still looks obviously wrong in
the screenshots), add a human screenshot review rather than more regex checks.

## 2026-11-17 — The endpoint is saved in config.json, and the key is write-only

**Decision.** `config.json` gains `mainAgentBaseUrl` and `mainAgentApiKey`
alongside the model. Resolution is environment first, then config, then a clear
error naming the missing variables. The settings API returns
`hasMainAgentApiKey` instead of the value, `PATCH /api/config` accepts both
fields, applying a Magpie model also pins the gateway endpoint, and every atomic
JSON write is now mode 0600.

**Evidence.** The audit's second blocker: `mainAgentModel` was the only endpoint
field persisted, while `readNativeMainAgentEndpoint` read the base URL and key
from `process.env` alone (`src/main-agent/native-runtime.ts:162-175`), and the
Swift shell forwards only its own environment (`main.swift:494`), which is empty
when macOS launches an app from Finder. The result was a packaged app in which
every turn failed. The same audit found the sidecar never set `umask` while
server mode did (`src/server-main.ts:18`), so config, journal and endpoint files
were created world-readable.

**What it costs.** The credential now lives on disk (0600, owner-only) rather
than only in the process environment, which widens the blast radius of a backup
or an export that ignores permissions. The key is write-only over the API, so the
owner cannot verify it by reading it back; the only checks are that it was stored
and that a turn succeeds.

**Reversal condition.** If the OS keychain becomes available to the daemon
without a prompt on every start, move `mainAgentApiKey` there and keep the config
field only as a migration pointer. If an owner needs to audit a stored key, add
an explicit "reveal" action with a second confirmation rather than making GET
return it.

## 2026-11-13 — The runtime is a launchd job, and the app is only a window

**Decision.** A per-user LaunchAgent (`ai.clone.companion`) owns the companion
process: `RunAtLoad` starts it at login, `KeepAlive` restarts it after a crash,
`ThrottleInterval` 30 stops a crash loop. The desktop app no longer spawns the
daemon. In resident mode it reads the endpoint the daemon publishes
(`~/.clone/companion-endpoint.json`, honouring `CLONE_HOME` /
`CLONE_AI_HOME` / `CLONE_AI_DATA_DIR`), loads it, and re-attaches when the port
changes. Quitting the app detaches; it never terminates the runtime.
`node scripts/install-daemon.mjs` installs or removes the job.

**Evidence.** Before this change `applicationShouldTerminate` sent SIGTERM, then
SIGINT, then SIGKILL to the daemon it had spawned (`apps/desktop/macos/main.swift:139-166`),
and nothing started it at login: no companion plist, no login item, no
`SMAppService` anywhere. The twin therefore existed only while a window was
open, which contradicts "personal agent". The audit that produced this decision
ran ten readers over eight capability dimensions and ranked "the twin cannot
stay resident" as the first blocker.

**What it costs.** The runtime now depends on `launchd` being the supervisor: a
crash is restarted (good) but the app can no longer stop it by quitting, so the
owner needs the uninstall command to take it down. Development mode keeps its
in-process supervision behind `CLONE_AI_RESIDENT_DAEMON`, so the hot-reload
path is unchanged. A second copy of the app cannot own the runtime either — it
attaches, which is the point.

**Reversal condition.** If `launchd` proves unsuitable on a target platform
(Windows, Linux, or a sandboxed Mac App Store build without `LaunchAgents`),
swap the supervisor for that platform's service manager behind the same
"publish an endpoint, attach to it" contract. Do not reintroduce
spawn-and-kill-by-quit.

## 2026-11-13 — The Main Agent reads project instruction files, labeled by trust class

**Decision.** The Main Agent loads `AGENTS.md` / `CLAUDE.md` from the workspace
(plus `.claude/CLAUDE.md`, `.claude/rules/*.md`, `CLAUDE.local.md`), up to 64 KiB
in total, and appends them to its system prompt under a labeled heading that
says they are project instructions, not memories the owner approved. An
`@path` import expands to depth 3, only when the imported file stays inside the
workspace. The governor is `CLONE_AI_PROJECT_INSTRUCTIONS=0`, which turns the
whole layer off.

**Evidence.** Before this change nothing in `src/` read either file: the only
loader shipped is `src/skills/skill-loader.ts`, which accepts `SKILL.md` under
explicit skill roots. The consequence is visible in the repository itself —
`AGENTS.md` at the root of this checkout tells every agent to write a trade-off
before an optimization and to run `npm run gate`; clone-main never saw it. The
2026-11-13 memory comparison measured this as one of four gaps against Claude
Code 2.1.319, whose loader reads managed / user / project / local `CLAUDE.md`
with `@import` depth 5, a 4 MiB read cap, and injection labeled by trust class
(extracted from the installed 2.1.319 binary: the `Project` / `Local` /
`AutoMem` / `Managed` / `User` labels).

**What it costs.** The instruction layer is owner-editable text the runtime
cannot verify: a repository that ships a hostile `CLAUDE.md` now influences the
Main Agent's prompt. That is why it is capped, labeled, and switchable, and why
imports may not escape the workspace. Prompt-cache reuse also drops for the
static prefix whenever an instruction file changes, because the content sits in
the system prompt rather than after a cache boundary. The loader deliberately
does not read `~/.claude` or managed policy files: clone-ai has no equivalent
policy source, and reading another product's configuration would bind the twin
to its layout.

**Reversal condition.** If instruction files grow past the cap often enough that
the Main Agent loses project rules, raise the cap rather than add partial-file
inclusion — a half-read rules file is worse than a labeled truncation. If the
prompt-snapshot hash shows the instruction layer churning every turn (a tool
rewriting the file), move the layer to a cache-stable position or hash it out of
the system prompt.

## 2026-11-13 — Memory edits are versioned, and an undo restores the previous version

**Decision.** Every owner-visible change to a memory (author, update, archive,
restore) records a version snapshot — the fields before the change plus the
journal sequence that made it — in a `memory_versions` table. `MemoryGovernance
.undo(id)` restores the version before the latest change and journals a
`memory.updated` event whose payload says `source: "undo"`, `restoredVersion`.
The memory library's detail view shows the change list, and `PATCH
/api/memory/governed/:id` with `{ "undo": true }` performs the restore.

**Evidence.** The store's own recovery path (`stageMutation` / `memory_mutations`
/ `applyMutation`) already proves the design works one mutation at a time, but a
mutation row is deleted on commit: there is no record of what the memory said
before, so an edit made in the GUI or by `syncFromFiles` cannot be reverted once
it lands. The nearest analogue in Claude Code 2.1.319 is `rewind` removing a
memory write — the binary carries `rewind_removed_memory_write` as a wait
reason. Version snapshots are the narrower version of that idea: they cover memory
content only, not conversation state.

**What it costs.** One extra row per change, keeping at most 20 versions per
memory (older ones are trimmed). An owner who edits a memory 500 times holds 20
rows, not 500. The undo is per-change, not per-time-range: there is no "go back
to last Tuesday". The row is written in the same transaction as the entry, so a
failed change never leaves a version claiming a state that never existed.

**Reversal condition.** If memory files are edited by a script more often than a
person, per-change rows become noise; then snapshot on a time interval instead.
If an owner asks to compare two versions side by side, the table is already the
right shape — add a diff view rather than a second store.

## 2026-11-13 — Recall can synthesize a paragraph, but the paragraph is never a memory

**Decision.** `SynthesizedRecall` (`src/memory/synthesized-recall.ts`) takes the
top lexical matches and asks the configured endpoint for one paragraph that
answers the query from them, citing memory ids. The result is returned only
when every cited id was actually among the recalled set and every sentence
carries at least one citation (checked deterministically); otherwise the caller
falls back to the plain list. The synthesis is never written to memory, never
counted as a memory, and is journaled as `memory.recalled` with
`mode: "synthesize"` so the attribution loop sees exactly what the model was
fed.

**Evidence.** clone-ai's recall returns summaries, and the Main Agent's push
builder spends a 1,200-character budget across four memory classes. When many
small memories each match weakly, no single one survives the budget, yet their
union answers the question — the case Claude Code 2.1.319 handles with its
`memory_recall` attachment in `synthesize` mode ("a Sonnet-authored paragraph
distilled from many tiny memories", per the binary's protocol schema). clone-ai
had only the `select` half.

**What it costs.** One extra model call on the turn where synthesis is used, so
it is opt-in (`synthesize: true`) and only runs when at least three memories
match. A synthesis that cites a memory it was not given is discarded entirely
rather than partially trusted. The paragraph is fluent text, not a stored fact:
asking about the same thing twice may produce two different paragraphs. Because
the model wrote it, the paragraph is framed as background, never instructions,
and secret memories never enter the prompt that produces it.

**Reversal condition.** If synthesis turns out to change the model's answers in
ways the underlying memories do not support — measured by comparing answers with
and without it on the LongMemEval slice — delete it and keep the list. If it
proves useful, the next step is synthesizing on a timer and caching, not
synthesizing more often.

## 2026-11-13 — Background consolidation proposes merges; the owner still decides

**Decision.** `MemoryConsolidator` (`src/memory/consolidation.ts`) runs on the
same idle sweep as expiry and archives, and produces `merge` suggestions for
same-type active memories whose overlap coefficient is at or above 0.55.
Suggestions are journaled as `improvement.suggested` with `kind: "merge"` and
carry the merged summary plus the ids it would replace; approving one goes
through `ImprovementService.approve`, which authors the merged memory and
archives the sources as `retired`. The consolidator never writes memory itself.

**Evidence.** `src/memory/conflict.ts` already measures the right similarity
(`summarySimilarity`, thresholds 0.55 / 0.35, measured on rewording pairs
0.57–0.93 against unrelated pairs 0.0–0.4), but until now `findConflicts` had no
production caller — its only consumers were tests. Claude Code 2.1.319 runs
background memory consolidation (the `autoDreamEnabled` setting and a "Memory
consolidation" pass that reports `consolidated N memory files`). clone-ai's
governance forbids the model from writing memory, so the honest equivalent is a
suggestion, not an automatic merge.

**What it costs.** An idle sweep now does one O(n²) similarity pass over the
active library; at 200 memories that is 20k comparisons of cheap bigram sets,
which is why it runs on the idle sweep and not per turn. A merge is lossy by
construction: the merged summary is written by a model and may drop a qualifier
the two originals carried, which is why approval is required and the sources
are archived (recoverable) rather than deleted. A false "these are the same"
costs an owner click to dismiss; a false merge that was approved costs an undo.

**Reversal condition.** If approved merges are later undone more than they are
kept, the similarity signal is not good enough — require the model to quote both
summaries and explain what differs before suggesting. If the library stays small
the pass is free; if it grows past a few thousand active memories, bucket by
type and a shared rare term before comparing.


**Decision.** `read_file` returns a named window (default 400 lines) with the
file's total line count and the offset for the next page. `write_file` refuses
content that would discard most of an existing file, in every mode, not only in
the repair lane.

**Evidence.** In the 2026-11-11 repair run at `reasoning_effort=max`, the model
read `src/main-agent/native-runtime.ts` (771 lines), the shared loop capped the
tool result at 8,000 characters, and the model then wrote the prefix back as the
whole file: 391 lines deleted and replaced by placeholders such as
`// __HEADER_IMPORTS__`. The same run deleted the file's header comment and
imports. `read_file` had no offset, no limit and no total, so the truncation was
invisible from the model's side.

**What it costs.** A model that wants the whole file now needs one call per 400
lines; a large file costs several rounds instead of one. A legitimate large
rewrite has to go through `edit_file` or raise the size difference explicitly.

**Reversal condition.** If windowed reads make legitimate multi-file tasks
exceed their round budget, raise the default window rather than removing the
total. If fragment refusal blocks a legitimate regeneration, give the worker a
new-file mode instead of loosening the check.

## 2026-11-12 — Tokens are counted by the tokenizer, calibrated from usage

**Decision.** Replace the hand-written character-class ratio with a calibrator
that learns the provider's real characters-per-token from `usage.prompt_tokens`,
starting from the lowest measured bootstrap ratio (3.15) and smoothing each new
sample. Every estimate reports whether it is `bootstrap` or `calibrated` and how
many samples it has seen.

**Evidence.** Measured against this machine's gateway, the same Chinese sentence
costs 265 tokens on `kimi-k3.1-pro` and 346 on `gpt-6.1-terra` — 30% apart — and
a code sample costs 2.0–2.6 characters per token where Latin prose costs
3.2–4.4. The character-class estimate I wrote before this used one fixed
coefficient for CJK and four for Latin, so it was wrong for code by roughly 2×
and wrong for one of the two models by 30%. The provider already reports the
true number on every response, so guessing was never necessary.

**What it costs.** The first request of a process is still an estimate; it
converges after one response. Different providers on one clone home share the
calibrator, so a turn that switches models carries a ratio learned elsewhere
until the next report corrects it. A provider that reports a ratio outside 1–12
characters per token is ignored, which also ignores a request whose prompt was
mostly cached.

**Reversal condition.** If a provider exposes a token-count endpoint, call it
before sending instead of calibrating. If per-model calibration matters (a clone
home that rotates models every turn), key the calibrator by model id — the
current single instance is the simplification, not the requirement.

## 2026-11-12 — The token count is honest, and MCP is a real client

**Decision.** The loop estimates tokens by character class (CJK and full-width
punctuation one token each, Latin four characters per token), a fixed 1,568
tokens per image, and the tool schemas as part of every request. The native
runtime stops pre-truncating history once compaction is on. A compaction that
removes nothing ends the turn with `budget_exhausted` instead of being
journalled again. The HTTP MCP transport performs the `initialize` /
`notifications/initialized` handshake, reads a streamed SSE body event by event
until the response id arrives, and `mcpToolSpecs` can defer the declared table
behind one loader.

**Evidence.** Dividing raw length by four under-counted Chinese about four times
and charged one screenshot half a million tokens; the tool table was invisible
to the estimate. `buildHistory` capped each record at 4,000 characters and the
whole history at 12,000, so the transcript the loop measured never crossed the
token threshold — compaction had never run in production, which the 2026-11-11
repair confirmed by making the record reachable. The HTTP client skipped the
handshake (every conforming server rejects `tools/list` first) and returned the
first SSE event, which is usually progress rather than the result. Every
declared MCP tool was sent on every request.

**What it costs.** The estimate is still an approximation — a mixed-script
message can be off by a quarter — and it is deliberately conservative, so
compaction may fire slightly early. MCP over HTTP is now stateful per server, so
a server that restarts needs its session re-established (the client re-initialises
on the next call). Deferring tools needs a caller that activates the loaded
schema; until a caller passes `deferUntil`, the table is exposed directly.

**Reversal condition.** If a provider exposes a real tokenizer, replace the
estimate with it and keep this as the fallback. If deferral makes a model call
the loader on every turn instead of the tool, remove the option rather than
lengthening the prompt.

## 2026-11-11 — A decision is applied to the file it can see, and an approval names its step

**Decision.** The standing-policy store reads the file inside its write queue and
applies each change to that fresh value (read-modify-write, last writer wins on
real content). Approving a run through HTTP or WhatsApp carries the step the
approval was issued for, and a run waiting on a different step is refused with
409. The loop retries `TimeoutError` but not `AbortError`, refuses malformed tool
arguments instead of running the tool with `{}`, and treats `finish_reason:
length` as a failed turn. MCP servers receive only the environment they
declared, duplicate server and tool names are refused, framed output keeps its
formatting, and a server's process group is killed. Memory context caps each
item and the push carries the metadata the builder classifies by.

**Evidence.** Each was reproduced against this repository's modules: two store
instances resurrected a revoked policy because each computed `next` from its own
copy before enqueuing; the approve route ignored the body, so a code issued for
step A approved whatever was active; `AbortSignal.timeout()` rejects with
`TimeoutError`, which the retry predicate did not recognise, so every timeout
failed on the first attempt; `parseArguments` returned `{}` for truncated JSON,
running the tool with no arguments; no caller read `finish_reason`, so a reply
cut mid-sentence was reported as complete; `env: { ...process.env }` handed an
MCP server the owner's API keys; `sanitizeObserved` collapsed every whitespace
run, making source code and JSON unreadable; `close()` killed only the direct
child; one long memory consumed the whole context budget and the push dropped
`type`/`createdAt`, so every memory landed in one class.

**What it costs.** Every policy edit now re-reads the file, so a large
`policies.json` is parsed per edit. Approvals need the step id in the body, which
is a wire-format change. A model that emits truncated tool arguments gets a tool
error instead of a silent empty call. A chatty MCP server no longer logs at the
owner's expense — its output is bounded and framed.

**Reversal condition.** If re-reading the policy file on every edit becomes
expensive, cache by mtime rather than trusting in-memory state. If a legitimate
workflow needs an approval to apply to a later step, add an explicit
"approve the next step" mode rather than removing the check.

## 2026-11-11 — The worker streams its activity, and the repair lane says when to stop

**Decision.** The native worker no longer awaits the shared loop and reports only
its outcome: the loop runs inside the adapter's generator and every `model_call`,
`tool_started` and `tool_completed` is pushed to the Kernel as it happens. The
repair plan now names the files the trace already names, forbids reading
`docs/`, and tells each phase to stop after its first write.

**Evidence.** Three repair runs on 2026-11-11 against DeepSeek V4.1 Flash at
`reasoning_effort=max`, captured through a logging proxy. A 24-round run and a
32-round run both ended at `budget-model-calls` having only written a regression
case; 12 of 31 rounds were spent re-reading the file the trace already named, and
`docs/` was read after the case existed. The Kernel's audit for each run showed
`execution.progress` once and nothing else, so `maxToolCalls` and `maxModelCalls`
could never fire for the only executor, and no tool activity could be reviewed.

**What it costs.** The worker keeps a small queue and a promise hand-off per
step, and the Kernel writes two journal events per tool call it did not write
before. A step that makes hundreds of tool calls now produces hundreds of audit
records.

**Reversal condition.** If the added journal volume dominates writes on a large
step, record only failures and count the rest in the usage block. If a model
overruns despite the stop instruction, replace the instruction with a hard rule
in the loop (stop after the first successful write in a test-writing phase)
rather than lengthening the prompt.

## 2026-11-10 — Scope checks compare resolved paths, and the repair lane's guards are real

**Decision.** The per-call path gate resolves both sides with `realpath` (following
symlinks, resolving a missing suffix against its nearest existing ancestor),
folds case on case-insensitive volumes, and checks read and write roots
separately: write implies read, never the reverse. A grant on a directory that
contains a protected root is refused, and a worker may not write inside a
repository's `.git`. The repair lane's `refuse-existing` mode is threaded into
`workerTools`, its worktree copies `node_modules` instead of symlinking it, and
a round limit is reported as a budget failure whether it came from the plan or
from the worker's default. Body caps clear the attachment cap, and the
capacity gate transfers a released slot to the waiter in the same synchronous
step that frees it.

**Evidence.** A six-dimension audit against Claude Code 2.1.319, with every
high finding verified adversarially and several reproduced against this
repository's own modules: a symlink inside the workspace pointing outside
returned `allowed: true` for reads and writes (Claude Code refuses that shape
outright: `Path contains '..' traversal after a directory segment, which may
follow a symlink outside the working directory`); a `files: read` grant
authorized a write; a grant on `~/Library` was accepted and handed over
`Library/Keychains`; `isRuntimeScratch` hid a write made through the worktree's
`node_modules` symlink; the `refuse-existing` guard never reached `fileTools`
because `workerTools` ignored it; `max_turns` fell through to `completed` when
the step had no work order; `Skill(name)` and `server.tool` are not legal
provider function names; compaction could keep a tool result without its call;
a 300 KB image produced HTTP 500 on the old 32 KB body cap; and a synchronous
acquire after `release()` put `limit + 1` executions in flight.

**What it costs.** Every path check now performs filesystem work (`realpath`),
so a step with many file tools pays a few syscalls per call; the capacity gate
counts a slot for a waiter before it resumes, so `active` includes queued
holders; a `node_modules` copy makes a repair worktree slower to prepare.

**Reversal condition.** If path resolution becomes a measurable cost on large
trees, cache resolved roots per step rather than reverting to lexical compare.
If copying `node_modules` makes a repair worktree too slow or too large, replace
the symlink with a read-only bind mount, not with a writable link into the
served checkout. Revert the `.git` refusal only if a legitimate workflow needs
a worker to write repository metadata.

## 2026-11-09 — The model can dispatch a task, but only the Kernel plans and finishes it

**Decision.** Add one model-invocable `dispatch_task` tool that turns an
objective and acceptance criteria into the same `runQuery` path the companion
uses. It is not a second execution surface: the Kernel still plans, applies
authority and budgets, verifies evidence and decides completion. A conversation
must still be answered directly, and a plan whose steps are already known still
goes through `propose_work_plan`.

**Evidence.** The audit found the Main Agent could propose plans but could not
start work on its own (`docs/study/claude-code-parity.md`, gap #6). `runQuery`
already owns trigger → recall → plan → execute → verify, so reusing it keeps one
completion path. The alternative — letting the Main Agent spawn workers
directly — would create a second authority and a second place where a task can
be declared finished.

**What it costs.** The first dispatch is synchronous from the model's point of
view, so a long task holds the turn; background dispatch and a completion
notification are the next step, not this one. The tool also accepts only an
objective and criteria, so the model cannot express per-step scopes; it must use
`propose_work_plan` when it needs that precision.

**Reversal condition.** If real tasks routinely need per-step authority or
background completion, extend `dispatch_task` with a background option and
return a run id immediately; if the synchronous call proves to be the source of
timeouts, make background the default.

## 2026-11-09 — Regression cases run in the default suite

**Decision.** `npm test` now runs `test/*.test.ts` **and** `test/regression/*.test.ts`.

**Evidence.** The two desktop fixes merged on 2026-11-06 shipped with cases the
lane ran, but neither `npm test` nor `npm run gate` nor CI ever ran them again:
the glob was `test/*.test.ts`, which does not match the subdirectory. A future
change could reintroduce either defect and every automatic check would stay
green.

**What was given up.** `npm test` is slightly slower (two more files) and a
regression case that is intentionally red cannot be merged without failing the
default suite. That is the point.

**Reversal condition.** If the regression directory grows large enough to slow
the default loop, move it to a second script that CI runs alongside `npm test`,
never out of CI.

## 2026-11-09 — A background repaint yields to a focused editor

**Decision.** `render()` in the memory panel takes `{ background: true }`, used
only by the poll wrapper; when the focused element is an `INPUT` or `TEXTAREA`
inside `#memory-root`, a background repaint is skipped.

**Evidence.** The 2026-11-06 fix compared the whole markup and skipped only when
nothing changed. A probe against the same sandbox showed that any real change
(another memory's `updatedAt`, or an `accessCount` bumped by a recall) rebuilt
the DOM and detached the unsaved editor. Since every recall changes counts, the
original bug would still fire in normal use, just less often.

**What was given up.** While the owner types, the panel's own content does not
update (a detail that finished loading appears after focus leaves). That matches
`renderLibrary`'s guard in `app.js` and is preferable to losing an edit.

**Reversal condition.** If stale content while typing becomes a complaint, the
fix is to preserve the focused node across repaint (patch in place), not to
remove the guard.

## 2026-11-09 — write_file's overwrite mode is per worker, and only the repair lane refuses

**Decision.** `fileTools({ writeFileMode })` defaults to `overwrite`;
`createConfiguredNativeWorker` reads `CLONE_AI_NATIVE_WRITE_FILE`, and the repair
lane sets it to `refuse-existing` for its own process.

**Evidence.** The 2026-11-06 change made `write_file` refuse existing paths in
`fileTools()` unconditionally. That protected the repair lane, which only ever
needs excerpt edits, but it also removed the ability to regenerate an existing
file from every ordinary task — and there is no delete tool, so the task had no
way to recover.

**What was given up.** Two modes to reason about, and an environment variable in
the repair process. A repair can no longer legitimately replace a file wholesale;
that is the intended restriction.

**Reversal condition.** If repairs frequently need a full-file replacement, add
an explicit `replace_file` tool gated to the repair lane with its own size check,
rather than loosening `write_file` for everyone.

## 2026-11-06 — Adopt Claude Code's harness mechanics, not its source or prompts

**Decision.** Use the reverse-engineered Claude Code 2.1.317 mechanisms as a
reference specification for clone-ai's own agent loop: typed terminal reasons,
streaming tool scheduling with per-tool concurrency flags, a per-call
permission pipeline, token-aware compaction, hooks, MCP, and skills. Do not copy
source code, prompt text, or Anthropic-internal configuration into this
repository.

**Evidence.** The extracted Bun module graph contains 2,942 modules and a
copyright notice (`cli`: "(c) Anthropic PBC. All rights reserved."). The
mechanisms are visible as string constants and control flow
(`BUILTIN_TOOL_NAMES`, the six-mode permission enum, 33 hook event names, the
`effectiveWindow - 13000` compaction math). clone-ai's README states that it
does not embed another runtime and that Claude Code is a black-box worker.
Copying the prompt would also replace the personal-twin charter with a
coding-CLI identity.

**What it costs.** Reimplementation is slower than embedding
`@anthropic-ai/claude-agent-sdk`; parity must be proved by clone-ai's own evals
rather than inherited from Anthropic.

**Reversal condition.** If the owner explicitly chooses time-to-parity over
independence and accepts an Anthropic-only credential and provider path, add the
Agent SDK as a temporary reference/benchmark path, not as the product
architecture.

## 2026-11-06 — Execution workers are general; coding is one tool profile

**Decision.** Keep the Main Agent's proposal/authority boundary and add a
model-invocable `Task`/subagent path plus read-only inspection tools. Treat
workers as general execution surfaces: their tool set is selected by role and
capability profile, not hardwired to coding. A coding profile (Read, Write,
Edit, Glob, Grep, Bash) is one profile; research, review, drafting, and external
connectors get their own. Do not give the Main Agent Bash/Edit/Write directly.

**Evidence.** `src/workers/native-agent-worker.ts` already takes an arbitrary
`NativeToolSpec[]` and a `workCapabilities` list; `fileTools()` is only the
current default profile, not a type-level constraint. `decideTool` gates every
call by risk, path, and network scope, so a larger or different profile does not
widen authority. The README's invariant is "the Main Agent is the brain, never
the authority." Claude Code's coordinator prompt also separates a coordinator
from workers (`chunk-mas5an83.js`), which matches clone-ai's split.

**What it costs.** Profiles need ownership, versioning, and tests; a role that
gets the wrong profile can be over- or under-powered. The Main Agent cannot
inspect files itself without a new read-only tool set.

**Reversal condition.** If a single universal tool set proves simpler and every
role needs the same tools, collapse the profiles — but keep the per-call gate
and the capability declaration. If a same-model benchmark shows the orchestrator
round-trip loses more than 20% task success or doubles median latency, allow the
Main Agent to execute read-only tools directly under the same gate.

## 2026-11-06 — One shared agent loop kernel serves the Main Agent and the native worker

**Decision.** Extract one `src/agent/loop.ts` state machine with typed terminal
reasons, tool scheduling, budget checks, abort propagation, retry policy, and
compaction hooks. `runNativeMainAgentTurn` and `OpenAiCompatibleClient` become
adapters over it.

**Evidence.** Both current loops duplicate SSE/non-streaming request handling,
usage accounting, and an 8,000-character tool-result cut
(`native-runtime.ts:270-315`, `openai-compatible-client.ts:74-96`); both lack the
same features. The native-runtime header says "no compaction" while the file
compacts at `:515-558`, which is the kind of drift duplication produces. Claude
Code has one query loop for its terminal, SDK, and desktop surfaces
(`chunk-8ntpzya9.js`).

**What it costs.** A refactor of two hot paths and a period where behavior must
be pinned by tests; the loop must not grow provider-specific branches.

**Reversal condition.** If the Main Agent and worker diverge in transport or
streaming requirements (for example, a provider that cannot stream tool calls),
keep separate model adapters but share the scheduler, budget, and tool-result
layers.

## 2026-11-06 — Every in-process tool call goes through a per-call decision

**Decision.** Route every in-process tool call through `ToolAuthority` (or a
successor policy broker) that returns
`{behavior: allow | deny | ask, reason, updatedInput?}`. Plan-time policy
remains the outer gate; hooks may add context or deny, but may not silently
widen authority.

**Evidence.** `src/core/tool-authority.ts` exists and is referenced only by
`test/tool-authority.test.ts`; `runNativeMainAgentTurn` executes any tool the
model names (`native-runtime.ts:292-308`). Claude Code decides each call through
rules, mode, and `canUseTool`, and a denied call is returned to the model while
the turn continues (`chunk-q8qwkppc.js`). The audit ranks this as gap #2.

**What it costs.** More events and latency per call; the desktop and CLI need an
`ask` path, and every tool needs a risk classification.

**Reversal condition.** If per-call gating adds more than 10% latency on
read-only batches and no real incident is prevented in a red-team exercise,
allow read-only batches under one plan-time grant while keeping the gate for
writes, shell, network, and external actions.

## 2026-11-06 — Compaction is token-aware and recorded; deterministic summaries first

**Decision.** Estimate tokens against a configured context window, compact at
the Claude Code-derived threshold (`effective = window - min(maxOutputTokens,
20000)`, threshold `min(floor(effective * (1 - 0.2)), effective - 13000)`,
warning at `threshold - 20000`, blocked at `effective - 3000`), write a
`compaction` record with preserved message ids, and default to a deterministic
summary. Add a model-written summary only after an eval shows it preserves
task-critical facts better.

**Evidence.** The native loop compacts history by characters
(`historyChars ?? 12000`, newest 66% verbatim) and never writes a `compaction`
record (`native-runtime.ts:238-241,515-558`); the desktop context panel reads
legacy Pi JSONL (`conversation-history.ts:241`). Claude Code records a
`compact_boundary` with `preservedMessages.uuids`, a nine-section summary, and a
restored tail. Deterministic summaries are private, cheap, and testable; model
summaries add cost and nondeterminism.

**What it costs.** Token estimation is approximate; deterministic summaries can
lose nuance; a compaction record adds a new persisted event type.

**Reversal condition.** If the long-context benchmark shows deterministic
summaries lose a fact that a model summary preserves in at least 20% of seeded
cases, make model summaries the default for sessions above the threshold.

## 2026-11-06 — MCP and skills first; plugins, cloud, VM, and computer-use deferred

**Decision.** Implement an in-process MCP host (stdio first, then HTTP/SSE) and a
`SKILL.md` loader with progressive disclosure as P1. Defer plugin marketplaces,
cloud sessions, VM sandboxes, Chrome integration, and computer-use until the
weighted harness score is at least 90 and a concrete workflow requires them.

**Evidence.** clone-ai has no MCP or skills code (audit: extensibility 10/100).
MCP and skills are Claude Code's extension on-ramps; every third-party
integration arrives through them. Plugins and cloud/VM are product surfaces with
infrastructure cost. The macOS Seatbelt profile in `authority/seatbelt.ts` was
written for the black-box CLI workers, which no longer exist, so it is currently
unused; the in-process native worker has no OS sandbox. Claude Desktop's VM is a
26 MB image plus platform-specific hypervisor code. Deferring the VM is
therefore a deliberate bet that per-call path gating plus a single trusted worker
is enough for now — not a claim that an OS sandbox is already in place. Deferring them avoids spending the parity
budget on infrastructure that does not move the harness score.

**What it costs.** Users cannot install third-party plugins or run remote/browser
tools until those phases; MCP adds an attack surface, and skills can inject
instructions.

**Reversal condition.** If the owner's real workflows depend on a specific
plugin/marketplace or remote MCP, promote that integration; if a red-team test
shows that per-call path gating is insufficient for a workflow, promote the VM sandbox.

## 2026-11-06 — The 95% target is a weighted harness-parity score

**Decision.** Define parity as the 12-dimension weighted score ≥ 95, every
dimension ≥ 80, and a same-model live benchmark that does not regress against a
Claude Code reference run. Model quality is measured and reported separately; it
is never blended into the harness score.

**Evidence.** clone-ai supports arbitrary OpenAI-compatible endpoints; the model
behind it may be weaker or stronger than Claude Code's default. Conflating model
quality with harness quality makes the score incomparable and lets a weak model
be blamed on the loop. The extracted harness mechanisms are the controllable
variable.

**What it costs.** The score needs a maintained eval suite and a live reference
run; weights can be gamed, so the rubric requires executable evidence per level
and a minimum per dimension.

**Reversal condition.** If a same-model head-to-head shows clone-ai passes at
least 95% of tasks while scoring below 85 on the checklist, reweight toward task
success; the checklist is then measuring things users do not value.

## 2026-11-06 — Worker concurrency follows measured machine capacity, capped by the Kernel

**Decision.** The Kernel samples CPU parallelism, load average and free memory,
computes a concurrent-worker limit, and gates every worker execution through a
shared limiter. The Main Agent can read the same snapshot through a read-only
`get_capacity` tool so it can size a plan, but it cannot raise the limit. An
owner may pin a ceiling with `maxConcurrentWorkers`; `0` or unset means auto.

**Why.** The owner asked for dispatch concurrency to follow memory and CPU so the
machine is used fully. Letting the model choose the number directly would make
concurrency depend on a sampled token rather than on the machine: it could
oversubscribe a laptop into swap or serialize a large workstation by mistake.
Measured capacity is deterministic, testable, and the same answer for every
caller; the model's role stays what it already is — deciding how much work to
propose.

**Evidence.** Before this change, `executeSubagents` ran every ready work order
with `Promise.all` and the queue started every queued Run in a tick, so the
degree of parallelism came from the plan shape alone. A 16-core host and a
2-core host behaved the same.

**What it costs.** A limiter adds queueing: a run can sit waiting for a slot
instead of starting immediately. Read-only subagents in one workspace still
share the workspace lock for writes, so same-workspace write steps stay serial
even when capacity is available.

**Reversal condition.** If runtime measurement proves wrong on the owner's
hardware (cgroups, container limits, or a noisy neighbour), let the owner pin
`maxConcurrentWorkers` and treat auto as advisory; or replace the formula with
an observed-throughput feedback loop. Never let the model set the hard cap.

## 2026-11-06 — The harness keeps only its own agents: no Pi SDK, no black-box CLIs

**Decision.** Remove the Pi Agent SDK and every black-box CLI worker (Claude
Code, Codex, the Pi CLI, opencode) from the code path. The Main Agent runs only
on the in-process native loop; every executing role runs only on the native
worker. The external role has no provider until a governed action connector
exists, instead of falling back to a CLI.

**Why — the owner's reasoning.** A sub-agent behind a CLI is not controllable:
its tool calls are invisible to the Kernel, its credentials live in that
process, and its safety rules are prompt text rather than gates. The Main Agent
is special: it must only dispatch tasks and assemble context, never execute, so
its loop, context assembly and tool surface must be ours and auditable rather
than delegated to an SDK. Keeping the CLI path as a fallback would preserve
exactly the behavior this change exists to remove.

**Alternatives rejected.** (1) Keep Pi as a fallback: the fallback becomes the
de facto path whenever the native endpoint is down, and the uncontrolled
behavior returns. (2) Keep CLIs only for external actions: external effects
would run with no receipt and no per-call gate, the highest-risk path. (3) Wrap
the CLIs in a policy proxy: still no per-call tool visibility.

**Evidence.** The native worker passes the full 5/5 reliability set with exact
usage; the native Main Agent matched Pi 15/15 across five samples and used fewer
tokens; both native paths stream, compact and record turn/tool/usage events. The
black-box path's audit stops at the process boundary.

**What it costs.** The Main Agent requires an OpenAI-compatible endpoint
(`CLONE_AI_NATIVE_*`); without it, turns fail clearly instead of degrading to
Pi. External actions are unavailable until a governed connector exists. CLI-only
capabilities (a coding agent's own tools, network access) are gone. Existing Pi
sessions and CLI worker settings are no longer usable; the turn ledger becomes
the conversation record.

**Reversal condition.** Add a replacement adapter only when it provides per-call
tool visibility, Kernel-gated execution and trusted receipts; a raw CLI, or an
SDK that owns the loop, is not a valid reversal. If the native endpoint cannot
be made reliable, the product is blocked rather than silently degraded.

## 2026-11-06 — The Main Agent comparison repeats each cell and reports medians

**Decision.** `npm run bench:main` runs each task/runtime cell N times (default
5), reports median and p90 duration, median tokens and pass rate, and writes
every individual run plus the aggregates to the result JSON. `--repeat 1`
restores the old single-sample shape.

**Evidence.** Two single-run passes on 2026-11-05 disagreed on which runtime was
faster: the native plan cell was 45.2s in one pass and 11.1s in the other, and
Pi's plan tokens were 8,977 vs 13,174. A one-sample cell cannot rank latency;
the median over repeats is the cheapest way to make the comparison meaningful,
and keeping every sample exposes the spread.

**What it costs.** N times the model calls and wall time (five repeats is about
five times the cost of one pass). The median can still mislead if the endpoint
is under load, so the report keeps every sample and a p90 alongside it.

**Reversal condition.** If recorded cassettes can replay the same prompts
deterministically, use them for latency and keep this only as a real-endpoint
sanity check.

## 2026-11-06 — The repair plan tells the worker how its step is judged

**Decision.** The phase-1 instructions now say the reproduction file must be
written before broad exploration, that the worker should read only the files
the case needs, and that every file left under `test/regression/` must be a
failing reproduction — diagnostic or probe files are not accepted. The
acceptance criterion states the same rule, so a passing probe cannot satisfy it.
Phase 2 is told the same: read the failing case and the production file it
exercises, make its first production write within four tool calls, leave no
scratch files, do not explore READMEs or repository directories, and do not
write a trade-off entry (the working agent did that before the run). Both phases are told they have no shell tool, because telling a
worker to "run npm test" it cannot run invites exploration instead of the edit.
The native worker's system prompt now states that a step requiring a file is not
complete until a write tool has succeeded, and that a summary claiming work that
never reached the workspace is a failure; phase 1 must make its first write
within three tool calls.

**Alternatives rejected.** (a) Raise the round budget again — the 24-round run
showed the model using the extra rounds to read more files, not to write;
another increase would buy more exploration, not a patch. (b) Leave only the
acceptance criterion — the model reads instructions, not the criteria list, in
practice. (c) Reject probe files in the lane after the fact — the lane cannot
tell a probe from a poor reproduction without running it, and the model can
still spend the whole budget before the lane sees anything.

**Evidence.** Two runs of the same trace with Magpie `360/deepseek/deepseek-v4.1-flash`:
`1dddd6b4` spent 12 rounds reading and wrote nothing; `426f3d3a` spent all 24
rounds reading (423,163 input tokens) and then wrote `probe-tmp.test.ts`, a file
that printed the tail of `memory.js` and passed. Both stopped at gates
(`regression-missing`, `not-red`). A third run (`f7e07553`) read 20 files, spent
28 rounds and 74,641 output tokens, and ended `completed` without a single
artifact, so the system prompt now refuses a summary that claims work no write
performed. The eval is the next lane run: the same trace should produce a
failing reproduction. Whether the wording is sufficient is measured there, not
assumed.

**Cost and reversal condition.** No runtime cost; the instructions are longer by
two lines. Reverse if workers start writing shallow tests that pass and the
"write early" pressure is the cause — in that case restore exploration guidance
and make the acceptance check stronger instead.

## 2026-11-06 — The native worker takes an explicit round budget

**Decision.** `CLONE_AI_NATIVE_MAX_ROUNDS` sets how many model round trips one
native step may spend before the client returns its "round limit" summary; an
unset or malformed value keeps the built-in default of 12. `CLONE_AI_NATIVE_MAX_TOKENS`
does the same for one completion's token count. The repair lane sets the round
budget to 32 through the worker environment, so a repair can read the failing
code and still write the case and the patch in the same step. The token cap was
first set to 16,000 after a single call held a step for over ten minutes; that
proved too low for the native worker's full-file `write_file`, because
`audit.js` (44 KB) and `app.js` (118 KB) cannot be rewritten inside it, so the
lane now uses 50,000.

**Alternatives rejected.** (a) Raise the hard-coded default to 24 for every
native call — a normal chat turn would then be allowed twice the tool calls,
widening the blast radius of a looping model for no measured benefit.
(b) Let the lane retry the step after a limit — the Kernel already ends a step
at its budget, and a retry would double the model spend without teaching the
worker anything. (c) Put "be brief" in the plan — an instruction cannot make a
12-round budget sufficient when the model legitimately needs to read five files.

**Evidence.** Repair run `1dddd6b4-a6dd-42b4-bc18-65b795b62148` (2026-11-06):
phase 1 spent all 12 rounds on `list_directory`/`read_file`
(89,845 input / 2,366 output tokens, 33 s) and wrote no file, so the lane
stopped at `regression-missing`. A later run on the same trace held a single
provider call open for more than ten minutes while a two-token request to the
same gateway answered in 1.9 s, which is why one completion now has a ceiling as
well. The evals are `test/native-client.test.ts` (the client stops at the
configured round count; the configured token cap reaches the request body;
malformed values are ignored) and the lane runs that follow each entry.

**Cost and reversal condition.** Each extra round is one provider call; the
budget is per step, not per run, so a repair's worst case doubles. Reverse
this if native steps routinely finish within 12 rounds (the knob then hides a
prompt problem), or if a 24-round step is observed looping without producing a
file — in that case the plan, not the budget, is the thing to fix.

## 2026-11-06 — Archiving a memory uses the cache the memory module actually owns

**Decision.** The memory library's archive/restore handler stops writing
`state.signatures.library` on a state object that has no `signatures` field; the
success path runs `refresh()` and the success message instead. The global
signature cache in `app.js` is invalidated by the refreshed data itself, not by
an assignment the module cannot make.

**Alternatives rejected.** (a) Add a `signatures` object to the module's own
state — it would silence the exception but leave a second cache that
`renderLibrary` never reads. (b) Delete the handler's success path — the list
would keep showing the old status. (c) Rely on the next 3-second poll — the
owner would see a raw JS error and a stale row for at least one cycle.

**Evidence.** `memory.js` declares its own `state` without `signatures`; the
`[data-mem-status]` handler assigns `state.signatures.library` after a
successful PATCH, so the TypeError is caught by the handler's catch, which
announces the raw message and skips `refresh()`. A vm run of the real module
with a stubbed `api` reproduces it: refresh count 0, announcement
`Cannot set properties of undefined (setting 'library')`.

**Cost and reversal condition.** The archive/restore path refreshes immediately
instead of waiting for the poll; no extra request beyond the existing refresh.
Reverse if the module grows its own signature cache for a reason (then assign
to the field that exists and document why two caches are needed).

## 2026-11-06 — The repair lane re-runs the hashed regression cases after the fix

**Decision.** After the fix phase and the hash comparison, `clone-ai repair` runs
the same hashed cases once more and requires them to pass. A failing run stops
the lane with the new `regression-still-red` gate; the result is recorded as
`regressionAfter` in the report. The full suite and the typecheck still run
afterwards.

**Alternatives rejected.** (a) Trust the full suite — in this repository
`npm test` is `node --test test/*.test.ts` and does not include
`test/regression/`, so the false-fixed run passed without touching production
code. (b) Trust the hash comparison — it proves the case was not edited, not
that it passes. (c) Rely on the case being in the suite — that is a
repository-specific accident, not a lane invariant.

**Evidence.** Run `d8c54037` / fix run `4accee4b` (2026-11-06): phase 2 wrote no
artifact, the staged diff held only `.probe/*`, `node_modules` and the
regression case, and the lane reported fixed; running the case afterwards still
failed. The lane's own `npm test` output in that report was green because the
new case is outside its glob. `test/repair.test.ts` now has a no-op-fix case
that expects `regression-still-red`, and a unit case for the green check.

**Cost and reversal condition.** One extra invocation of the new cases (a
fraction of a second in this repository) and a clearer failure. Reverse if the
cases become part of the suite **and** the suite can report them separately, or
if a regression case is too slow to run twice — then run the case once after the
fix and drop the duplicate suite run, not the check.

## 2026-11-06 — Repair staging removes known runtime scratch, not arbitrary files

**Decision.** `stageRepair` stages everything, then unstages a fixed list of
runtime scratch: `node_modules` (including the symlink), `.probe/`, `.rsi/`,
`.clone/`, `.work-orders/`, `.verification-baseline*`, `*.log`, `*.tmp`. The
protected-path gate then sees every other change, including new files.

**Alternatives rejected.** (a) `git add -A` alone — it staged the `node_modules`
symlink and `.probe/` in run `d8c54037`. (b) Stage only tracked files plus new
`test/regression/` files — the first implementation of this fix; it silently
dropped a new protected file, and the existing protected-path regression test
caught it. (c) Extend the repository's `.gitignore` — a lane that depends on the
target repository's ignore file fails on another repository, and a `node_modules/`
entry still does not match a symlink.

**Evidence.** `d8c54037`'s commit carried `.probe/lines.txt`, `.probe/measure.txt`,
`.probe/one.txt`, `.probe/ten.txt`, `node_modules` and the case. The
protected-path test in `test/repair.test.ts` fails against the "regression files
only" variant and passes with the deny-list. A second case asserts that
`node_modules` and `.probe/junk.txt` never appear in the staged diff.

**Cost and reversal condition.** A stray scratch file under another name would
enter the diff; it is visible in `changed` and in the owner's review, which is
why the list is deliberately short. Reverse if scratch names proliferate: move
the list into a shared manifest or give the worker a scratch directory outside
the workspace, rather than widening this function.

## 2026-11-06 — The native worker gets a targeted edit tool

**Decision.** `fileTools()` adds `edit_file`: replace exactly one occurrence of
`old_text` with `new_text`, refusing empty, missing or ambiguous excerpts, and
refusing an edit that shrinks the file to less than a tenth of its size. Phase 2
is told to prefer it for an existing file. `write_file` now refuses a path that
already exists, so the only way to change an existing file is a named excerpt;
it still creates new files.

**Alternatives rejected.** (a) Keep whole-file `write_file` only — a repair of
one line in the 118 KB `apps/desktop/ui/app.js` replaced it with an 8 KB
fragment (observed 2026-11-06). (b) A unified-diff or patch parser — more input
to validate, and a malformed patch fails less legibly than one exact excerpt.
(c) Line-number replacement — line numbers drift as the worker reads; an exact
excerpt is self-checking. (d) Let `write_file` replace existing files and rely
on the size guard — the guard's 10% floor allowed a 127-line deletion from
`audit.js` (36 KB) in the 2026-11-06 rerun; the patch was refused by the red
check, but the file in the worktree had already lost functions the case never
loaded.

**Evidence.** In the plain-preview attempt, phase 2 wrote an 8 KB `app.js`
containing only the functions the case slices; `npm test` and `tsc` do not load
that browser script, so the lane was ready to call it fixed. In the audit rerun,
`write_file` replaced 127 lines of `audit.js`; the post-fix case still failed, so
the lane refused the patch, but the worktree file was already damaged. The size
guard and single-occurrence requirement would have refused the first; refusing
existing paths refuses both. `test/native-client.test.ts` covers replacement,
missing text, ambiguity, the shrink guard, and `write_file` refusing an existing
path.

**Cost and reversal condition.** One more tool entry and one read of the target
file per edit; a legitimate edit that removes more than 90% of a file is
refused (a full-file replacement must use `write_file`). Reverse if exact-excerpt
edits fail often on large files (add a diff-apply tool), or if the shrink guard
blocks a legitimate rewrite (raise the threshold, do not remove the check).

## 2026-11-06 — Sidebar previews keep identifier underscores

**Decision.** `plainPreview` treats underscores as emphasis only at word
boundaries, so `some_variable_name` survives in the sidebar and session header;
asterisk emphasis is unchanged.

**Alternatives rejected.** (a) Drop underscore emphasis entirely — `_text_` is
a normal way to write emphasis, and dropping it would stop rendering it.
(b) Render the previews as Markdown — the sidebar is one line; full Markdown
there costs a parser and re-introduces the wrapping the preview exists to avoid.

**Evidence.** `plainPreview` applies `/(\*|_)([^*_\n]+)\1/g` to the whole string
(`apps/desktop/ui/app.js`), so `check some_variable_name first` becomes
`check somevariablename first`. Agent replies about code routinely contain
identifiers.

**Cost and reversal condition.** One more boundary condition in an existing
regex; no new dependency. Reverse if the stricter rule leaves legitimate
emphasis unrendered in a way owners notice, or if previews move to rich text.

## 2026-11-06 — A hidden conversation keeps its restore control

**Decision.** `renderSessions` renders the "已隐藏" group (with its restore
button) even when the visible session list is empty, instead of returning early
to the empty state.

**Alternatives rejected.** (a) Keep the early return and rely on the audit view
— the audit view knows deleted run ids, not the conversation entry in
`deletedConversations`, so it cannot restore the conversation. (b) Show the
empty state and the hidden group side by side — the empty state's text says
there is nothing, which is false when a hidden conversation exists; the hidden
group replaces it.

**Evidence.** `renderSessions` returns after painting `empty-sessions` when
`sessions.length === 0`, while the hidden block is built afterwards
(`apps/desktop/ui/app.js`). Hiding the only conversation leaves no
`data-restore-conversation` in the sidebar. A vm run with an empty list and one
deleted conversation reproduces it.

**Cost and reversal condition.** One branch moved; no request. Reverse if the
product decision changes to offering hidden conversations only in the audit
view (then remove the sidebar control entirely rather than leaving it
unreachable).

## 2026-11-06 — The audit dispatch block reads the events that carry steps

**Decision.** The audit view's "Worker 派发" block renders `dispatch.steps_assigned`
payload assignments (stepId, agentId, reason) as one row per step, keeps the
task-level `dispatch.decided` row as the authorization summary, and shows
`dispatch.blocked` with its code and reason instead of the "no dispatch record"
message.

**Alternatives rejected.** (a) Keep reading only `dispatch.decided` and accept
"步骤 —" — a multi-worker plan then has no view that answers which worker ran
which step. (b) Read the raw trace payload only — the block exists to answer the
question without opening raw JSON.

**Evidence.** `JournalDispatchRecorder` writes a task-level decision with no
`stepId`, a separate `dispatch.steps_assigned` with `assignments`, and
`dispatch.blocked` with `code`/`reason` (`src/main-agent/dispatch-recorder.ts`).
The UI's `dispatchBlock` only filtered `dispatch.decided` and read
`payload.stepId` (`apps/desktop/ui/audit.js`). The regression cases run the real
audit view in a vm with those payloads and fail on the old code with "步骤 —"
and "这次运行没有派发记录".

**Cost and reversal condition.** The block now reads up to three event types
from the trace it already fetched; no new request. Reverse if the trace API
stops returning `dispatch.steps_assigned` (the block would then be empty for
multi-step plans) or if a future router records per-step assignments on
`dispatch.decided` itself.

## 2026-11-06 — The effort select reads the gateway list that exists

**Decision.** `renderMainAgentEffort()` resolves the gateway from
`state.gateways` (the array the client actually writes) and re-renders after
`refreshGateways()`, so the reasoning levels offered are the ones the Magpie
model declares.

**Alternatives rejected.** (a) Keep the generic level list — it offers levels
the gateway does not serve and hides the ones it does. (b) Add a second
`state.gateway` field written alongside `state.gateways` — two names for one
value drift, and the array is what every other view uses.

**Evidence.** `state.gateway?.models` was read in `renderMainAgentEffort`,
while the client state declares only `gateways: []` and every writer uses it
(`apps/desktop/ui/app.js`). A vm test with `state.gateways` set and
`reasoningLevels: ["low","high"]` shows the old select rendering
off/minimal/low/medium/high/xhigh/max.

**Cost and reversal condition.** One lookup instead of a field read; no new
request. Reverse if the gateway data moves to a single object (then use that
object) or if a model's declared levels are wrong more often than the generic
list is useful — the fallback list must stay for models the gateway does not
describe.

## 2026-11-06 — A repair may not delete more than forty production lines

**Decision.** After staging, the lane counts the deleted lines per path and
refuses a fix that removes more than 40 lines outside `test/regression/`
(`fix-too-large`). A small fix removes a few lines; a rewrite removes dozens.

**Alternatives rejected.** (a) Raise `edit_file`'s shrink floor — a 56% and a
90% rewrite both passed it; a floor high enough to catch them would also block
legitimate small rewrites. (b) Restrict the size of `old_text` — a 17% block
(audit's 127 lines) still passes, and a legitimate change can span a large
block. (c) Trust the case and the suite — the case only exercises the functions
the model kept, and the suite and typecheck do not load browser scripts.

**Evidence.** On the 2026-11-06 rerun, `memory.js` was replaced with 2 added and
127 deleted lines, and `audit.js` with 4 added and 315 deleted lines; the cases
for the remaining functions went green, and nothing else in the repository
loads those scripts. The merged memory and sidebar fixes delete 2 and 1 line.
`test/repair.test.ts` covers a 100-line rewrite refused as `fix-too-large` and
confirms test-case lines are excluded from the count.

**Cost and reversal condition.** A legitimate repair that removes more than 40
production lines is refused and must be applied by the owner or split into
smaller edits. Reverse if real repairs routinely exceed 40 deletions: raise the
threshold or let a trace declare a larger allowance, rather than dropping the
count.

## 2026-11-06 — The memory library keeps a focused editor across background refreshes

**Decision.** The memory library (`apps/desktop/ui/memory.js`) must not rebuild
`#memory-root` when the periodic 3-second dashboard refresh hands it a library
that has not changed, and must never discard a focused search field or an
unsaved editor while the owner is typing. The background poll may update data,
but it may not replace the DOM under the owner's caret.

**Alternatives rejected.** (a) Slow the poll for this panel — the refresh is
shared with the rest of the dashboard, and a slower poll only widens the window
in which a keystroke is lost. (b) Remove the search/edit controls — they are the
reason the layered view exists. (c) Keep the rebuild and restore focus after it —
a restored caret still loses the keystroke that arrived during the rebuild and
cannot recover unsaved textarea content.

**Evidence.** `refresh()` in `apps/desktop/ui/app.js` runs every 3000 ms and
calls `renderLibrary(library)`; the wrapper added at the end of `memory.js` calls
`render()` unconditionally, and `render()` assigns `root.innerHTML` on every call
(`memory.js:178`). The existing "do not redraw while typing" guard in
`app.js:renderLibrary` only covers `#library-list`, `#library-new-*` and
`.memory-tools`, not the newer `#memory-root`. Reproduction: open Settings →
Memory, type in `[data-mem-query]`; within three seconds the input is replaced
and loses focus. The same rebuild replaces an open editor's textarea with the
stored content. This is **observed by code inspection**; the regression case is
produced by the repair lane and run before the fix.

**Cost and reversal condition.** Skipping an unchanged render costs one JSON
comparison per poll (the same signature check `app.js:renderLibrary` already
uses). If the panel later needs a live view that changes without a library
change (a clock, a running job), that view must update through its own explicit
render rather than by rebuilding the whole root — reverse this entry if the
signature check starts hiding real updates.

## 2026-11-06 — Settings speak in workers, and dispatch is visible

**Decision.** Remove the legacy "local providers" registry from the Agent settings page and fold its facts (installed, command, execution boundary, install action) into each worker row. Make the settings navigation a real tab list — `role=tablist/tab/tabpanel`, `aria-selected`, arrow/Home/End keys, focus follows selection, per-panel scroll memory, a 120 ms fade/slide that honours `prefers-reduced-motion`. Add a "Worker 派发" block to a run's audit detail showing, per step, the chosen worker, its provider, the routing source (explicit / rule / memory / description) and the reason, read from the journal's `dispatch.decided` events.

**Alternatives rejected.** (a) Keep the provider list and rename it "runtime" — two lists of the same machine, and the owner still has to translate between them. (b) Move provider controls to a separate settings page — hides the install and execution-boundary facts from the worker they govern. (c) Show dispatch only in the raw trace — it exists there, but "why did this step go to that worker?" is a first-class question, not debug detail.

**Evidence.** Owner feedback that the settings interactions feel abrupt and that the provider list is historical; the dispatch decision already journals `selectedAgentId`, `providerId`, `source` and `reason` (`src/main-agent/dispatch-recorder.ts`), so the new block adds no data. Deterministic checks: `test/ui-structure.test.ts` asserts there is no `provider-registry` section, that settings tabs expose tab semantics, and that the audit view renders a dispatch block.

**Cost and reversal condition.** The worker row grows by one line of metadata; removing the provider section removes the only place listing a provider that has no worker bound to it. Reverse if an owner needs to manage a provider before binding any worker, or if the tab semantics break in the packaged WebKit build.

## 2026-11-06 — The repair lane is a clone-ai Run, not a script driving another CLI

**Decision.** `clone-ai repair` performs the repair as a real Run inside the
Kernel: it accepts a trigger, attaches a two-phase plan, and executes it with
the workers the owner has configured (a black-box CLI worker, or any other
registered adapter). The lane keeps the existing gates from `scripts/nightly-rsi.mjs`
(the regression test is verified red before the fix, test files are hashed, the
staged diff may not touch protected paths) by importing
`scripts/nightly-rsi-policy.mjs` and `scripts/nightly-rsi-state.mjs` rather than
forking them, and it adds the worktree isolation, red-verification and hashing
as deterministic gates the application applies around/after the Run.

**Alternatives rejected.** (a) Keeping `claude -p` as the executor — AGENTS.md
§4 then describes a rule the system cannot satisfy, and the repair is performed
by a product that is not clone-ai. (b) A native (in-process, OpenAI-compatible)
repair worker as the mandatory executor — it would make the lane cheap to test
but bind the repair loop to one provider and to `CLONE_AI_NATIVE_*` configuration
that is absent on most machines; it remains available as a configured worker.
(c) A new, self-contained policy module for the lane — a second copy of the
protected-path list would drift from the one the nightly script enforces.

**Evidence.** Code inspection: `scripts/nightly-rsi.mjs` builds prompts and spawns
a binary, so neither the Kernel's approval, verification nor journal participates
in the repair. Its safety gates are imported here unchanged and covered by the
existing `test/nightly-rsi.test.ts` assertions. Deterministic tests prove each
lane gate with fake adapters (`test/repair.test.ts`). A real two-phase repair
needs a configured worker and an authorized failing trace; whether a configured
model produces an acceptable patch remains **assumed**, not measured here.

**What was given up.** The lane now inherits the Kernel's worker configuration
and its adapter contract, so a machine with no installed worker CLI cannot
repair, whereas the old script only needed `claude` on PATH. Black-box workers
never report `test` evidence, so a red-verification step that *checks* the tests
must be performed by the application around the Run, not by the verifier — the
Run's own steps are scoped to writing files.

**Reversal condition.** If the Kernel path proves unable to express a repair
(needs far more steps than a plan, or the adapter contract cannot carry the
hashes), return the two phases to a script but keep the trace export and the
policy module shared. If measurements show the configured worker cannot repair
real traces at an acceptable rate while a direct native client can, make the
native adapter the default executor instead of the fallback.

## 2026-11-06 — MCP tools are opted in per server and pass the same gate as built-ins

**Decision.** Add a small MCP client (stdio, plus streamable HTTP) that reads
`<clone home>/mcp.json`. Every server is disabled unless the owner writes
`"enabled": true` for it. MCP tools are converted to `NativeToolSpec`s carrying
an explicit risk (`read`, `write`, `network`, `external`) and are offered to a
worker only when `decideTool` accepts that risk against the step's grants; a
tool call that names a path is checked per call exactly like `read_file`. MCP
output crosses the observation boundary (`sanitizeObserved`, the same sanitizer
`renderObservationsAsFacts` uses) and reaches the model as quoted data.
Providers that cannot take `--mcp-config` (the native in-process worker, codex,
pi) simply receive built-in tools only.

**Alternatives rejected.** (a) An SDK dependency (`@modelcontextprotocol/sdk`)
— the protocol we need is one JSON-RPC request per tool (`initialize`,
`tools/list`, `tools/call`) over stdio or HTTP; a dependency would be justified
only once resources, prompts, sampling, or OAuth are in scope. (b) Enabling
every configured server by default — an MCP server is a tool surface the owner
did not write; enabled-by-default would silently widen what a model can do.
(c) Granting MCP tools network access by default because the transport is
network — the risk belongs to the tool's declared behavior, and the owner's
config states it per tool.

**Evidence.** Code inspection: today's tool table is built only from
`src/main-agent/tools/kernel-tools.ts` and `src/workers/native-worker-factory.ts`,
and the native worker already refuses ungranted risk (`decideTool`). Tests cover
disabled-by-default, refusal when a granted scope does not exist, offering when
it does, and output framing (`test/mcp.test.ts`). Whether a real third-party MCP
server's tools are useful under these risks is **assumed**.

**What was given up.** A server must declare each tool's risk in `mcp.json`
(the lane never guesses: an undeclared tool is treated as `external` and
refused). Tool results are text only — images and structured content are
stringified. A crashed server is reported as a tool error, not retried.

**Reversal condition.** Revisit if a real MCP server needs resources or prompts
(use a maintained SDK rather than extending this client), or if owners routinely
mark every tool `read` to avoid configuring risks — then risk must come from a
signed server manifest, not from owner config.

## 2026-11-05 — Self-check rebuilds the local macOS app

**Decision.** On macOS, `selfcheck:push` rebuilds and replaces
`dist/Clone AI.app` after tests, typecheck and gate pass, before pushing.

**Evidence.** The running app kept showing old UI after source edits because
the bundle is a packaged UI plus sidecar and does not hot reload. A stale app
made fresh audit and IME fixes invisible.

**Cost and reversal condition.** The check becomes slower and requires the
macOS build toolchain. If development moves to a live-reload runtime, remove
the bundle rebuild from this path.

## 2026-11-05 — Native worker is the default for eligible roles when configured

**Decision.** When `CLONE_AI_NATIVE_MODEL` and `CLONE_AI_NATIVE_BASE_URL` are
set, the default agent catalog uses `providerId: "native"` for direct, research,
draft and review. `external` keeps the CLI default because the native worker has
no governed action connector. Without the endpoint, the CLI defaults remain. A
provider id the owner has saved in settings always wins over the default.

**Evidence.** The native worker passed the 5/5 reliability benchmark (including
the expected `no_artifact` failure), enforces scopes at each tool call and
reports exact usage. The default catalog is used only when no settings file
exists or for agents the owner has not changed; saved choices are preserved.

**What it costs.** Default agents now depend on the native endpoint being up;
the native worker has file tools only (no network or external actions); an owner
who relied on the implicit Claude/Codex/Pi default for these roles will see a
different worker unless they save a choice.

**Reversal condition.** If the native worker regresses on the benchmark, or a
role needs a tool it does not have, restore the CLI default for that role.

## 2026-11-05 — Native Main Agent is the default when configured

**Decision.** With `CLONE_AI_MAIN_RUNTIME` unset, the Main Agent uses the native
loop when `CLONE_AI_NATIVE_MODEL` and `CLONE_AI_NATIVE_BASE_URL` are present, and
Pi otherwise. `CLONE_AI_MAIN_RUNTIME=pi` forces Pi; `=native` forces the native
loop and fails clearly if the endpoint is unconfigured. An explicit `native`
never silently falls back to Pi.

**Evidence.** The native loop now matches Pi on the short-task comparison (3/3
both, tokens within ~1.6%), and passed live long-context compaction and image
validation. It has streaming, deterministic compaction and image attachments.
The endpoint is an explicit owner configuration, so using it when present is not
a guess; using Pi when it is absent keeps existing installations working.

**What it costs.** Two runtimes remain to maintain, and the unset case is a
soft, environment-dependent default rather than a hard switch. An owner without
an OpenAI-compatible endpoint stays on Pi until they configure one.

**Reversal condition.** If the native loop regresses on the benchmark or the
turn audit, restore Pi as the default and keep native strictly opt-in.

## 2026-11-05 — Native Main Agent accepts image attachments

**Decision.** The native Main Agent sends image attachments as OpenAI-style
`image_url` data URLs in the current user message, alongside the text part. The
Pi-versus-native switch therefore no longer removes a capability. Images are
per-turn: they are not persisted in the turn ledger, so `search_history` finds
the text, not the pixels. No downscaling is done in this version; an endpoint
that rejects a large payload fails the turn with its own error.

**Evidence.** The main branch added media attachments to the Main Agent, while
the native branch explicitly refused images; switching `CLONE_AI_MAIN_RUNTIME`
silently removed a feature. Magpie's catalog advertises image input for the
models used here, and the OpenAI-compatible content-parts format is what the
native client already speaks.

**What it costs.** Base64 images inflate the request and the prompt token count;
a very large image can exceed an endpoint's body limit. The full image is not
recoverable from the ledger later.

**Reversal condition.** If payload size becomes a practical limit, store
attachments as content-addressed files under the clone home and send file URLs
when the endpoint supports them, or downscale before encoding. If image history
must be searchable, persist attachment locators in the turn event.

## 2026-11-05 — Native Main Agent streams and compacts deterministically

**Decision.** The native Main Agent requests SSE streaming with
`stream_options.include_usage`, forwards content deltas to `onDelta`, assembles
tool-call deltas by index, and parses the final usage chunk. When the transcript
exceeds `historyChars` (default 12,000), older turns are replaced by a bounded
deterministic summary; the newest turns stay verbatim. Full text remains in the
turn ledger and is reachable through `search_history`.

**Evidence.** The flag-gated native loop was non-streaming, so the interface
looked frozen until a whole round finished, and it kept only the last 12 turns
with no compaction. Magpie returns OpenAI-style SSE chunks and a final usage
chunk when `include_usage` is set, so both fit the existing client.

**What it costs.** The summary is extractive and truncated rather than
model-written, so it preserves topics and decisions less well than Pi's
generated summary. Streaming tool-call fragments add parser complexity, and a
malformed stream fails the turn with a clear error instead of guessing.

**Reversal condition.** If long-conversation quality suffers, replace the
deterministic summary with a model-written compaction step (one extra call) and
keep the deterministic one as the fallback when that call fails.

## 2026-11-05 — A native Main Agent loop behind a flag, not a flag day

**Decision.** Add an in-process Main Agent runtime selected by
`CLONE_AI_MAIN_RUNTIME=native`. It compiles the same charter, situation
briefing, executor list and memory push; offers the same Kernel tools through a
plain descriptor list; talks to an OpenAI-compatible endpoint named by
`CLONE_AI_NATIVE_*`; uses the turn ledger as its transcript; and writes the same
prompt snapshot, turn events, tool events and usage records. Pi remains the
default and the fallback. The first native loop is non-streaming and keeps the
last N turns without compaction.

**Evidence.** Pi is the Main Agent's last hard SDK dependency: it owns the loop,
the session file, compaction and `search_history`, while the Kernel already owns
tools, policy and completion. The native worker proved the same in-process,
per-call scope model works. A flag lets the two runtimes be compared on the
benchmark and through the turn records before any default changes.

**What it costs.** No streaming or compaction in the first phase; images are
refused under the native flag; the transcript is the turn ledger, so
`search_history` searches the ledger instead of Pi session files; the model must
be an OpenAI-compatible endpoint; native turns are not resumable as Pi sessions.

**Reversal condition.** If the native loop cannot match Pi on the benchmark and
the turn audit, keep Pi as the default and remove the native path. If streaming
or compaction is the blocker, add it before flipping the default.

## 2026-11-05 — A missing named input fails the native worker instead of allowing invention

**Decision.** If a read tool fails on a path named in the work order's objective
or the step's instructions, the worker ends the turn as `no_artifact` with
signature `native-missing-input`; artifacts produced after that read are not
accepted. A failed read on a path the instructions do not name is still returned
to the model so it can retry. The worker's prompt also tells the model to stop
and report a missing required input instead of inventing its contents.

**Evidence.** The `missing-input` benchmark task asks the worker to read
`docs/absent.md` and write `out/summary.md`. On 2026-11-05 the native worker read
the absent file, received ENOENT, then wrote an invented 90-byte summary and
passed verification; Claude failed cleanly at verification. The loop's
resilience to one bad call is right for a retry, but wrong for an input the task
declared as required.

**What it costs.** A task that names a path that is legitimately optional and
absent now fails. Instructions must name required inputs; the model may still
spend tokens before the guard fires.

**Reversal condition.** If real tasks routinely name optional paths, narrow the
rule to declared work-order inputs or an explicit `requiredInputs` field; do not
remove the failure on a required input.

## 2026-11-05 — The native worker becomes a provider with exact usage, still opt-in


## 2026-11-05 — Every Agent invocation is audited outside CLONE_HOME

**Decision.** Every Main Agent invocation writes a shared append-only record
under `~/.clone/audit/invocations.jsonl`, independent of the invocation's
`CLONE_HOME`. The record carries caller, surface, visible request and reply,
error, workspace, data directory, model, effort, session file, Run ids and
duration. An explicit `CLONE_AI_AUDIT_HOME` can relocate it for controlled
deployments and tests.

**Evidence.** Self-fix runs used a temporary `CLONE_HOME`; their journals were
correct but invisible to the desktop audit, which reads the owner's normal
home. After this change, a real DeepSeek V4.1 Flash `high` turn launched with
an isolated home appeared in the shared default ledger with caller `codex` and
reply `OK` (invocation `7cb576ee`).

**Cost and reversal condition.** This is a second storage location and the
visible reply is sensitive data; it is PII/token-redacted, truncated, and
excludes private reasoning. Replace it with an encrypted owner-scoped store if
the plaintext JSONL no longer meets the threat model.

## 2026-11-05 — Require explicit intent for root-level file names

**Decision.** `native` is registered in the provider catalog, so an owner can
select it per agent like any CLI. The adapter's id is the configured agent id
and its `providerId` is `native`; its capabilities come from the agent role,
with external effects excluded. Its model client reports exact token usage per
model call, which the Kernel journals as `usage.recorded` with runId and stepId.
It still requires `CLONE_AI_NATIVE_MODEL` and `CLONE_AI_NATIVE_BASE_URL`; it does
not become the default.

**Evidence.** The worker already existed and enforced scopes at each tool call,
but it was invisible to settings (only a special case in the agent registry),
reported no usage, and its adapter identity was literally `native` rather than
the configured agent. The turn/run audit can now carry exact usage; leaving the
native path unmeasured would make any CLI-versus-native comparison impossible.
**Evidence.** The nightly repair trace reported a false failure when the
verifier interpreted `fs.rename`, `os.tmpdir`, `consumed-traces.json`, and
`REPORT_DIR/consumed-traces.json` as required workspace files. Source
inspection shows the previous extractor accepted dotted tokens without those
distinctions. The targeted offline regression tests pass after the change;
broader coverage remains a hypothesis. No before-change eval was run under
this work order.

**What it costs.** The owner must configure an OpenAI-compatible endpoint; the
worker has no external-action tools, so `external` stays with governed
connectors; token counts depend on the endpoint returning a usage block.

**Reversal condition.** If endpoints rarely report usage, keep the gateway's
time-window inference as the fallback and mark exact usage unavailable. If the
native loop proves less reliable than a CLI on the benchmark, keep the CLI as
the default and native as opt-in.

## 2026-11-05 — Every Main Agent turn is a journal record, not a side file

**Decision.** Every entry point — CLI, `npm run main`, the companion/server, and
WhatsApp — writes the same two journal events for a turn:
`main_agent.turn_started` and `main_agent.turn_completed`. Each tool the Main
Agent calls also writes `agent.tool_started` / `agent.tool_completed`. The turn
record carries the input and reply (PII-redacted and capped), model, provider,
reasoning effort, token usage, prompt material hash, tool calls with redacted
argument summaries, and the terminal status. The existing
`main-agent-turns.jsonl` ledger is written by the same module, so the UI and the
journal cannot disagree.

**Evidence.** Before this change, CLI and `npm run main` wrote only a prompt
snapshot; the companion wrote a side JSONL that the audit never read; the Pi
`tool_execution_*` events were never subscribed to; and `usage.recorded` had no
turn id. A task an agent ran through `clone-ai "..."` could therefore leave no
auditable input, reply, tool call, or model usage. The journal is the
append-only truth, so turn data belongs there rather than in a second log.

**What it costs.** Input and reply text increase journal size. They are redacted
and capped, and the full transcript remains in the Pi session file named by the
event. Tool arguments are stored as a redacted summary, not verbatim.

**Reversal condition.** If journal growth becomes material, move the text to a
content-addressed turn file (the prompt-snapshot pattern) and keep only its hash
and locator in the event. If redaction proves insufficient for tool arguments,
store the tool name and a hash only.

## 2026-11-05 — Recover planning orphans only after a conservative grace period

**Decision.** Fail a planning Run only if it has no plan, no live claim, and
its last update is more than 15 minutes old. Acquire a recovery claim and
atomically reject the failure if the Run changed since the refreshed projection.
Leave stores that cannot make that conditional fenced write untouched. Do not
change recovery of running or verifying Runs.

**Evidence.** Recovery currently scans only `running` and `verifying`; a
planner that dies before producing a plan can leave a Run in `planning`
indefinitely. Assuming 15 minutes is sufficient for ordinary unclaimed
planning is conservative but not measured; an active planner without a lease
can still exceed it. Immediate failure or age alone would endanger fresh or
claimed work. Rechecking only in memory would allow a concurrent plan or
cancellation to be overwritten before the failure is written.

**Reversal condition.** If observed legitimate unclaimed planning takes more
than 15 minutes, replace the timeout with a reliable planner lease or adjust
the threshold based on measured durations before enabling this recovery.

## 2026-11-05 — Prompt provenance is a content-addressed file plus a journal event

**Decision.** Every Main Agent turn records the charter version, the compiled
briefing, the exact registered tool table, the model id, and the reasoning
effort. Full material goes to `<clone home>/prompt-snapshots/<materialHash>.json`;
the journal receives one `main_agent.prompt_snapshot` event carrying the hashes,
the locator, and (for desktop turns) the turn id.

**Evidence.** Before this change the journal could say what the agent did and
what it recalled, but not what it was told: `MAIN_AGENT_CHARTER` is a constant,
the situation briefing existed only in memory for the life of a session, and
the tool table existed only inside the Pi session. A failed turn therefore could
not be attributed to a prompt revision, and two "improvements" could not be
compared against a baseline. The journal is already the append-only truth
([`state-projector.ts`](../../src/state/state-projector.ts) rebuilds state from
it), so provenance belongs there rather than in a second log.

**Reversal condition.** If the journal becomes the wrong home for turn-level
telemetry (for example, retention rules require runs and turns to expire on
different schedules), move the events to a dedicated store keyed by the same
`materialHash`; the hash scheme and the file layout do not depend on the journal.

## 2026-11-05 — Tool provenance is captured at registration, not maintained as a list

**Decision.** `createKernelToolsExtension` reports every tool through an
`onRegister` callback at the moment it registers it. The hash covers the names,
descriptions, and parameter schemas the model actually received.

**Evidence.** A hand-maintained list of tool names is a second source of truth
that drifts silently the first time a tool is renamed or added — exactly the
kind of invisible change provenance exists to expose. The callback sees the
registered object itself, so it cannot disagree with the session.

**Reversal condition.** If tools can be registered outside
`createKernelToolsExtension` (a second extension factory, or MCP-hosted tools),
the registration choke point no longer covers the whole table; the snapshot must
then read the tool list from the session rather than from the callback.

## 2026-11-05 — The regression gate is offline, per-case, and behavior-only

**Decision.** `npm run gate` re-runs evidence verification and authority policy
over held-out fixtures, calibrates audit records against owner labels, and
compares every case with a recorded baseline. It calls no model and is a
required CI step.

**Evidence.** This repository's guarantees live in the rules around the model:
completion comes from evidence, authority from scopes, and owner labels from
`audit.labeled`. Those layers are deterministic, so a zero-cost gate can cover
them on every commit. A provider-dependent eval would be skipped precisely when
CI is under pressure.

**Reversal condition.** If recorded trajectory cassettes can be replayed without
network access, add a trajectory suite beside the deterministic one. The
per-case baseline remains valid for the judgment layers regardless.

## 2026-11-05 — A verdict change fails the gate even when it is an improvement

**Decision.** `baseline.json` stores each case's current outcome; any difference —
pass to fail or fail to pass — fails until `--write-baseline` is run in the same
change.

**Evidence.** An improvement that arrives without its diff being reviewed is
indistinguishable from a regression that happens to look better on the fixture
set. Requiring the baseline update forces the reviewer to see the behavior delta
and its rationale.

**Reversal condition.** If baseline churn starts to dominate review, split it by
suite or add an explicit per-case intent note; do not switch to silent
auto-update.

## 2026-11-05 — Workers inherit model credentials only, never tool credentials

**Decision.** A provider declaration may name the credentials its model client
needs. Any tool credential (`GITHUB_TOKEN`, `AWS_*`,
`GOOGLE_APPLICATION_CREDENTIALS`, `*_SECRET`, …) is refused before launch, with
an error that points at the credential broker.

**Evidence.** A black-box worker with a shell and a token can do anything that
token allows; the model needs its API key to answer, but it does not need the
owner's source-host or cloud credentials. The check runs at build time, before a
process exists, so a bad declaration cannot leak into a running worker
(`test/worker-env.test.ts`).

**What it costs.** A worker that genuinely needs a tool credential cannot be
configured by inheritance; it must go through the broker.

**Reversal condition.** If a trusted, narrowly scoped operation needs a tool
credential, add per-call broker injection after Kernel authorization; do not
re-enable inheritance.

## 2026-11-05 — Consistency is measured, and the first run failed three of four

**Decided:** `npm run bench:consistency` runs four consistency scenarios and two
restraint scenarios against the real recall + context + attention path.

**What the first run measured.** 1/4 consistency scenarios passed and 100% of
irrelevant observations became interruptions. The three failures were real:

- a moved meeting and the old time both reached the context;
- a changed preference competed with the previous one;
- a stated preference was not recalled at all against a long question.

**What was changed in response.**

- Preferences may be recalled below the product floor (0.08 instead of 0.2),
  but only on a *distinctive* match — a term shared by at most a quarter of the
  library. Measured: without the distinctiveness check the lower floor made an
  idle memory look used and defeated idle archival. Function-word bigrams
  (必须, 应该, 时候) were added to the same exclusion the Latin stopword list
  already applied.
- A newer memory using an explicit replacement verb (改到, 改用, 不再, "changed
  to") retires an older memory of the same type that shares a substantive term,
  **in the context only**. Similarity alone does not do it: "周五下午三点开会" and
  "周五的会改到周四下午" share two tokens of a dozen, so the verb is the signal.
- Observations earn an interruption only when their text asks for a decision
  (截止, 确认, due, invoice …). Everything else is background.

**What was given up.** A memory that supersedes another without saying so
("会改期了" with no verb) still leaves both in the context. An urgent-looking
message with none of the signal words is missed. Both are recorded, not hidden.

**Reversal condition.** Any of the three scenarios regressing is the signal to
revisit its fix; a semantic comparator would let the supersede rule drop the
verb requirement.

## 2026-11-05 — In-step resume: deliberately not built

**Decided:** a worker that dies mid-step is restarted whole (when replay-safe)
or failed; no adapter resumes inside a step.

**Why.** The two boundaries that matter are already enforceable — the step and
the run. Resuming *inside* a step means trusting a worker's claim about how far
it got, which a black-box CLI cannot make and a native worker would have to
commit to a checkpoint protocol before every side effect. The current policy
(re-queue only when replay-safe; fail when the work was external or
mid-verification) is the conservative reading of the same facts.

**What was given up.** A long step that dies at 90% is paid for again. For the
native worker this is bounded by its duration budget, not by correctness.

**Reversal condition.** If long steps become common and re-running them is
expensive, add an explicit checkpoint to `NativeModelClient` — a resumable
conversation state the worker itself wrote and can validate — never a guess
from workspace state.

## 2026-11-05 — Calendar and email arrive as read-only connectors

**Decided:** `CalendarConnector` reads ICS from a file or an https URL;
`EmailConnector` reads an IMAP INBOX. Neither can write, accept an invite or
send mail. Credentials are named (`env`) and read from the process environment
at build time; a missing variable leaves the connector disabled and says why.

**Why ICS and IMAP rather than vendor APIs.** One reader covers Apple, Google,
Outlook and Nextcloud exports without OAuth, a vendor SDK, or storing a token
refresh flow. IMAP is the one protocol every mailbox speaks.

**What was given up.** No push: both poll on the maintenance sweep, so a
calendar change is seen within one interval, not immediately. No thread bodies
beyond a snippet, and no attachments. Mail is read-only, so "reply for me"
remains a separate work order the owner must approve — deliberate, but it means
the twin cannot yet answer an email end to end.

**Reversal condition.** If replies become a product requirement, add an action
connector with receipts; do not add a write method to this observation
connector.

## 2026-11-05 — The memory context budget is spent per class

**Decided:** preferences may claim 50% of the remaining budget, task outcomes
25%, project facts 20%, agent outcomes 5%, filled in that order, with unused
capacity rolling forward.

**Why.** A flat 1200-character cap let a week of finished-task logs crowd out
the one preference that would change an answer; preference questions were the
worst slice on LongMemEval, at 56.7% context hit rate against 92-99% elsewhere.

**What was given up.** Ranking is no longer purely by relevance score: a
high-scoring task memory can be dropped for a lower-scoring preference. That is
the intended trade, but it means a debugging question about a recent task may
see less of that task than before.

**Reversal condition.** If the context-boundary benchmark shows a regression on
task-shaped questions, raise the task-outcome share or make the weights depend
on the intent.

## 2026-11-05 — Conflict detection is token overlap, and says so

**Decided:** `findConflicts` compares token overlap (overlap coefficient) among
active memories of the same type; ≥0.55 is a near-duplicate, ≥0.35 a subject
worth reviewing. Matched restatements are dropped from the recalled set before
the context is built.

**Measured limits.** Reworded statements score 0.57-0.93; unrelated ones 0.0-0.4.
A *changed value* in Chinese ("蓝色" -> "绿色") scores only 0.29 and is therefore
**not reliably caught** — the differing value replaces a bigram at both ends.
The tests assert the cases that work and say so in the comment; they do not
assert the case that does not.

**What was given up.** Contradictions phrased differently remain undetected, and
may both be recalled. Mitigation: only one is dropped when they *are* detected,
and the owner sees conflicts as review suggestions rather than automatic
deletion.

**Reversal condition.** An embedding-based comparison, measured on the same
pairs, that catches the value-change case above.

## 2026-11-05 — Supersedes: conversation mining defaults to a cheap local filter

**Decided:** `CLONE_AI_MEMORY_MINING` is now a three-way switch.
Unset = `filtered`: a turn is mined when it contains a durable-statement
signal (`src/memory/mining-policy.ts`), `off` silences both conversation and
task mining, `all` mines every turn. Task mining keeps the deterministic worker
unless the mode is `all`.

**Why the earlier entry changed.** "Opt-in" meant the feature a personal agent
needs most — learning without being asked — was off out of the box. The filter
is local, has no model call, and errs toward mining: a missed statement is a
memory never learned, an extra call is a few cents.

**What was given up.** Turns without a signal are never mined, so a fact stated
plainly but without any of the matched patterns ("杭州今天下雨" followed later by
a request) can be missed. `all` is the escape hatch.

**Superseded (task mining).** The default deterministic worker is retired by
[2026-11-18 — A finished task is not a memory](#2026-11-18--a-finished-task-is-not-a-memory-candidates-must-state-durable-knowledge);
only `=all` selects the model miner.

**Reversal condition.** If the filter's miss rate is visible in practice, widen
the signal list or make `all` the default.

## 2026-11-05 — Consume repaired traces by runId and file fingerprint

**Decided.** Store the latest successful batch outcome for each runId alongside
the SHA-256 of the exact input file, and skip only a matching pair. Mark only
`fixed`, `pr-created`, or `patch-only`; an error remains eligible. Persist via
a same-directory rename; an unreadable or malformed state falls back to empty.

**Evidence and alternatives.** The current `loadTraces` reads the first files
without a record of earlier outcomes, so unchanged failures are sent to repair
again; this follows from code inspection, not a measured production incident.
Always retrying wastes repair work; recording runId alone would suppress new
content. The effectiveness of the complete model-dependent workflow remains
**assumed**, since it is outside this offline work order. Lost or corrupt state
can cause repeat work, and a later failure after a successful outcome does not
roll that outcome back.

**Reversal condition.** Replace this file-based scheme if a durable shared
ledger is needed across machines, or if trace exports change bytes without
changing actionable evidence often enough to cause repeated repairs.

## 2026-11-05 — The agent runs its own adversarial suite and repair loop

**Decision.** Add a deterministic, offline adversarial suite (injection wrapping, approval replay/expiry/forwarding, protected paths and symlink escapes, tool credentials in worker env, secret-memory recall, trace redaction, rate limits) plus a self-check loop that records every round in the journal and, on a red probe, exports the failure as a trace for the existing gated repair lane. A round runs the suite, `npm run gate`, and (optionally) `npm test`; repairs still produce a draft PR and merging stays with the owner.

**Alternatives rejected.** (a) Model-driven red teaming as the primary loop — nondeterministic, costs tokens per round, and cannot be compared across runs; kept as a later layer. (b) Letting the loop edit code directly — violates the existing repair gates and makes "did it improve?" unanswerable. (c) A separate test runner — the repository already has `npm run gate` and `node --test`; a second runner would drift.

**Evidence.** Every probe corresponds to a boundary that already exists in code and has a unit test or prior incident: forwarded WhatsApp content (shipped with `forwarded` + `<untrusted_data>`), approval codes (one-time, hashed, TTL), `forbiddenRoots`, `assertWorkerEnvName`, secret-memory exclusion, `digestEvents`. The suite turns those into one measured, recorded signal instead of scattered assumptions. Deterministic probes pass on this revision; the loop's repair branch is exercised with `--dry-run`.

**Cost and reversal condition.** Each round is CPU-only and adds one journal event plus a report file; repairs cost model tokens only when a probe is red and `--repair` is passed. Reverse this if the suite stops distinguishing a regression from noise (probes start passing regardless of code), or if a real incident shows the probe set missing the class that failed — extend the suite rather than loosening it.

## 2026-11-04 — Failed traces and repair run only in a gated, draft-PR lane

**Decision.** Failed and cancelled runs become redacted, self-contained trace
documents, including implicit failures no error code records: a step retried
three or more times, a cancel, an "不合格" label, or an owner correction within
ten minutes. The nightly repair job runs in a fresh worktree, requires a
regression test that the script verifies is red before the fix, hashes the test
files across phases, blocks protected paths from the diff, and produces a draft
PR (or a patch file) only. It never merges, deploys, restarts, or edits its own
schedule.

**Evidence.** Unattended code generation is the highest-risk action in the
system. Each gate closes a specific failure mode: writing in the serving
checkout; a "fix" without a reproduction; a model making the suite green by
rewriting the test; a fix that edits the rules that judge it; and an automatic
merge. `scripts/nightly-rsi.mjs` implements all five, and its report states that
merging remains the owner's decision.

**What it costs.** Tests plus a diff check bound the damage but cannot prove a
fix is safe; a human must read the PR. No traces means no run, and a failure
keeps the worktree for inspection.

**Reversal condition.** Do not relax the draft-PR gate for a general fix. If a
sandboxed runner can prove the fix against the full suite and enforce the
protected-path rule mechanically, a separate trade-off may allow auto-merge for a
named allowlist of paths — never for broad changes.

## 2026-11-04 — Self-review may change configuration, never the rules

**Decision.** A review reads the audit digest and may propose at most four
actions, restricted to a worker's or the Main Agent's model and reasoning
effort. Each action is validated against what the machine declares it can do,
applied only on the owner's click, journaled as `recommendation.applied` with
the previous and new value, and reversible from the same row. Code, prompts,
policy, and evidence rules are not reachable, and nothing runs on its own.

**Evidence.** An agent that can widen its own authority is a risk, not an
improvement loop; authority and completion belong to the Kernel. The digest is
already a projection of the journal (`loadAudits` / `summarizeAudits`), so the
reviewer needs no new data path, and the model-failure path degrades to measured
facts (`test/self-review.test.ts`).

**What it costs.** The narrow surface cannot fix a code or prompt defect; the
review can only tune model and effort. That is deliberate.

**Reversal condition.** If the configuration surface proves unable to address a
real failure class, add a new action kind only through its own trade-off with
validation and rollback — never by widening this one to code, prompts, policy,
or evidence rules.

---

## 2026-11-04 — Attempted and reverted: a persisted replay watermark

**Decided:** no watermark. A fresh process always replays the whole journal.

**What was tried.** Store the last applied sequence in the journal so a
restarted runtime resumes incrementally. Two tests failed immediately: a second,
independent runtime over the same journal resumed from the *first* runtime's
position and applied a mid-history `run.status_changed` for a run it had never
seen, and the JSONL-backed kernel view lost a run the same way.

**Why it cannot work as designed.** The projection lives only in memory. A
watermark records where *some* projection stopped; a new process has no
projection to continue, so the watermark can only tell it which events to skip —
exactly the events it needs. Persisting the watermark without persisting the
projection is the bug, not a shortcut.

**What this costs.** A restart pays one full replay: measured at 117 ms for
100,000 events. Acceptable, and it is the same order as the work the process is
about to do anyway.

**Reversal condition.** Persist the projection itself (a materialised snapshot
with its sequence), not just the sequence. Then a restart can load the snapshot
and apply the tail. Until then, this entry stands.

## 2026-11-04 — Tool and model budgets are enforced when the adapter reports them

**Decided:** the Kernel counts `tool_started` and a new `model_call` event per
execution attempt and fails the step with category `budget_exceeded` past the
work order's ceiling. The native worker also refuses further calls inside its
own loop, and reports `model_call` and `tool_completed`.

**What was given up.** For black-box CLI workers the ceilings remain
declarations: a CLI that does not report its calls cannot be counted. The
`sandbox` and duration budgets are what actually stop those. The contract
comment now says so instead of implying enforcement everywhere.

**Why not stricter.** Killing a CLI process on a call count the Kernel cannot
observe would require parsing the CLI's output protocol, which the black-box
adapter deliberately does not do.

**Reversal condition.** If a CLI grows a structured event stream, wire its
counts into the same counter; the Kernel side needs no change.

## 2026-11-04 — Background readers ask for the event types they need

**Decided:** `SqliteJournalStore.listTypesSince(types, sequence)` (using the
`(type, sequence)` index), and `src/core/journal-types.ts` with `readTypes`,
`readForRun`, `readSince` fallbacks for stores without the fast paths. Memory
governance, the memory pipeline, conversation mining, opportunity scan/list/
resolve/find, the daily report and the commitment reconciler now use them.

**Why it won.** Measured on a 100,000-event journal: `list()` takes 117 ms and
`listSince(tail)` / `listForRun` take 0–3 ms. Every 2-second queue tick and
every opportunity scan was paying the full-scan cost for a handful of rows.

**What was given up.** Each consumer now declares the event types it depends
on. A new event type that a consumer needs but does not list is silently
invisible to it — the reconciler's `RECONCILE_TYPES` is the risk. That trade
was accepted because the alternative (reading everything) is the cost this was
meant to remove; the list is beside the reader it belongs to, and the fallback
path keeps tests and the JSONL store correct.

**Reversal condition.** If a consumer is found missing an event type in
practice, the fix is to widen its list, not to drop the narrowing.

## 2026-11-04 — Journal reads are incremental, with a full-rebuild fallback

**Decided:** `SqliteJournalStore` gained `listSince(sequence)` and
`listForRun(runId)` plus indexes on `(run_id, sequence)` and `(type,
sequence)`. `CloneRuntime.refresh()` and `PersonalStateStore.hydrate()` apply
only the tail and advance a remembered applied sequence.

**Alternatives:** keep replaying the whole journal on every refresh; add a
separate incremental event log alongside the journal; paginate the projection.

**Why it won.** `list()` was an unindexed full scan and every refresh called it,
so the cost of each queue tick grew with total history — a structural problem
that gets worse the longer the twin lives, not a tuning issue.

**What was given up.** A correctness case has to be handled explicitly: if an
event arrives with a sequence at or below the applied one, the journal was
replaced, truncated or reordered, and the projection is rebuilt from zero. The
first implementation missed the second half of this — events applied by orphan
recovery advanced the projection without advancing the applied sequence, so the
next refresh replayed a `running -> queued` transition the state machine
refuses. All event application now goes through one `#applyEvent`, and the
kill-restart test caught it.

**Reversal condition.** If projection rebuilds from a replaced journal become
common (a migration that rewrites history, say), the applied sequence should be
stored rather than held in memory, or `refresh` should verify a journal identity
instead of inferring replacement from ordering.

**Status:** the indexing and incremental path are covered by
`test/journal-incremental.test.ts`; no timing benchmark was run, so the size of
the win is inferred from the query shape, not measured.

---

## 2026-11-04 — Removed the hashed-ngram "semantic" recall term

**Decided:** remove it. `MdMemoryStore.recall` keeps the bigram ratio, the
IDF-weighted cosine, the preference prior, and the stopword floor.

**Alternatives:** keep it behind `CLONE_AI_RECALL_SEMANTIC`; replace it with a
real embedding service.

**Why it lost.** Ablation on LongMemEval-s (470 scored questions, full haystack,
maxResults=10):

| metric | semantic on | semantic off |
| --- | --- | --- |
| any@1 | 77.9% | 76.6% |
| any@5 | 91.3% | 91.7% |
| any@10 | 95.5% | 94.9% |
| ndcg@10 | 82.0% | 81.5% |
| context hit rate | 92.6% | 92.8% |

The deltas run in both directions and are inside noise for n=470. A ranking
term that cannot be shown to help is a per-query cost (an extra SQL fetch per
candidate, a 2048-bucket table, and ~40 lines of hashing) for nothing.

**What was given up.** The specific case it was meant to catch — a paraphrase
sharing no exact term, e.g. "周五要交周报了" vs "每周五提交工作汇报" — is no longer
covered. It was never demonstrated to matter on the benchmark either.

**Reversal condition.** Any of:

- a real embedding endpoint becomes available (local model, gateway feature) and
  beats the lexical path on the preference slice, which is the weak spot:
  any@1 20.0%, any@10 70.0%;
- a product-level question type appears where exact-term overlap is structurally
  absent (cross-language, heavy abbreviation);
- a rerun at a larger sample (LongMemEval-m) reverses the sign.

## 2026-11-04 — Kept the IDF-weighted cosine term

**Decided:** keep it inside `recall`.

**Why it won.** It never admits a memory that shared no term, so its worst case
is reordering memories that already matched; the stopword floor added in the
same change removed the failure mode it did have (a single "the" passing the
0.2 ratio floor).

**What was given up.** One SQL query per candidate per recall.

**Reversal condition.** It is worth re-measuring on its own; if it shows no
gain either, remove it by the same standard as the semantic term.

**Status:** assumed for now — not yet measured in isolation.

## 2026-11-04 — Memory is pushed into the Main Agent prompt, not left to pull

**Decided:** `before_agent_start` recompiles matching memories into the system
prompt on every turn.

**Alternatives:** keep `recall_memory` as the only path; inject a user-role
message instead.

**Why it won.** Pull-only memory meant the owner could approve a memory and
still be answered as if it did not exist. The system-prompt route reuses the
same 1200-character / 6-item boundary the workers already get and leaves the
conversation history untouched (a user-role injection would appear in the
transcript and in `readConversation`).

**What was given up.** One recall per turn (a short-lived SQLite handle), and
the system prompt changes between turns, which weakens prompt caching.

**Reversal condition.** If per-turn latency becomes visible, or if prompt
caching savings outweigh push accuracy.

## 2026-11-04 — Conversation mining is opt-in (`CLONE_AI_MEMORY_MINING=1`)

**Decided:** off by default, same as task mining.

**Why it won.** One model call per owner turn. A default-on miner would spend
the owner's budget on conversations that produced nothing worth remembering.

**What was given up.** Out of the box, the twin does not learn from
conversation — the largest functional gap against companion products.

**Reversal condition.** Once a cheap or heuristic pre-filter can reject turns
that obviously contain no durable statement, the miner can default on.

## 2026-11-04 — Lessons from failure clusters are authored, not mined

**Decided:** a failure signature seen in 3+ runs produces a `procedure` memory
via `MemoryGovernance.author()` after owner approval, not a mined candidate.

**Why it won.** A mined candidate may only cite evidence from its own run; a
cluster spans several runs, so no single run can justify it. The owner's
approval is the evidence.

**What was given up.** The lesson text is template-built (`category`, count,
signature, catalog guidance) rather than model-written.

**Reversal condition.** If lesson quality proves to matter more than citation
purity, allow multi-run candidates with an explicit evidence set.

## 2026-11-04 — Native worker is configured by environment, not enabled by default

**Decided:** `CLONE_AI_NATIVE_MODEL` + `CLONE_AI_NATIVE_BASE_URL` opt in;
otherwise the registry keeps using sandboxed CLI workers.

**Alternatives:** make it the default; register it always but fail at dispatch.

**Why it won.** The CLI workers have an OS-enforced boundary. The native worker's
boundary is enforced by our own code, and until it has production mileage, the
safer default should be the one with the sandbox.

**What was given up.** Two worker types to reason about; the native path is
untested at scale.

**Reversal condition.** After the native worker has run real owner tasks with
no boundary regressions, it can become the default for non-coding work.

## 2026-11-04 — Archived memories, not deleted

**Decided:** expiry, idleness and retirement all archive; nothing is destroyed.

**Why it won.** `memory.restored` makes every decision reversible, and the
journal remains an honest record of what the twin once knew.

**What was given up.** Disk grows without bound in principle.

**Reversal condition.** Add a purge of memories archived for N years, with the
owner's explicit consent and a journaled reason.

## 2026-11-04 — 90-day lifetime and 90-day idleness

**Decided:** promoted memories default to a 90-day expiry; any active memory
unused for 90 days is archived.

**Why it won.** 90 days matches one project, one work cycle or one term — the
owner's own framing.

**What was given up.** A still-true fact that simply was not retrieved for 90
days disappears from recall. It is recoverable, but the owner has to notice.

**Reversal condition.** If the improvement loop's usage data shows restored
memories were in fact still useful, lengthen the window or exclude authored
memories.

**Status:** the 90-day figure is assumed from the owner's description, not
measured.

## 2026-11-04 — Owner labels outrank system verification

**Decided:** in outcome attribution, `audit.labeled` decides good/bad; system
verification is the fallback.

**Why it won.** The label is the ground truth an eval compares the system's
verdict against. Where they disagree, the system was by definition wrong.

**What was given up.** A single careless label pollutes the attribution for
every memory exposed to that run.

**Reversal condition.** If labels prove noisy, require a note or a second
confirmation for `fail` labels on completed runs.

## 2026-11-04 — Improvement suggestions are deterministic and capped at 10

**Decided:** suggestion ids are derived from the basis (`retire:<id>@<bucket>`),
and at most 10 are pending at once.

**Why it won.** Recomputing on every tick must not create duplicates; and a
flood of approvals trains the owner to approve blindly, which defeats the gate.

**What was given up.** A genuinely new suggestion can be delayed until older
ones are decided.

**Status:** the bucket size and the cap of 10 are assumed, not tuned.

## 2026-11-17 — Local browser verification through Playwright MCP

**Decided:** a native worker may open the page it just wrote, through an
owner-enabled Playwright MCP server and a loopback static server. Only the
observation subset is declared (`browser_navigate`, `browser_console_messages`,
`browser_snapshot`, `browser_evaluate`, `browser_take_screenshot`,
`browser_press_key`, `browser_resize`, `browser_wait_for`,
`browser_navigate_back`, `browser_close`); `browser_run_code_unsafe`, file
upload and drag/drop stay undeclared. The browser is headless, isolated, rooted
at the workspace, and limited to the local preview origin. A narrow standing
policy grants `network read 127.0.0.1`; `browser_navigate` is declared `read`,
`browser_evaluate`/screenshot/keyboard are `write`.

**Alternatives rejected:** (a) add a shell/browser tool to the native worker's
core — a wider tool surface and a new exec risk class, against the four-tool
boundary; (b) enable unrestricted `file://` access so Playwright can open a page
without a server — that lets the browser read any file on the machine;
(c) keep four file tools and leave verification to the owner — that is the
status quo that produced blind one-shot pages and owner review.

**Evidence:** the 2026-11-17 browser-MCP eval. Before, the worker had no way to
observe a page. After the change it called `browser_navigate`,
`browser_wait_for`, `browser_console_messages`, `browser_evaluate` and
`browser_take_screenshot` in one step, fixed its own color change and wrote
`screenshot.png` (run `25521d80-d370-4a56-a45b-897639291b6b`). The first attempt
exposed a provider 400 because the assistant message echoed the real tool name
`playwright.browser_navigate`; sanitizing the assistant tool-call name fixed the
loop. The declaration/wiring is covered by 8 cases in
`test/browser-mcp.test.ts` and the name round trip by 3 cases in
`test/provider-tool-names.test.ts`.

**What was given up:** the browser child process is not an OS sandbox;
`--allowed-origins` is a hint, not a boundary. `browser_evaluate` runs arbitrary
JavaScript in the page and is declared `write`. The worker cannot see images, so
screenshots are evidence for the owner, not for the model. The first launch needs
network for `npx`.

**Reversal condition:** if a browser enabled this way reaches a non-local host
despite the local URL surface, or if the MCP child cannot be closed with the
step, remove the server. If a first-party tool with per-call URL gating lands,
prefer it over this MCP server.

## 2026-11-17 — A fallback work order gets 40 model calls, not 20

**Decided:** the deterministic fallback planner's default work-order budget rises
from 20 model calls / 100 tool calls to 40 / 200. The 10-minute duration cap and
the two-attempt limit stay.

**Why it won.** A one-sentence FPS brief produced a playable game inside 20 calls,
but the run stopped mid-verification, before headshots, cover or reinforcements
existed. The same brief with 40 calls produced 10 enemies, headshot damage, a
reinforcement wave, cover state, crouch/slide/lean and grenades, and used the
browser tools to check itself. The missing features were exactly the work a
second verification pass costs.

**What was given up.** Up to 2x model calls per fallback work order. The 40-call
run took about 62 minutes wall-clock and lost its execution claim before its own
final report; the artifact was still written and was functionally checked by the
working agent. The duration cap and claim renewal need a separate fix; 40 is not
a license for unbounded runs.

**Reversal condition:** if fallback tasks mostly finish inside 20 calls, or the
extra calls do not change the artifact, revert to 20. If a per-task budget
planner lands, delete this fixed default.

## 2026-11-17 — Long builds are queued, not held inside the chat turn

**Decided:** the Main Agent charter and the `dispatch_task` description now say
that a build expected to take more than a minute must be queued with
`propose_work_plan`; the conversation returns at once and the queue consumer
runs the worker. `dispatch_task` stays for short, bounded tasks.

**Why it won.** The 40-call FPS build used `dispatch_task`. Its turn took 50
minutes: a first run timed out inside the call after 12 minutes, then planning
continued, and the process hit the one-hour background/claim boundary before the
run's terminal status was written. The queued rerun returned the Main Agent at
once and finished the run in 211.9 seconds (47 tool calls, 33 model calls), with
a terminal `waiting_review`. The same artifact was produced; the difference was
where the waiting happened.

**What was given up.** A build is now two visible phases — the plan, then the
run — and the owner must watch or return to the run. A workspace that does not
know about the preview server can still make the worker's browser check fail
(the worker reported exactly that instead of claiming success).

**Reversal condition:** if `dispatch_task` gains asynchronous progress and a way
to join a run without blocking the turn, remove the steer and let the model
choose either path.

## 2026-11-17 — Reserve the last two rounds for a final answer

**Decided:** when an agent turn has two model rounds left, the shared loop adds a
system budget notice: stop exploring and editing, run only the essential final
check, and answer with what was built, what was verified, and what remains
unverified.

**Why it won.** The 60-round FPS build produced a complete, browser-checked v4
with menu, relay interaction and debrief screenshots, then failed because it
spent the last round polishing instead of answering. The artifact was good; the
run's terminal status was not. The notice makes the last two rounds do the job
the owner actually needs — a check and a report.

**What was given up.** Two rounds of potential polishing. On a task that needs
the tail for real work, the notice can stop it early; the budget must then be
raised rather than the notice removed.

**Reversal condition:** if runs with the notice routinely end with a materially
worse artifact than runs without it, reserve three rounds or make the reserve
configurable. If models ignore the notice, make the final round answer-only.

## 2026-11-18 — The capability benchmark owns its own workspace and checker

**Decided:** capability benchmarks get a subdirectory under
`benchmark/capability/`, a `setup.mjs` that produces a clean workspace, an
`expected.json`, and an independent checker that drives the artifact's public
test hook. The existing Forbidden City benchmark keeps its structure; new ones
follow this shape.

**Why it won.** The Forbidden City benchmark had a workspace, a prompt and a
checker, but the FPS work first used a hand-prepared workspace and a
ad-hoc browser script. That made the "one query" claim unverifiable: the result
depended on what the harness happened to leave in the directory. A generated
workspace plus an independent checker makes the claim reproducible and keeps
scoring out of the worker's own report.

**What was given up.** The model must expose a public hook (`window.__game`) that
the checker can drive; a game with a beautiful private architecture and no hook
scores as a failure. The checker is behavioural, not aesthetic: it cannot judge
gunplay, audio or fun.

**Reversal condition:** if a benchmark needs a private, non-inspectable artifact
to be fair, replace the hook-driven checker with a recorded playtrace; if hook
driving proves easy to fake, add an independent scripted playthrough.

## 2026-11-19 — The machine is the workspace: reads are not confined

**Decision.** A worker may read any readable location on the local computer.
The step's workspace stops being a read boundary; it remains the write
boundary. Writes stay limited to the workspace plus the roots the Kernel grants
through `files` scopes, and protected locations (credentials, browser profiles,
Clone AI's own journal and token) are still refused before any policy can open
them. The Main Agent is told that it has no filesystem tool of its own, but that
a read-only step can look anywhere, so a project named outside the current
folder is found by reading it rather than by asking the owner for a workspace
switch. `search_history` already reaches every task conversation; this makes the
same rule true for files. The macOS sandbox profile already allowed reads
elsewhere by default (`strictReads` was opt-in); the tool gate was the stricter
layer.

**Alternatives rejected.**

- *Keep workspace-only reads and require a read scope for every outside path.*
  That was the gate. Run `062716a9` refused `list_directory("..")`, so the worker
  reviewed the Clone AI workspace instead of the project the owner named, and
  the honest reply became "outside the workspace" on a personal computer where
  the owner can read the file themselves. A read scope adds a plan and approval
  round for information the owner already owns, and "workspace switch" changes
  where writes land in order to answer a question.
- *Make writes machine-wide as well.* Writes are the part that can destroy or
  exfiltrate; the existing `files` write scope plus the Kernel's approval is the
  human check. Reads need no such check.
- *Open protected locations too.* No scope or approval can open keys, browser
  profiles or the journal; a model that can read `~/.ssh` can leak it in one
  prompt. "All places are readable" removes the project-folder boundary, not the
  credential boundary.
- *Add a disk-search tool in the same change.* Reading anywhere makes discovery
  possible with `list_directory`; a search or glob tool has its own ranking,
  budget and prompt-injection questions and is a separate optimization.

**Evidence.** Before this change `decideTool({ risk: "read", path: <outside> })`
returned `The path … is outside the step's granted scopes.`; the worker prompt
said "Paths outside the workspace … will be refused", and the Main Agent prompt
said "Workers can only read and write inside this workspace". The macOS profile
in `src/authority/seatbelt.ts` already allowed reads outside the granted roots
by default, so the tool gate was refusing what the OS allowed. The documented
incident behind the workspace-only rule is run `062716a9` (nine evidence rows
from the Clone AI workspace, `list_directory("..")` refused); trade-off
2026-11-18 records it.

**What it costs.** A worker can feed any readable file into the model, so
unrelated personal content and prompt injection are now reachable; the protected
list is the only carve-out. Evidence rows can point outside the workspace, so a
review may cite files the owner did not expect. A vague objective can read
unrelated folders; the step's risk class and tool budget bound the cost, not the
path. The `.git` write guard still covers only the workspace repository; a
granted write root elsewhere is owner-approved.

**Reversal condition.** If a run leaks credentials or unrelated personal files
into a prompt or trace, or if the product serves more than one person,
reintroduce a read policy: require read scopes for outside roots by default and
enable `strictReads` in the OS profile. Keep the protected list in every
variant. If models routinely waste rounds exploring, add a bounded search tool
before widening further.

## 2026-11-19 — Writes have no workspace either; every write carries a scope

**Decision.** The live folder is no longer an implicit write root. A worker may
write only when the step declares a `files` write scope covering the target,
the policy engine approves that scope (or the owner approves the step), and the
target is not a protected location. The step's workspace is only the folder
relative paths resolve against and the default target a planner proposes for a
new deliverable; it grants nothing by itself. When a write step names no target,
the Kernel adds the workspace as an explicit scope at `attachPlan`, visible in
the journal and the audit, and the policy engine still checks it. External and
irreversible work runs in an isolated copy the Kernel creates; that copy and
the repair lane's own worktree are writable as sandboxes, never the owner's live
tree. Reads stay machine-wide.

**Alternatives rejected.**

- *Keep the implicit workspace write root.* Then `observe` does not mean "no
  writes": the owner's `~/.clone/policies.json` has no `files` domain, which is
  `observe`, yet any step could write the workspace. A folder was a permission
  nobody granted, and the authority pane could not describe it.
- *Allow every non-protected path and rely only on the step's risk class.* A
  prompt-injected step could write anywhere the owner can; `reversible_write` is
  auto-allowed by the base policy, so the "check" would be a label.
- *Ask for human approval inside every tool call.* The native worker has no
  approval callback; a per-call prompt needs a new UI channel and blocks the
  loop. The step is the existing approval unit, and its scope is visible before
  execution.
- *Auto-grant the home directory as the new default.* That is a workspace by
  another name, cannot be narrowed per task, and hands every task the same
  reach.
- *Make the repair lane declare scopes like an owner task.* The lane writes only
  in a git worktree it created after the owner invoked `npm run repair`; treating
  that sandbox as an owner write would block the loop on a policy the owner did
  not set. The assembly carries `workspaceWritable` for that tree alone.

**Evidence.** `resolveGrants` always added the workspace to `writeRoots`, so
`decideTool` admitted a workspace write with no scope. The owner's
`~/.clone/policies.json` contains no `files` domain (observe), yet workspace
writes succeeded. With this change the same path is refused until a scope is
present; `AuthorityPolicyEngine` then denies writes while the domain is
`observe`, asks for approval at `prepare` or `act_with_approval`, and allows
automatically only under an `act_auto` standing policy. `test/write-scopes.test.ts`
(9/9) pins the auto-fill, write-cue extraction, and the observe/approve
transition; `test/path-gate.test.ts` pins that the live workspace is not a write
root while the isolated copy is.

**What it costs.** A write step now needs a scope. A Main Agent plan that writes
elsewhere must declare that path; the fallback planner's prose is scanned for
absolute and `~/` targets, and otherwise the workspace is proposed. With the
owner's current `observe` setting, every write is denied until the owner raises
`files` to at least `prepare` or `act_with_approval`, or adds a standing policy;
that is the intended permission check, not a regression. Approval is per step,
not per file. The audit now lists each step's scopes instead of a count.

**Reversal condition.** If step-level approval is too coarse for folder-sized
work, add a standing policy for that folder at `act_auto`; do not reintroduce an
implicit root. If planners routinely name targets the extractor misses, add an
explicit `request_write_scope` tool or a per-call approval channel instead of
widening the default.
