# Architecture trade-offs

**English** · [简体中文](trade-offs.zh-CN.md)

A decision is only durable when its reason is written down. Each entry states
what was decided, the evidence behind it, and the condition under which a
future reader should reverse it.

## 2026-11-25 — Marketplace cards install with one reviewed default risk

**Decision.** A marketplace card for an entry with no required input installs
directly: the card's 安装 button probes the pinned package and grants every
exposed tool the entry's reviewed `defaultRisk` (filesystem `write`, memory
`write`, sequential thinking `read`, Playwright and Chrome DevTools `network`).
An entry that needs a directory still opens the install form, because that value
cannot be guessed. An installed card shows 管理, which opens the server's own
tools, load switch and remove control. The header reads "available · installed"
so the count matches the cards.

**Alternatives rejected.** Keep the 配置 label and the per-tool `external`
default: the owner had to open a second page and choose a risk for every tool
before the server was usable; the installed server also had no management
entry, so it could not be adjusted or removed from the market. Keep the label
only (安装 instead of 配置) but still require the detail page: reported as
"还要点进去配置嘛，太傻了吧".

**Evidence.** Owner report with the marketplace screenshot, 2026-11-25. The
live probe listed nine memory tools; the direct path was exercised end to end by
installing and removing `sequential-thinking` through
`/api/tools/install-registry` and `DELETE /api/tools/mcp/...` (both HTTP 200).
`test/mcp-registry.test.ts` pins the default risk, and `test/ui-structure.test.ts`
pins the card states, the count and the live-turn activity.

**Cost / reversal.** One risk class is coarser than per-tool choice, so a tool
that can do more than its entry's class would be under-declared. The install
page still edits every tool before a detail-page install, and the server detail
keeps the load and remove controls. Reverse if a reviewed entry's tool surface
gains a stronger class, or if an installed default enables an action the owner
did not expect: then the registry needs per-tool defaults, not one per entry.

## 2026-11-25 — A continuation resolves inside its conversation

**Decision.** Recent background work in the situation briefing is filtered to
the conversation that dispatched it. `compileBriefing` gains `conversationId`;
the per-turn prompt and `get_situation` pass the turn's conversation;
`renderRecentWork` resolves each terminal run through `run.created →
task.created.triggerId → trigger.received.payload.conversationId`. Runs from
another conversation, or with no attribution, are omitted when a conversation is
given; the Settings API passes none and keeps the app-wide text. The charter
adds: a continuation ("继续", "接着做", "把刚才那个弄完") refers to work this
conversation established; never resume another task's run; if this conversation
does not make the referent clear, ask. `search_history` stays app-wide when the
model explicitly asks for `scope: "all"` — deliberate recall remains available.

**Decision input.** The owner reported that "继续" does not always mean
"continue the run": sometimes they want something else, and a continuation
should be resolved per conversation, not across the app. The recent-work block
was the only automatic input that could put another task's run in front of this
turn.

**Why it is safe.** Every Main Agent proposal already carries `conversationId`
in its trigger payload (`proposePlanToKernel`), so attribution needs no new
event field. A run dispatched from this conversation still appears; a scheduler
or older run without attribution does not, because it cannot be claimed as this
conversation's work. The explicit `search_history` tool keeps its `all` scope,
so cross-task recall remains a deliberate action rather than ambient context.

**What it costs.** A turn in a conversation can no longer learn from the
briefing that another task's run finished ten minutes ago, so it may repeat a
dispatch made elsewhere. That is the intended trade: automatic continuation no
longer crosses conversations. Runs created before this change (or by the
scheduler) carry no conversation and drop out of the per-turn list; the Settings
API still shows the app-wide text.

**Alternatives rejected.**

- *Keep the app-wide list and label other tasks.* The owner asked for
  conversation granularity; a label still presents other runs as candidates.
- *Scope `search_history` to the conversation by default.* Deliberate cross-task
  recall is a separate, owner-invoked feature; the fix is the automatic
  briefing, not the explicit tool.
- *Drop recent work entirely.* A run this conversation dispatched ten minutes
  ago is why the agent does not ask whether to start it again.

**Evidence.** `renderRecentWork` read every terminal run in the last 24h with no
conversation filter (`src/main-agent/situation-briefing.ts`). 15 of the 39
triggers in the live journal carry a `conversationId` (12 main conversation, 3
one task); the rest predate the field or come from the scheduler. A ten-sample
cross-conversation benchmark (`cross-conversation-continuation`) seeded a
completed run from another conversation with a near-identical title. The
mechanism changed as intended: the other run was in the system prompt in 10/10
app-wide samples and 0/10 conversation-scoped samples. No sample in either
condition mentioned the other run, so the feared cross-talk is a design
rationale, not an observed failure at n=10. Cost did separate: median 77,119.5
tokens / 71.5 s app-wide against 36,597 / 17.4 s scoped. The before/after runs
are in `docs/engineering/optimizations.md`.

**Reversal condition.** If the scoped list hides work the owner expects the twin
to remember — for example the twin repeats a dispatch made from another
conversation — widen it to a separately labelled "other tasks" section that
explicitly may not be continued; or if owners work almost entirely in one
conversation, pass no `conversationId` and keep the app-wide list.

## 2026-11-25 — Learned folders load on use, not in every turn

**Decision.** The per-turn Main Agent briefing stops carrying the learned-folder
block; the folders are fetched when a request needs them. `compileBriefing`
gains `includeFolders` (default `true`) that gates only the rendered folder
text — `Briefing.folders` is always computed. `compileMainAgentPrompt` passes
`false`. `get_situation` keeps returning the block and gains a `foldersOnly`
mode that skips connector reads and the rest of the briefing, so a folder lookup
neither sweeps connectors nor appends `observation.recorded` events; its
description now names the folders. `read_file`, `recent_file_changes` and
`daily_workspace_digest` keep learning and reporting folders at use time. The
Settings card still reads `briefing.folders`; its caption changes from "carried
every turn" to "read on demand".

**Decision input.** The owner read the Settings card and asked why the folders
ride along every turn when they are only needed on the turns that touch them;
they asked for the Main Agent to judge per query. This entry intentionally
supersedes the 2026-11-19 clause that "the situation briefing carries it every
turn" — without claiming its reversal condition was met: the briefing is not
too large (the folder block is 246 characters, while the recent-work block is
836 of the briefing's 1,172). It also differs from the alternative rejected on
2026-11-24 ("Remove known folders entirely"): the folders are still learned,
still rendered by `renderKnownFolders`, still shown on the Settings card, and
still reachable through four tools. What changes is delivery, not memory.

**Why it is safe.** On the owner's own clone home, 10 of the 35 turns that have
a prompt snapshot carried the block, and 9 of those requests named no folder or
path — present but unused in 90% of the turns that had it. The information is
not exclusive to the briefing: `read_file` resolves a bare name inside learned
folders and prints up to 8 searched roots on a miss; `recent_file_changes` and
`daily_workspace_digest` print `Folder: … — learned from N past request(s)`
when called without a path; all three descriptions (static, sent every turn)
already say "no path = the folders learned from past requests". Nothing in
planning, dispatch or authority reads the list: a worker's workspace comes from
clone-home configuration. Whether the model actually reaches for the on-demand
path is the behavior this change must measure, not assume.

**What it costs.** Before any tool call the model can no longer enumerate
candidate folders or turn "current workspace" into concrete choices. The hard
case is a continuation turn whose current text names no place ("继续，把刚才那个
弄完"): `extractFolders` returns nothing for it, and the path may appear nowhere
in the history, so the model must call `get_situation` or ask. One extra model
call on a folder turn re-sends the whole prompt (the sampled cells billed
7.7k–21k input tokens per call) against 62–79 tokens saved — this is not a token
or cache optimization. Tool results are not journaled in detail
(`agent.tool_started` keeps only the input summary), so after removal the prompt
snapshot no longer shows which folders the model received; this entry accepts
that audit loss rather than copying the list onto every turn record.

**Alternatives rejected.**

- *Keep the block every turn.* It is the only knowledge injected
  unconditionally that three tools already provide at use time.
- *Inject only when the query looks file-shaped.* The heuristic is wrong in both
  directions: "总结这份文档" needs no folder, while "整理今天的工作" needs one
  without naming it — and the tools already answer the second case.
- *Add a `list_known_folders` tool now.* Three descriptions already advertise the
  on-demand route; a fourth static schema buys nothing until "where do you know
  me to work" becomes a measured, frequent question.
- *Remove learned folders or make them a setting.* Still rejected: folders are
  learned from use, never configured (2026-11-18, 2026-11-24).

**Evidence.** `~/.clone/prompt-snapshots/13d8….json` (2026-11-25T02:07:48Z)
carries the two-line block; 9 of 30 snapshots have it and only 4 distinct
folder-line sets exist, so it is stable rather than churn. The 35/10/9 counts
come from joining `prompt-snapshot` files to `main_agent.turn_started` events by
`promptMaterialHash`. The code audit found six `knownOwnerFolders` call sites,
none in planning, dispatch or authority. Three benchmark cells
(`learned-folder-read`, `learned-folder-trivial`, `learned-folder-continuation`)
seed a learned folder and measure resolution, non-use on a trivial turn, and the
continuation case; the before/after runs are recorded in
`docs/engineering/optimizations.md`. All three passed 3/3 before and after. In
the continuation cell every after-sample called `get_situation` first (none did
before). A ten-sample rerun shows the three-sample cost figure was not
representative: 6 of 10 samples answered with no run at 27k–58k tokens, while 4
dispatched two runs at 94k–123k (median 47,405 tokens against 26,485 across the
three before-samples; median duration 24.8 s against 14.3 s, p90 106 s). The
read and trivial cells were unchanged (±1%). The finding is the spread, not a
fixed multiplier: an ambiguous "继续" sometimes completes the work and sometimes
does not. Recorded here, not counted as a gain.

**Reversal condition.** If any of the three benchmark cells regresses; or a
place-referring turn ends in an open-ended question more than 3 times in 30; or
the owner reports the twin asking for a folder it already knows → set
`prompt.ts` back to `includeFolders: true` (one line) and keep the
`foldersOnly` improvement. If only the continuation cell fails, add the
deterministic continuation trigger before considering a full revert.

## 2026-11-25 — A message carries twenty attachments, not four

**Decision.** Raise the per-message attachment cap from 4 to 20 in both the
composer (`apps/desktop/ui/app.js`) and the server parser
(`src/main-agent/attachments.ts`). Nothing else changes: per-file limits (5 MB
image/video, 10 MB PDF/.docx, 50,000 characters per document, 100,000 across
documents), the 60,000,000-character request body, and extraction behavior stay.
A selection over the cap still names the limit and drops the extra files.

**Evidence and alternatives.** The owner selected six requirement documents
(`toolbox-20261125-*.md`/`.sql`) and the composer kept four — the first four in
picker order — while the other two vanished behind a 3.2-second toast. The
four-file cap was ours, not a platform bound. The Claude apps cap one message at
20 attachments (Claude Code changelog v2.1.287 and v2.1.311 describe the
20-attachment app path; claude.ai documents up to 20 files per chat, and the
vision docs state 20 images per turn), while the CLI itself documents no count
and is bounded by its 32 MB request guard. Twenty therefore matches the
mainstream path the owner compares against without inventing a new ceiling: the
60M-character body remains the byte bound for large mixes, and the
100,000-character document budget remains the context bound.

- *Keep four.* Rejected: it drops files the owner selected for no reason the
  owner chose, and no mainstream composer behaves that way.
- *Remove the count cap entirely (CLI parity).* Rejected: the CLI's real bound is
  request size; without a count, a 50-file selection is queued and only fails at
  send against the 60M-character body. The 20-file bound is visible and cheap.
- *Use the API's 100-image (200k-context) or 600-image request ceilings.*
  Rejected: those are protocol ceilings, not the app path the owner uses; 100
  attachments hit the request body long before they are accepted.

**Reversal condition.** If owners routinely need more than 20 small files, or if
max-size mixes start failing at the 60M-character body, add a client-side
total-bytes budget and revisit the count.

## 2026-11-25 — Keep one implementation for turn intake and memory completion

**Decision.** Use one Main Agent HTTP intake and execution path while keeping
SSE delivery and JSON retry replay distinct. Reuse the existing tool-free
completion for memory mining. Remove the retired JSON memory store and its
unused path field; leave historical `memory.json` data, migration and the
explicit HTTP 410 response alone.

**Evidence and alternatives.** The two turn handlers repeat validation,
attachment handling, cancellation and cleanup. Mining repeats the same
provider exchange. The 221-line JSON store is imported only by its own tests;
production uses governed Markdown memory. Keeping duplicate implementations
risks drift, but removing either HTTP endpoint or migrating old files would
change a client or data contract for no maintenance benefit.

**Reversal condition.** If a supported consumer still needs the JSON store,
restore it as an explicit compatibility adapter. Split only the transport
branches if their lifecycle requirements diverge; keep shared input policy and
endpoint defaults in one place.

## 2026-11-25 — A pasted file is attached; its path is the fallback

**Decision.** A file copied in Finder and pasted into the composer becomes an
attachment chip, like a dropped file and like Claude Code desktop, instead of
raw path text. The native shell reads the file URLs currently on the
`NSPasteboard` (it accepts no path list from page JavaScript), base64-encodes
each regular file up to 12 MB and 24 MB per paste, and hands the page
`{name, path, size, mimeType, data}`. The page rebuilds `File` objects and runs
them through the existing attachment pipeline (text, PDF/.docx/.doc, images,
the four-attachment and character caps). If a file cannot be turned into an
attachment — too large, unsupported, or no native bridge — its absolute path is
inserted as text instead, so the Main Agent can still open it with `read_file`.
This supersedes the path-first behavior of the earlier 2026-11-25 entry.

**Why it won.** The owner used the path behavior and then asked for the Claude
Code desktop gesture: copy files and paste them as files. A path is raw text in
the message and makes the agent spend a read call per file even though the
attachment pipeline already carries the content. Attaching is the same gesture
the owner already uses for screenshots and drops; the path remains available as
the graceful fallback for the cases attachments cannot carry.

**Alternatives rejected.**

- *Keep path-only.* The owner's explicit follow-up rejects it: the file should
  arrive as a file, not as text, and the agent should not have to re-read it.
- *Attach-only, no path fallback.* A 60 MB log or an unsupported binary would
  disappear from the turn; the path is the only address `read_file` can use.
- *Send the path to the server and let it read the file.* The attachment parser
  deliberately forbids path-bearing clients: any local or remote caller could
  turn it into an arbitrary-file read. The shell reads only the current
  pasteboard, and the bytes still pass the same attachment validation.
- *Expose a generic native `readFile(path)` to the page.* That is a
  read-any-file primitive from page JavaScript; restricting the read to the
  pasteboard's own file URLs keeps the surface to what the owner copied.

**Evidence.** The owner confirmed the path insertion worked, then asked
"最好像claude code desktop这样直接把文件复制上去". The existing attachment pipeline
already handles text, PDF/.docx/.doc and images with caps; the only missing
piece was bytes for a pasted file. The native clipboard bridge added earlier in
this same day already reads the pasteboard's file URLs for the path cache, so
the same allowlist can supply the bytes. After the change the owner copied
files in Finder and pasted them into the rebuilt app; the composer showed
attachment chips.

**What it costs.** A paste can move up to 24 MB of base64 through the WebView;
the caps bound it, and a file over them falls back to a path. The read is
asynchronous, so the chip appears after the native read instead of instantly;
a failed read inserts the paths. The attachment caps still apply: a 60,000-
character document becomes a path, not a full attachment.

**Reversal condition.** If a large paste makes the app hang or the WebView
memory spike, lower the per-paste cap and make path insertion the default over
a threshold; keep the native reader and the attachment path for small files.
If the owner prefers raw paths again, keep the reader but insert paths instead
of attaching.

## 2026-11-25 — Automatic checks decide completion; prose criteria are not a review

**Decision.** `EvidenceVerifier` passes any step that recorded evidence and
failed no mechanical check (a named file exists/contains what was promised; an
external/irreversible step has a receipt with a locator). Prose acceptance
criteria are no longer listed as unverified and no longer settle the run as
`waiting_review`. This applies to read-only, write and external steps alike.
A missing named file, a missing receipt or no evidence still fails. The
artifact-contract judge is unchanged: AI decides; if it says REVIEW, the owner
still sees that card.

**Why it won.** The owner asked "连结论都要接受嘛…默认接受 worker 的结论…不要人工
介入太多", then chose "也默认接受" when asked whether write/external reviews
should be trusted too. The verifier's review gate was a human decision about
prose the machine could not check; the worker had already answered and the
evidence existed. Keeping it made a read look like a permission request and
left a review card for every conclusion.

**Alternatives rejected.**

- *Keep the review for write/external only.* The owner chose default accept
  for those as well; a write with a named missing file still fails mechanically.
- *Ask a model judge for each prose criterion.* Adds a call per criterion and
  re-asks the answer the worker already wrote; the artifact judge remains for
  artifacts, not for prose.
- *Remove the mechanical checks too.* A named file that does not exist or an
  external action without a receipt is evidence, not a judgment; those stay
  failures.
- *Auto-accept the artifact-contract REVIEW.* That needs a separate decision:
  the judge's ACCEPT/REVIEW is AI judgment; a REVIEW is the AI saying it cannot
  decide, and the owner remains the last authority.

**Evidence.** Live run `d36bb093` completed with a read-only answer and 15
evidence items but settled `waiting_review` on "1 of 1 acceptance criteria
still need the owner's review"; the owner called it abnormal. `test/verification.test.ts`
now pins write/read-only steps with evidence as passed, missing named files as
failed, and external missing receipts as failed. Gate verdict cases
`unverified-criteria-needs-review` and `partially-checkable-criteria-needs-review`
flip to pass; the baseline is regenerated with the intended diff, and the
artifact-review tests keep their review path.

**What it costs.** A write step with no named file and an evidence row completes
even if its prose claim is wrong; the owner sees a completed result. Named
files and receipts are the remaining mechanical guarantees. Reviews remain only
for artifact-contract gaps the AI judge cannot decide.

**Reversal condition.** If an unreviewed write or answer is wrong in a way the
owner would have caught, restore the prose review for that class (write first,
then read-only) or add a mechanical check (a citation/test/file). Keep the
named-file and receipt checks unchanged.

## 2026-11-25 — The Main Agent asks the owner with buttons, not prose

**Decision.** The Main Agent gets a blocking `ask_owner` tool: a short question,
2–4 concrete choices, and an optional free-text "Other". The tool call does not
return until the owner answers. The question appears in the chat's sticky
decision dock with one button per choice; a click resolves the tool call and the
same turn continues with the choice as the tool result. The broker is
process-wide in the daemon (the answer route and the waiting tool must meet in
one place), the dashboard exposes pending questions next to approvals and
reviews, the turn's abort signal cancels the wait, and a 30-minute timeout
prevents a turn from hanging forever. The tool is registered only when a broker
is present, and the charter (version 14) tells the model to use it instead of
writing a blocking question in prose — one decision per call.

**Why it won.** The owner asked for Codex/Claude Code-style confirmations. The
screenshot showed the model asking "要我派这个任务吗？" as prose: the owner had to
type a reply, and the choice's shape lived only in the model's text. A tool call
is the only structured place to attach choices, a click, and a resumable answer.

**Alternatives rejected.**

- *Parse the model's prose and guess buttons.* There is no reliable list of
  choices, and a wrong button is worse than no button; the model's wording
  changes every turn.
- *Reuse the run approval flow.* An approval belongs to a run step and an
  autonomy decision; the model's question is conversational and often precedes
  a run. Mixing them would make every question look like an authorization.
- *A separate question page or modal.* The owner explicitly rejected page jumps
  and modals that can be dismissed by clicking elsewhere; the dock is already
  the decision surface.
- *A non-blocking question that the model polls later.* The model would end its
  turn without the answer, and the next turn would have to reconstruct why the
  question was asked.

**Deferred.** Rendering questions in the WhatsApp/mobile channel (the desktop
dock can answer; the 30-minute timeout prevents a permanent hang), persisting a
question across a daemon restart (the turn dies with the daemon, so a persisted
question would have no consumer), and multi-question or multi-select prompts
(one decision per call keeps the card and the tool result unambiguous).

**Reversal conditions.** If the model overuses the tool for confirmations it
already has, restrict it to dispatch-shape decisions or add a "don't ask" rule
from the owner. If a remote client needs questions, add an answer channel there
and keep the broker as the one source. If the 30-minute timeout proves wrong in
either direction, change it at the broker, not per tool call.

## 2026-11-25 — Pending decisions are docked in every conversation, not only on the task page that owns the run

**Decision.** The conversation's sticky decision dock now shows the selected
session's own approvals and reviews **plus every other task's pending approvals
and reviews**, deduplicated by run id, with the task title, scopes, judge reason
and the worker's result. Approve/reject work from that card through the same run
id the task page uses. The dashboard gained a top-level `reviews` array next to
its existing global `approvals`, and both refresh with the normal three-second
dashboard poll. A decision is answerable from any conversation; the task record
remains the place to read the full history.

**Why it won.** The owner reported that when a decision was needed while the app
was behind another app, clicking into the app made the confirmation disappear;
they could not screenshot it, and they did not want to jump to a separate page
for every conversation. The transient part was the macOS notification:
`osascript display notification` is a banner, and `showExistingWindow` only
activates the app. The durable UI was the approval card, but the app only
rendered `session.approvals` for the selected session and ignored the
dashboard's already-computed global approvals. So a decision owned by another
task record had no visible prompt in the chat at all.

**Alternatives rejected.**

- *Notification only.* It is dismissed by the very click that brings the app
  forward; a decision cannot depend on a banner.
- *A separate approvals inbox page.* The owner explicitly rejected another page
  jump; the chat is already the control surface.
- *Show global decisions only in the main conversation.* The owner may be
  reading a task conversation when the decision arrives; the dock follows the
  conversation they are in.
- *Keep the in-flow cards and add a second global card everywhere.* That would
  render the same decision twice. The dock already owns the decision surface;
  the global card filters the selected session's run ids out.

**Deferred.** A global badge outside the conversation (native tabs or the
settings page): the dock is in the chat by the owner's request. If decisions are
still missed while the settings page is open, add a top-level bar rather than
another notification.

**Reversal conditions.** If the dock becomes noisy on long task lists, restrict
it to the main conversation or add a collapse; if a true global inbox is built,
point the dock at it instead of duplicating the data. If a later notification
system gains a click action that lands on the decision, the dock can stay but
the notification may become the primary hint again.

## 2026-11-25 — MCP installs resolve the runtime's own Node; skills get a built-in market and reach the Main Agent; every entry is a jump

**Decision.** Three connected changes:

1. `npx` for MCP installs is resolved from the Node running the daemon
   (`dirname(process.execPath)/npx`, then the usual package-manager locations,
   then bare `npx`), and every MCP child process gets that Node's directory at
   the front of `PATH`. The resolved absolute command is stored in `mcp.json`,
   so later worker runs do not depend on the launching shell either.
2. The settings page ships a built-in skill market: weekly review, document
   review, release notes and deliverable check, authored with this repository.
   Installing writes one `SKILL.md` under `<clone home>/skills/<name>/`;
   removing deletes only a direct, non-symlink child of that root. Every Main
   Agent turn now receives `skillRootsFor(...)`, so the listing reaches the
   system prompt and each skill becomes a `Skill(name)` tool whose invocation
   returns the body. Skill rows and market entries open detail pages that render
   the Markdown body.
3. The tools page is two categories, MCP and skills. Every server and every
   skill is one jump row; no tool body is printed inline, even for a one-tool
   server. A back stack keeps the list's reading position. The MCP market and
   the skill market are jumped pages reached from each category header.

**Why it won.** The owner reported that MCP still could not download and that
skills should also be downloadable and usable. Diagnosis of the running app:
the UI is served from disk in dev mode, so the new market was visible, but the
resident daemon predated the new routes (`/api/tools/registry` returned 404),
and its launchd environment had `PATH=/usr/bin:/bin:/usr/sbin:/sbin`; a live
probe returned `MCP server probe spawn npx ENOENT.` The real npx lives next to
the daemon's Node (`/opt/homebrew/Cellar/node/26.8.1/bin/npx`), and its
`#!/usr/bin/env node` needs that directory on `PATH` too. After the fix the same
live probe listed the ten filesystem tools in 0.6 s. The skill listing and
`Skill` tool mechanism already existed in the native runtime, but no caller
passed `skillRoots`, so no skill could reach a turn; the new call fixes that,
and `test/skill-runtime.test.ts` proves both the listing and the body arrive.

**Alternatives rejected.**

- *Rely on the owner's `PATH`.* launchd does not have Homebrew's directory, and
  a Finder launch does not either; that is the observed failure.
- *Edit the LaunchAgent plist to add `PATH`.* It fixes one installation, not a
  packaged app or a `desktop:dev` sidecar.
- *Bundle npx now.* Deferred until the app ships Node for every user; resolving
  the runtime's own Node covers every current launch mode.
- *Download skills from a remote registry.* There is no trust model yet — who
  signs an entry, what may change between versions. The built-in market is
  reviewable and offline; the entry shape leaves room for a source URL.
- *Keep inline tool lists for small servers.* The owner explicitly asked that
  even small content be a jump.
- *Tabs instead of a back stack.* More chrome for two categories; the stack also
  gives the market-entry page a correct parent.

**Deferred, with reasons.** MCP servers that need API keys (GitHub, Brave,
Notion, Slack): the install form still has no write-only secret input, and
adding one is its own review surface. Remote skills: the same trust decision as
above. A larger MCP catalog: the five keyless servers are the ones the current
flow can install end to end; adding entries is a data edit once keyed servers
are supported.

**Reversal conditions.** Return to `PATH`-only resolution if the app always
ships its own Node/npx and guarantees the runtime's bin directory. Add remote
skills when a signed registry (or a pinned-commit source) exists and the owner
accepts fetching from it. Add keyed MCP entries once the form has write-only
secret fields. Restore inline lists if the extra jump slows routine checks.

## 2026-11-25 — The MCP marketplace is curated and pinned; tools read as a summary and jump to a detail page

**Decision.** The tools settings section gains an MCP marketplace instead of
only a blank install form. The marketplace is a registry shipped in the repo
(`src/mcp/mcp-registry.ts`): five reviewed npm servers, each with a fixed
version, a bilingual summary, search tags and typed install inputs (a directory,
a read-only switch). The client sends only the entry id and input values; the
server resolves the package spec, argv and env from the registry, so a
marketplace install cannot be pointed at an arbitrary package. Installation
keeps the existing safety chain: probe (`tools/list`), a risk chosen by the
owner for every tool, explicit confirmation, re-probe, atomic write. Entries
that need somewhere to keep data declare it: `memory` gets
`MEMORY_FILE_PATH={dataDir}/mcp-memory.jsonl`, because the server's default file
lives inside the npx cache and is deleted on update. `chrome-devtools` is
installed with `--no-usage-statistics`, because Google's server reports usage by
default. The filesystem entry offers `--read-only` switched on. The manual
npm-package form stays, collapsed below the marketplace.

The tools list also changes shape. A server with three or fewer tools lists
them inline; more than three shows a jump ("查看全部 N 个工具") to a server
detail page. A tool's `description` is parsed: the `Args: {...}` fragment
becomes a parameter table (name, type, required, default) and the text around it
becomes a plain summary. A description without an `Args` block is shown as
written. The shared formatter (`tool-format.js`) gains
`describeTool`/`paramsFromSchema`, so the same parsing serves the installation
preview.

**Why it won.** The owner reported that the blank "服务器 ID / npm 包 / 参数"
card was incomprehensible ("长这样是干啥"), the raw `Args: {...}` sentences
looked odd, and expanding every tool inline was cluttered. The screenshot shows
two enabled servers with 7 and 10 tools fully expanded. The registry's packages
and versions were checked with `npm view` on 2026-11-25:
`@modelcontextprotocol/server-filesystem@2.4.0`,
`@modelcontextprotocol/server-memory@2.2.1`,
`@modelcontextprotocol/server-sequential-thinking@2.2.0`,
`@playwright/mcp@0.0.86`, `chrome-devtools-mcp@1.14.0`. Their readmes document
the `--read-only` switch, the `MEMORY_FILE_PATH` default inside the server's own
directory, and chrome-devtools' usage-statistics default.

**Alternatives rejected.**

- *Live npm registry search instead of a curated list.* Results are unvetted,
  include non-MCP packages and typosquats, and would still need pins. It also
  sends the owner's keystrokes to a third party, while the install path talks to
  npm only after the owner starts an install. The npm search endpoint ranks by
  text, not by MCP compliance.
- *Keep the free-text form as the only path.* It requires the owner to know a
  package name and its argv — the confusion in the report. Its placeholder was
  also wrong for current filesystem versions (`--root` instead of positional
  directories).
- *Prefill the generic form on the client from a registry entry.* It cannot put
  `MEMORY_FILE_PATH` in the data directory, and it would let a client alter the
  package spec. Resolving on the server keeps package, argv and env from the
  reviewed entry.
- *Persist each tool's `inputSchema` in `mcp.json` at install.* The schema is
  available during the probe, but `mcp.json` is the owner's document and the
  catalog deliberately reads declarations only. The servers this app ships
  already carry `Args:` in their descriptions, so parsing covers existing
  entries without a contract change.
- *Include servers that need API keys now (GitHub, Brave, Notion, Slack).* The
  install API and form have no env input, and adding secret fields is its own
  review surface. Deferred, not rejected.

**Deferred.** Archived servers (puppeteer) because Playwright supersedes them;
the "everything" reference server because it exposes environment and sampling
features this client does not support.

**Reversal conditions.** Replace the curated registry with live search once a
maintained MCP registry API offers a review signal and the owner accepts sending
queries to it. Add key-bearing servers once the install form has write-only
secret inputs (the registry model already allows fixed `env` values). Persist
`inputSchema` if installed third-party tools routinely have no `Args:` in their
descriptions, leaving the detail page uninformative. Return to inline lists if
the extra jump slows routine checks.

**Eval.** `test/mcp-registry.test.ts` (data, search, argv/env resolution),
additions to `test/mcp-installer.test.ts` (env write), `test/tool-format.test.ts`
(`Args:` parsing), `test/tools-install-api.test.ts` (registry routes), and
`test/ui-structure.test.ts` (jump threshold, detail page, market markup).
Before/after numbers are in the optimization log.

## 2026-11-25 — The Main Agent reads named files itself, in bounded windows

**Decision.** The Main Agent gets a read-only `read_file` tool. It accepts an
absolute path, a `~/` path, a path relative to the workspace (when the
workspace is a real folder, never the machine root), or a bare file name. A
bare name is resolved in this order: a direct hit under the workspace or a
learned folder, an exact-name Spotlight query (`mdfind -name`), then a bounded
directory walk with skipped noise folders, a depth cap and an entry/time budget.
Several matches return candidates with sizes and mtimes instead of a guess. A
single text file is returned in line windows (`offset`, `limit`, ~7,000
characters by default) with an explicit "continue at offset N" footer, so a file
larger than the context is read in several calls rather than truncated silently.
PDF, `.docx` and `.doc` are extracted through the existing attachment extractor;
a directory returns a bounded entry list; protected locations (credentials,
browser profiles, the clone home) are refused before any read. The prompt's
machine guidance no longer says "You have no filesystem tool of your own": it
tells the agent to call `read_file` for a named file and never to ask the owner
to paste contents it can open. On the desktop, pasting files copied in Finder
now inserts their absolute paths instead of the browser's filename-only text; a
bitmap screenshot still attaches as an image.

**Why it won.** The owner pasted three document names and asked for the work;
the Main Agent answered "paste the contents to me" because it had no read tool,
and the prior turn's read attempt had failed with "the external execution agent
is closed". A read needs no scope and must not depend on an executor being
enabled. The same turn also showed why names cannot be the interface: WebKit's
default paste inserted only `toolbox-….md`, which does not address a file.

**Alternatives rejected.**

- *Keep asking the owner to paste contents.* It loses the file's address, is
  capped at 2 MB/50,000 characters per document, and cannot read a large file at
  all — the exact complaint ("读文件读大文件的能力是要有的").
- *Dispatch a read-only worker step for every read.* This is the behavior that
  failed in the reported turn when the external lane was off; it also turns a
  scope-free read into a Run with a plan, a queue and a verification.
- *Index the learned folders into a cache.* `~/work` alone holds 727,840 files
  and 142,127 directories within depth 8; building and invalidating that index
  costs more than the query it replaces, while Spotlight answered the exact name
  in 0.09 s.
- *Resolve only inside known folders.* A newly named project is not learned yet;
  Spotlight is what makes the first request work, before any memory exists.
- *Attach file contents only.* The 2 MB/50,000-character caps reject large
  documents, and the agent cannot re-read or cite the source later; a path keeps
  the source addressable.
- *Insert only file names in the composer.* That is the reported defect: a bare
  name is ambiguous and the agent cannot address the file.

**Evidence.** The live turn `d883d9d2-0240-4ede-9dd1-6e98397481a7`
(2026-11-25T02:07:48Z) has text "toolbox-20261125-delivery-plan.md /
toolbox-20261125-upload-handoff.md / toolbox-slim-scope.md / 这是toolbox今天要开发的
内容文档，你来开发"; its reply asks the owner to paste the documents, and the
turn card shows a failed attempt whose reason is "外部执行 Agent 已关闭". The three
files exist at `/Users/user/work/doc_translate/docs/`; `mdfind -name
toolbox-20261125-delivery-plan.md` returned the path in 0.09 s. Learned folders
currently include `/Users/user/work` (12 requests) and
`/Users/user/Documents/Clone AI` (5). `machineGuidance()` in
`src/main-agent/prompt.ts` contains the "no filesystem tool" line, and
`clipboardAttachmentFiles()` in `apps/desktop/ui/app.js` keeps only image files,
so a non-image clipboard file falls through to the default paste. The full run
and its benchmark are recorded in `docs/engineering/optimizations.md`.

**What it costs.** The Main Agent gains read reach over any readable location
except protected roots — the same reach the prompt already grants workers
("a worker may read any readable location … except protected locations"). A
prompt injection could try to make it read unrelated files; the tool returns
data with no instruction authority, protected roots are refused, and every call
is recorded in the turn audit. The ~7,000-character window means a large file
takes several calls. Spotlight may be disabled or incomplete; the bounded walk
then may miss a deep file, and the tool says where it looked. The composer shows
long absolute paths instead of short names when files are pasted.

**Reversal condition.** If a prompt-injection incident uses `read_file` to reach
unrelated personal files, restrict resolution to the workspace and learned
folders (no Spotlight/global search) or require owner approval per path; keep
the windowing and the prompt rule. If inserting paths proves noisier than
attachments, keep the tool and revert the paste behavior to attachment-first.

## 2026-11-25 — The audit turn names its tools and opens one tool page; replies are Markdown

**Decision.** In 设置 → 审计与轨迹 → 主 Agent 回合, a turn card no longer
prints every tool call with its labeled input. It keeps one line — call count,
distinct tools, failures and total duration — and one `查看工具调用 ›` jump per
turn. The jump opens a tool page for that turn: tools grouped by name with
counts, failures and summed duration, then the calls in order with each input
behind its own toggle. The turn reply and the Agent 调用 detail reply render as
Markdown through the conversation's escaping renderer
(`window.cloneMarkdownForPreview`), with the recorded text as the fallback.

**Alternatives rejected.**

- *Keep the inline tool list.* The owner's screenshot of 2026-11-25 shows the
  cost: every card carries a wall of per-call inputs, so the turns cannot be
  scanned as a list. The inputs are still reachable on the tool page and still
  searchable through the turn search.
- *Collapse the inline list with a `<details>` on the card.* It removes height
  but not the detail: every card still carries every call, and there is no
  stable address for "this turn's tools" that a later view or link can target.
  The jump gives one address per turn.
- *Write an audit-only Markdown renderer.* The conversation already escapes
  first, renders inline code, bold, headings, lists, tables and fenced blocks,
  and exports table CSV. A second renderer would drift and multiply the
  escaping surface; reuse is the smaller risk.
- *Leave replies as `<pre>` text.* The model writes Markdown; the screenshot
  shows literal `**运行 ID:**` and backticks, which reads as a raw transcript
  rather than an answer. `<pre>` also loses headings, lists and tables that
  make a long reply legible.

**Evidence.** Owner report and screenshot, 2026-11-25: the audit turn card lists
each tool call with `au-tool-fields` input detail and shows the reply as raw
Markdown. The new cases in `test/ui-structure.test.ts` fail against the old
rendering — the card contains `au-turn-tools` rows and the reply is a `<pre>` —
and pass after the change: the card has exactly one `data-au-turn-tools` jump,
the tool page renders the same call with its readable input, and the reply
passes through the shared renderer.

**What it costs.** Reading a call's input takes one more click. The tool page is
not independently searchable, but it is built from the turn already loaded and
the turn search still matches tool names and inputs. Markdown rendering depends
on script order (`app.js` before `audit.js`); the fallback keeps the recorded
text readable if that ever changes.

**Reversal condition.** If the owner repeatedly opens the tool page just to
learn which tools a turn used, put a compact tool-name list back on the card
(no inputs). If the shared renderer is replaced or moved, keep the
`window.cloneMarkdownForPreview` contract and update the structural test with
it; do not fork a second renderer.

## 2026-11-25 — A read-only step with evidence passes without an owner review

**Decision.** `EvidenceVerifier` no longer queues a `read_only` step's prose
criteria for owner review. A read-only step passes when it recorded evidence,
every machine-checkable file expectation passed, and no receipt rule failed.
Its subjective acceptance criteria ("answered with evidence", "content is
accurate") are not listed as unverified. A failed file check, a missing receipt
or no evidence still fails. The verification summary then reads as passed,
and the run completes without `waiting_review`.

**Why it won.** The owner asked why reading `doc_translate` needed
"authorization". It did not: the run was auto-allowed, read the files and
answered; the only thing that stopped it was the verifier listing
"只读取所需内容并给出有依据的回答" as unverifiable prose, which settled the run
as `waiting_review`. A read-only step has no artifact to open; keeping its self-
reported answer behind a review makes every read look like a permission request.

**Alternatives rejected.**

- *Keep the review for every read-only answer.* This is the behavior the owner
  reported as abnormal; it turns a trust decision into a click.
- *Ask a model judge for each prose criterion.* The artifact judge and the
  policy judge already exist; adding a third per-criterion call adds latency
  and cost, and for a read-only answer it is exactly the answer the model
  wrote.
- *Trust only observation evidence.* A read-only step may also record a
  test/tool_result; the rule is about the step's risk and mechanical checks,
  not the evidence kind.
- *Remove all review.* Writes, external/irreversible receipts and artifact
  contracts keep their review; only the prose criterion of a read-only step is
  trusted.

**Evidence.** Live run `d36bb093` was allowed, read the doc_translate files,
recorded 15 evidence items and answered; its verification said "Automatic
checks passed; 1 of 1 acceptance criteria still need the owner's review" and
settled as `waiting_review`. `test/verification.test.ts` cases at the read-only
briefing and the gate case `unverified-criteria-needs-review` pinned the old
behavior; the new case asserts a read-only step with evidence and a prose
criterion passes, while a read-only step with a missing file still fails. The
gate baseline is regenerated with the intentional verdict change; the log records
before/after.

**What it costs.** A read-only answer is accepted on its own evidence even if
the prose is wrong; the owner sees it as a completed result, not a review. A
read-only step that names a file still gets that file opened, and a write/external
step still needs its artifact/receipt/review. The verifier's summary no longer
counts read-only prose criteria, so `reviewableCriteria` is smaller.

**Reversal condition.** If a read-only answer is accepted with a hallucination
that the owner would have caught in review, restore the review for read-only
steps or require a citation check (the evidence locators are already recorded).
Keep the mechanical checks and the write/external review unchanged.

## 2026-11-25 — The main conversation carries the review of its own runs; old subagents leave the card

**Decision.** `buildMainAgentConversation` no longer returns empty `approvals`
and `reviews`. It aggregates the decisions of the runs derived to that
conversation: a `waiting_approval` run becomes an approval entry with its
scopes and reason, and a `waiting_review` run becomes a review entry with its
verification, criteria and the last durable result. The Agent 协作 card filters
subagents to the latest turn's spawned runs plus any run still active or
waiting, so a failed subagent from a previous day is not shown as current work.
`request_approval` reports `waiting_review` as a review the owner settles in
the task record — never as an approval or an authorization.

**Why it won.** The owner clicked 继续 on a summary. The run finished at 23:56
with a full read-only review, settled as `waiting_review`, but the main
conversation showed only the Main Agent's note "卡在权限审核，需要你批准" and an
agent card containing an 8-day-old failed subagent. The dashboard said
`waiting_review` while the conversation payload said `completed` and
`reviews: []`; the content was only in the task record. A decision that exists
but is invisible is a decision missed.

**Alternatives rejected.**

- *Keep decisions only in the task record.* That is the behavior the owner just
  reported as "内容不见了"; it forces a navigation to find the result.
- *Show a link instead of the review.* The result and criteria are the decision;
  a link alone still hides them.
- *Keep all visible subagents in the card.* It is how an old failure keeps
  claiming "需要处理" long after its task record was read.
- *Relabel `waiting_review` as approval.* The owner cannot approve evidence;
  they accept or reject it.

**Evidence.** Run `d36bb093` is `waiting_review` with
`verification.needsReview` and a 15-evidence read-only review; the main
conversation payload had `status: completed`, `reviews: []`, while the
dashboard status was `waiting_review`; `subagents` contained
`cd74804b` (2026-11-18). The main conversation's last message called the review
"权限审核". The new `test/main-conversation-approvals.test.ts` case pins a
waiting review with its result; `test/ui-structure.test.ts` pins the review
markup; the live API is checked after restart.

**What it costs.** The main conversation can show decisions from several child
runs at once; it is capped by the visible runs and sorted by recency, but a
wide fan-out could make the card long. Old unresolved failures move to the
sidebar/audit, not disappear.

**Reversal condition.** If the card becomes noisy, cap it to the latest turn's
runs or group older pending decisions behind a count; do not return to an empty
control surface. If owners prefer task records, make the card a one-line
pointer with the run title and a link, but keep the result available.

## 2026-11-25 — One executor; the Main Agent declares each dispatch's responsibility

**Decision.** The default roster collapses to one worker profile (`worker`, role
`general`, provider `native`) whose declared local capabilities are
`direct_response`, `research`, `review`, `drafting`, `filesystem_read` and
`filesystem_write`. `external_action` stays unsupported: the native worker
cannot perform an external side effect and there is no governed connector.
Fixed roles no longer decide who runs a task. The Main Agent assigns
responsibility per dispatch through a required `responsibility` field on
`dispatch_task`: `read` (investigate and answer; change no file) or `write`
(create or change local files). That choice builds the plan — `read` is one
`read_only` step with `research` + `filesystem_read`; `write` is one
`reversible_write` step whose single maker work order must produce a durable
artifact, so a write task that only reads and answers cannot complete. The
dispatch's `acceptanceCriteria` become the step's and order's criteria instead
of the planner's canned prose. The brief is attached as before, and
`ensureWriteScopes` still extracts write targets from it. The Kernel still
validates the risk floor, authority, scopes, protected paths and completion;
the Main Agent cannot approve or complete anything. `dispatch_task` now returns
the worker's durable final answer (bounded to 8,000 characters), the per-step
executor assignment, and the verification summary, so the Main Agent can use the
result in the same turn and cannot misreport who ran it. `propose_work_plan`
keeps its per-step `agentId` / `requiredCapabilities` / `risk` contract; with
one worker, the Main Agent assigns each step's responsibility there too.

**Alternatives rejected.**

- *Keep the four role profiles.* All four default profiles use the same
  `native` provider; the role only changes `workCapabilitiesForRole`. The split
  bought no provider separation, but it did create two answers to "who runs
  this task": the task-level router picks by intent keyword (for a read request
  it chose `direct-responder`) while `assignWorkersPerStep` assigns the step by
  capability (it chose `context-researcher`). The Main Agent reads only the
  first and told the owner the executor "cannot read files" even though the run
  had read all three. One worker removes that class of misreport; the
  per-step responsibility remains in the plan.
- *Let the Main Agent name `context-researcher` / `draft-maker` per dispatch.*
  With one provider this is a rename, and the keyword planner remains the real
  decider of read vs write. The owner asked for the opposite: the Main Agent
  states the responsibility.
- *Unify the roster but keep the keyword planner for dispatched tasks.* The
  planner classifies "优化 / 看一下 / 检查" as research without delivery and
  therefore read-only; the Main Agent's stated criteria never reach the plan —
  `dispatch_task` puts `acceptanceCriteria` in the trigger payload, and
  `runQuery` reads only `workerBrief`. Run `017c9669`'s plan carries the canned
  criterion "只读取所需内容…" while the tool call carried four concrete
  criteria. Responsibility must be explicit, not inferred from prose.
- *Give the Main Agent write or shell tools directly.* It would be both the
  requester and the executor, bypassing the Run, step risk, scopes, evidence
  and verification. The Main Agent stays the brain; the worker executes under
  the Kernel.

**Evidence.**

- `src/config/worker-settings.ts` `DEFAULT_AGENTS` has four profiles, all with
  `providerId: "native"`; `src/workers/capabilities.ts` derives their capability
  sets from `role`. The owner's `~/.clone/settings.json` still names
  `claude-code`, which `normalize()` falls back to `native` because that
  provider is gone.
- Run `017c9669` (2026-11-25T02:07:59Z): `dispatch.decided` selected
  `direct-responder` (`source: rule`, `intentKind: direct`);
  `dispatch.steps_assigned` assigned `read-only-lookup` to `context-researcher`.
  The journal recorded three `read_file` observations for the three documents,
  and the run passed after the owner accepted the review. Turn reply
  `d883d9d2…` nevertheless told the owner the executor was `direct-responder`
  and "很可能根本没有真正打开那三个 md 文件". That is the observed confusion, not
  a hypothesis.
- The same turn's `dispatch_task` call carried four acceptance criteria; the
  plan's criterion is the fallback planner's canned string. `runQuery` reads
  only `trigger.payload.workerBrief` (grep), so the criteria are dropped.
- The roster is not read-only: 2026-11-18 runs `2e8e10a8`, `4ce0db3d`,
  `709e9ab5` and `18569eb4` completed `reversible_write` steps with
  `draft-maker`. The read-only outcomes in 2026-11-24/25 came from the requests
  and briefs ("只读…"), not from a missing write-capable worker.

**What it costs.** One worker means same-model self-review: the `review` order
in a preparation group no longer buys an independent model. The owner cannot
pin a role by name; explicit selection only matters when more than one provider
exists, and none does today. Per-role enable/disable is gone: the single worker
is `required`, and an old settings file that disabled one role disables nothing.
A write dispatch gets write tools for the whole step, so a mistaken `write`
declaration widens what the worker may do within the owner's authority; the
step risk, scopes, protected paths and `.git`/`.rsi` guards still bound it, and
at `files` = allow_all an unscoped write is allowed — the same authority the
owner already granted. `dispatch_task` now returns up to 8,000 characters of
worker output to the Main Agent; that output is data, not instructions, and the
journal already redacts it. Runs that do not come from a dispatch — the
scheduler, opportunity acceptance and the legacy request API — still use the
deterministic keyword planner, because no model declares their responsibility.
The id `worker` is a common word: the deterministic intent classifier treats an
ordinary mention in a task text as an explicit selection of the only worker.
With one worker the pin no longer changes capabilities, but a negated mention
("不要用 worker") can exclude it and block the run; rename the id or require an
explicit "use X" cue if that appears in practice.

**Reversal condition.** If a second execution provider (a CLI or a remote
sandbox) is registered and the owner needs to pin it per task, reintroduce a
`providerId` on the dispatch or step — a provider binding, not a fixed role
roster — and keep per-step responsibility. If same-model review misses a class
of defect that an independent reviewer caught, add a reviewer adapter or require
a different provider for `review` orders. If a mistaken `write` responsibility
causes an unintended write at a narrower authority level, require the Main Agent
to name at least one write target for `write` and reject an unscoped write
before the plan, or remove the field and return to the deterministic planner. If
the Main Agent cannot reliably choose read vs write, make the Kernel cross-check
the brief's write cues and reject a contradiction.

## 2026-11-24 — The briefing shows learned places and history, never a request to repeat

**Decision.** `renderKnownFolders` prints only the folder path, how many requests
named it, and when it was last used. It no longer prints the remembered request
text (`KnownFolder.example`). The recent-background-work section is labelled as
history and explicitly says not to start or retry any of it unless the owner
asks. The Main Agent prompt gains the matching rule: a known folder or a
finished run is not a task, and when the owner says "current workspace" without
a path, ask which folder instead of assuming the clone home.

**Why it won.** The owner reported that "every task reads README.md" and called
it a bug. The prompt snapshots show the cause: the `~/work` known-folder line
carried `e.g. "只读取工作区根目录 … README.md …"` in every Main Agent turn for
days, and the recent-work list repeated the failed README runs. The model
treated that visible request text as context worth continuing. A failed run
also had promoted a procedure memory saying "next time read the README first"
(now archived), which reinforced it. The folder list itself is useful; the
raw example is the carrier, and it is untrusted task text that can look like an
instruction.

**Alternatives rejected.**

- *Keep the example but label it "data, not instructions".* The text still
  appears in every prompt and models follow nearby task-shaped text; relabelling
  did not stop the repetition.
- *Keep a shortened example.* A fragment of a request is still a request-shaped
  hint ("只读取 README…").
- *Remove known folders entirely.* The briefing is how the twin remembers where
  the owner works; the path and use count carry that without the text.
- *Remove the recent-work section.* That section is why a completed task ten
  minutes ago is not asked about again; the fix is its framing, not its
  existence.

**Evidence.** `~/.clone/prompt-snapshots/45dab…json` (2026-11-24 17:52) contains
`- /Users/user/work — 6 request(s) … e.g. "只读取工作区根目录 … README.md…"`;
`renderKnownFolders` interpolated `folder.example` directly
(`src/main-agent/known-folders.ts`). The archived procedure memory
`mem-81aab49b-a11` repeats "下次应先直接读取当前工作区根目录的 README.md…".
The new `test/known-folders.test.ts` case gives a remembered folder an example
that names README.md and asserts the rendered briefing does not contain it while
still naming the folder and the use count; `test/situation-briefing.test.ts`
pins the history wording. The full run is recorded in
`docs/engineering/optimizations.md`.

**What it costs.** The folders read as less self-explanatory; the model knows
"this folder was used N times" but not why. If it needs the why, it asks the
owner. The example remains on the record for the audit and the memory page.

**Reversal condition.** If owners need the context in the prompt, add a short
**derived label** (repository or folder name) or show examples only when the
owner explicitly asks why the twin knows a folder; do not put raw request text
back into the every-turn briefing.

## 2026-11-24 — Every Kernel denial is an AI appeal; the owner is the last authority

**Decision.** The deterministic policy engine keeps returning `denied`, but the
Runtime no longer ends a run there. On a denial it asks a bounded model judge —
one short prompt to the configured Main Agent endpoint, 1,024 output tokens,
minimal effort, a 20 s timeout — for one word: `ALLOW`, `DENY`, or `ASK`.

- `ALLOW` records an `approval.granted` with `grantedBy: "model_judge"` and
  executes the step with a per-step override that bypasses the in-process
  protected-path, `.git`, `.rsi` and grant-gateway drops. The judge's reason is
  the note.
- `ASK`, an unparsable answer, an unreachable endpoint, or no judge wired
  records an `approval.requested` with the judge's reason and settles the run as
  `waiting_approval`; the approval card lists the step's scopes and the refusal
  reason, a macOS notification fires, and the sidebar row turns red. An owner
  approval then executes the step with the same override.
- `DENY` fails the run with the judge's reason.

This applies at every autonomy level and to every policy denial, including
protected locations and credentials: the owner chose "全部交给 AI（含凭据）".
The policy engine itself is unchanged, so `benchmark/gate` still pins the
deterministic denials; the override is a Runtime decision with its own audit.

**Why it won.** The owner asked for the whole agent to prefer automatic
execution and trust AI: every place that currently refuses should become an AI
decision on whether to execute, and only genuinely undecidable cases should go
to a human. The sidebar must show those cases with a red dot or a color change.
Keeping the Kernel's determinism but adding a model appeal is the smallest
change that honors both: the refusal and the appeal are recorded, and the owner
is still reachable.

**Alternatives rejected.**

- *Delete the hard denials and trust the planning model only.* No separate
  judgment, no reason trail, and a prompt-injected plan is the only authority.
- *Keep protected locations hard-denied.* The owner explicitly chose to include
  credentials.
- *Let the judge open the agent's own control plane without any human path.*
  `DENY` and `ASK` keep a human in the loop when the judge is unsure.
- *Have the worker prompt per tool call.* The native worker has no approval
  callback; the step is the existing decision unit.
- *Bypass the policy engine for the audit too.* Then the gate and the run record
  would disagree about what was denied; the judge must be an appeal, not a
  rewrite.

**Evidence.** The owner's answer: "全部交给 AI（含凭据）" to the scope
question, after the card and notification work. `AuthorityPolicyEngine.#judge`
returns `denied` for forbidden paths, unenforced domains and the observe ladder;
`resolveGrants` drops protected and too-broad scopes; `decideTool` refuses
protected reads and writes, `.git` and `.rsi`; the policy gate pins all of it.
The new `test/policy-judge.test.ts` pins the prompt and parser;
`test/authority.test.ts` adds allow/ask/deny runtime paths and checks
`checkJournalInvariants`; `test/path-gate.test.ts` pins the override through
`resolveGrants`/`decideTool`. The full run and gate are recorded in
`docs/engineering/optimizations.md`.

**What it costs.** The endpoint key, provider keys and `mcp.json` credentials
become reachable if a plan and the judge both decide to read them; a
prompt-injected plan can argue for itself, and the judge is the only barrier.
Each denial costs one model call and up to 20 s. The repair lane is the one
exception: its worktree has no owner watching, so the factory does not wire the
judge there and a denial fails as before. The agent-exec MCP server keeps its
own allowlist and Seatbelt profile, so shell commands still cannot reach those
paths even when the judge allows a step; that second gate is unchanged. The
approval card now must list scopes and the reason, or the owner cannot judge an
ASK.

**Reversal condition.** If any judge ALLOW reads or writes a credential the
owner did not intend, restore the hard denial for that category (or require an
owner confirmation even on ALLOW) before touching anything else. If judge
latency dominates a run, cache a verdict per run/step/scope and only re-ask
after a plan change. If owners routinely approve everything, tighten the judge
prompt or remove the appeal for that category.

## 2026-11-24 — Child agents run automatically; the desktop tells the owner only when a decision is needed

**Decision.** The 子 Agent 边界 card no longer says 默认禁止. The only child
executor is the in-process native worker, and it already runs automatically;
the old label was left over from the black-box CLI path that was removed. The
card now says it runs at the step's risk and stops only when a decision is
genuinely the owner's. When the Kernel does stop — `waiting_approval` or
`waiting_review` — the daemon posts a macOS user notification through
`osascript`: title is the task, body is the step and reason, both passed as
`argv` (never interpolated into AppleScript). The Runtime calls the notifier at
most once per run/step/kind, fire-and-forget; a failing notifier cannot change
the run's outcome. The notification is informational: the approval or review
still happens in the app.

**Why it won.** The owner said the 默认禁止 label "感觉不太好" and asked for auto
judgment with human confirmation only as a fallback, plus a computer notification
when that confirmation is needed. The label was factually wrong — no code gate
blocks the native worker — and the only owner-facing surface was the app (the
existing `/api/approvals/pending` route serves the phone bridge). A notification
is the missing link between "the run stopped" and "the owner is not looking at
the window".

**Alternatives rejected.**

- *Keep the "blocked by default" card.* It describes a path that no longer
  exists; a settings page that misstates behavior cannot be trusted.
- *Notify only from the web UI.* It works only while the window is open, and
  misses scheduled runs and a minimized app.
- *Notify from the phone bridge only.* The owner asked for the computer; the
  phone route also needs the bridge to be configured.
- *A native `UNUserNotificationCenter` helper now.* More machinery (authorization
  prompt, bundle identity) for the same user-visible result; `osascript` posts a
  notification without a new daemon dependency. Revisit if macOS blocks it.
- *Notify on every poll.* The Runtime's per-run/step/kind key makes repeats
  impossible; a polling UI would repeat while the run waits.

**Evidence.** `src/workers/provider-catalog.ts` records that the black-box CLI
recipes were removed; the native worker is the only executor in the daemon's
agent list. The settings card's value was exactly the string 默认禁止 with no
runtime check behind it. The transition points are `executeOwned`'s
`approval_required`, the `SubagentReviewRequired` catch and the final
`waiting_review` status. `test/authority.test.ts` injects a throwing notifier
and still gets `waiting_approval`, then a review runtime that notifies for
`waiting_review`; `test/owner-notifier.test.ts` pins the argv-only AppleScript
and the bounded body. The full run and gate are recorded in
`docs/engineering/optimizations.md`.

**What it costs.** macOS only; `osascript` notifications may require the owner
to allow notifications for Script Editor/osascript, and they carry no action
button (clicking opens nothing). A sleeping machine loses the transient
notification; the run stays in the app's waiting state. Every future decision
surface must use the Runtime hook or it will still be silent.

**Reversal condition.** If notifications are blocked or missed, move to the
Swift shell's `UNUserNotificationCenter` (with a click-to-open action) or add a
setting to choose the channel. If owners find them noisy, add a quiet-hours
setting rather than removing the hook. If the child card is ever wrong again,
make the status derive from the actual executor list instead of static copy.

## 2026-11-24 — A read-only request never goes through the LLM planner

**Decision.** Export `isReadOnlyRequest(query)` from the deterministic fallback
planner — it asks the planner for its plan and checks for the `read-only-lookup`
step — and use it in `runQuery`: a read-only query, or a read-only Main Agent
brief, is planned by `buildFallbackPlan` even when an LLM planner is injected.
The LLM planner remains the planner for delivery requests.

**Why it won.** Failed trace `c03c7cea` is the exact case: "仅读取当前工作区根目录
…/README.md … 不要修改任何文件". The plan was a `prepare` step with a draft
subagent whose artifact contract required a file; the worker produced only a
`read_file README.md` observation, and the runtime failed with "Subagent draft
did not satisfy its artifact contract." The worker did exactly what the request
allowed; the plan demanded a file the request forbade. The deterministic planner
returns a single `read-only-lookup` step for the same query. The LLM planner's
own prompt requires a required artifact for every subagent, so it cannot express
a read-only task; the deterministic planner can.

**Alternatives rejected.**

- *Add the read-only rule to the LLM prompt.* Advisory: the model saw the
  explicit "不要修改任何文件" and still proposed a draft.
- *Validate and retry the LLM plan.* Costs another call and can fail the same
  way; the deterministic planner already has the correct branch.
- *Let observation evidence satisfy the artifact.* Hides a planner defect and
  weakens every delivery contract.
- *Only use the fallback when no LLM planner is configured.* That is the bug.
- *Ask the worker to write the file anyway.* Violates the owner's explicit
  constraint.

**What was given up.** Read-only requests get the deterministic plan, which is
less tailored; the fallback's acceptance criterion is generic. No planner usage
record is written for those runs. A read-only request that actually needs a file
but names no target is classified read-only; that is the same rule the
deterministic planner already used, and a named write target still wins. The
repair lane's last attempt failed earlier at a different capability-routing bug
(`fe5cce8c`: its phase-1 write step was routed to `direct-responder`, which
lacks `filesystem_write`), so this fix was applied by the working agent and
checked functionally; that lane failure remains recorded in its trace.

**Evidence.** `~/.clone/failed-traces/c03c7cea-….json`: plan `prepare`, stage
`execution`, reason "Subagent draft did not satisfy its artifact contract.",
evidence one observation `README.md`; `test/fallback-planner.test.ts` shows
`buildFallbackPlan` returns `read-only-lookup` for the same query; the new tests
pin `isReadOnlyRequest` and `shouldUseDeterministicPlanner`. The new regression
in `test/llm-planner.test.ts` injects an empty scripted planner: before the fix
the run reaches the planner and rejects; after it, the planner is never called
and the read-only step runs. The two existing planner-failure tests now use
delivery queries so they still exercise their failure path. Targeted planner
tests **28/28**, the affected suites **48/48**, `npm test` **1103/1103**,
`npm run typecheck` exit 0 and `npm run gate` **PASS** with the baseline
unchanged. The app was rebuilt and restarted; `/api/health` returned 200. The
full suite's first run hit an unrelated flaky workspace-watch timing test; it
passed alone (3/3) and the rerun was green.

**Reversal condition.** If the LLM planner gains a validated read-only mode with
a test that it never emits a required artifact for a read-only request, route
read-only through it behind a post-validation gate. If a read-only request must
produce a file despite the marker, require a named target; the detector already
lets a named write target win.

## 2026-11-24 — Owner-confirmed MCP install: probe the package, show the tools, then write mcp.json

**Decision.** The tools settings tab gains an owner-confirmed install flow for
stdio MCP servers. `POST /api/tools/probe` spawns `npx --yes <package> <args>`,
performs the MCP handshake and returns `tools/list`; `POST /api/tools/install`
requires `acknowledgeInstall: true`, re-probes the package, refuses when the
package exposes a tool the request did not declare, and merges one entry into
the owner's `mcp.json` with `enabled: true` and the owner-assigned risk per
tool; `DELETE /api/tools/mcp/:id` removes one entry. Every tool starts at
`external` (always refused) until the owner assigns a risk, so an install grants
nothing by itself. The agent still cannot install: `~/.clone` is a protected
root and the exec sandbox re-denies it, so installation stays an owner action.

**Why it won.** The owner asked whether a missing tool can be downloaded with
human confirmation ("如果缺少工具能否自动下载获取，比如由人工确认下载加载"),
then said "做安装流". The alternative — hand-editing `mcp.json` or running
`scripts/install-*.mjs` — is the current, unconfirmed path; the page could only
toggle `enabled` on an entry that already existed.

**Alternatives rejected.**
- *Ship a curated marketplace of pinned third-party servers.* No provenance or
  signature infrastructure exists; a wrong pin fails closed, but a curated list
  would claim review the project has not done. The probe verifies the package
  at install time instead.
- *Let the agent install a tool.* A tool that writes `mcp.json` would let the
  model grant itself capabilities; the protected-root denial and the exec
  sandbox are the reason it cannot, and they stay.
- *Trust the declared tool list without probing.* A package can add or rename
  tools between versions; the probe is the only place that drift is visible
  before the server is enabled.
- *Default every probed tool to `read`.* Risk is the owner's declaration;
  defaulting to read silently grants access. The UI starts every tool at
  `external` so the owner must choose.

**Evidence.** Before: no route under `/api/tools` writes a server — the only
mutation is `POST /api/tools/mcp/:id/enabled` (`src/companion-server.ts:1708`).
After: `src/mcp/mcp-installer.ts` (probe, install, remove), three routes, and
the settings card; `test/mcp-installer.test.ts` pins the confirm gate, spec
validation, duplicate ids, undeclared-tool refusal, the written document and
mode, removal, and the probe against a real stdio server;
`test/tools-install-api.test.ts` pins the route validation. The before/after
command and counts are in `docs/engineering/optimizations.md`.

**What it costs.** Installing runs a package from npm with the owner's
privileges, unsandboxed — MCP servers are spawned directly, not through
Seatbelt. The probe is a download, so an install needs the network and can be
slow; a failed probe writes nothing. Risk is still declared in `mcp.json`, so a
server that changes its tools after install is filtered by the same gate as
before.

**Reversal condition.** If a probed package is found to run unexpected code
during the handshake, disable the probe and require an owner-supplied
`tools/list` fixture, or put MCP servers back under the Seatbelt profile; if
the owner asks the agent to install tools, remove the protected-root denial only
together with a Kernel approval record.

## 2026-11-24 — 「全部放行」 is the default: no scope requirement and no external confirmation, protected locations stay closed

**Decision.** The owner-facing ladder becomes three levels: 批准
(`act_with_approval`), 自动执行 (`act_auto`), and 全部放行 (`allow_all`).
`observe` and `prepare` stay valid in the schema only for legacy configs and
the corrupt-file fail-closed value; the UI does not offer them. A missing domain
defaults to `allow_all`, and the owner chose it as the standard for all three.
At `allow_all`:

- a files write no longer has to name a target in the plan; the worker receives
  `/` as a write root, and a step that declares nothing can write any path the
  owner's account can reach. An external/irreversible step still runs in the
  isolated copy the Kernel creates, and the `/` grant is withheld there so
  全部放行 does not defeat isolation; network remains open;
- network is open and shell tools are offered as the step's risk allows; the
  agent-exec command allowlist and its Seatbelt profile remain a second gate;
- the base risk gate for `external_side_effect` and `irreversible` is waived
  when every declared scope's effective level is `allow_all`; the Runtime
  records an `approval.granted` with `grantedBy: "standing_policy"` before
  dispatch so `approval-before-external-execution` still holds and the audit
  says who allowed it;
- protected locations (the whole clone home, keys, browser profiles), unenforced
  domains, and writes into `.git` / `.rsi` remain hard denials;
- a covering policy with a lower ceiling still narrows a scope (lowest ceiling
  wins); if any active write/exec policy narrows a domain, that domain gets no
  domain-wide grant, so an unscoped step fails rather than walking around the
  restriction.

**Why it won.** The owner asked to keep only four options, then removed 只读:
"算了直接删掉只读吧，感觉没什么用", and chose 全部放行 = "免 Scope，保留禁区"
with 全部放行 as the standard. `自动执行` still requires the model to declare a
target and still asks before external/irreversible work; `全部放行` is the
distinct top level they asked for. Keeping the protected-location denial is
what they explicitly chose; the alternative would undo the 2026-11-24
credential-file protection.

**Alternatives rejected.**

- *Bypass protected locations too.* The owner chose "保留禁区"; opening the
  clone home reintroduces the credential exposure the previous entry fixed.
- *Keep the scope requirement and only drop the external confirmation.* That is
  "自动执行 + fewer prompts", not 全部放行; the owner chose no-scope explicitly.
- *Trust the model always to declare scopes at 全部放行.* Then an unscoped step
  is denied by the tool gate and the copy ("免 Scope") is false.
- *Grant the home directory instead of `/`.* Same reach under the hood for the
  owner's files, but `/` is the literal meaning of 全部放行; the forbidden-root
  check is the boundary either way.
- *Remove `observe`/`prepare` from the schema.* Stored configs would become
  invalid under the strict parser, and the corrupt-file fail-closed value needs
  a lowest level. Hidden values are honest; deleting them would fail closed into
  an error instead of read-only.

**Evidence.** The owner's answer to the clarification: "免 Scope，保留禁区
(Recommended)" and "算了直接删掉只读". `AuthorityPolicyEngine` previously denied
a reversible write with no scope before reading autonomy; `resolveGrants` drops
`/` as too broad; `decideTool` does not apply `isForbiddenPath` to writes. All
three are changed. The gate gains unscoped-write, default-allow-all,
allow-all-external, allow-all-protected and narrowing cases; a Runtime test
asserts the implicit `approval.granted` lets an external step pass
`checkJournalInvariants`, and `test/path-gate.test.ts` pins the `/` write root
with the forbidden check. The detailed before/after is in
`docs/engineering/optimizations.md`.

**What it costs.** The default now lets a model-declared or unscoped write reach
any non-protected path the owner can, and external/irreversible steps stop
asking. The safety argument rests on the forbidden-root check in three places
(policy engine, `decideTool` writes, Seatbelt), the `.git`/`.rsi` denies, and
the external approval record. A future feature that adds a new protected
location must add it to every consumer. `自动执行` remains the safer middle
level; an owner who wants prompts should select it.

**Reversal condition.** If any run writes a file the owner did not intend
because of the domain-wide `/` grant, restore the scope requirement for
`allow_all` (or lower the domain to `act_auto`); if an external action executes
with an implicit policy approval the owner did not expect, remove the risk
waiver while keeping the no-scope grant. If owners stop using 批准/自动执行
because 全部放行 is the default, reconsider whether the default should be
`act_auto` again.

## 2026-11-24 — Automatic execution is the default, and `act_auto` means the model judges

**Decision.** `files`, `shell` and `network` default to `act_auto` when
`policies.json` does not name them, and `act_auto` no longer requires a covering
standing policy. At `act_auto` the step's declared scopes are the judgment: a
scoped read, write or exec is allowed without an owner-authored policy, provided
the target is not protected, the domain is enforced, a write names its target,
and the base risk gate does not ask for approval. This is what the owner's three
dropdowns mean by 自动执行: the model decides what to do and which exact scope it
needs; the Kernel checks the hard boundaries — forbidden locations, unenforced
domains, unscoped writes, and external/irreversible steps. An absent
`policies.json` is the default. A corrupt one never falls back to the permissive
default: a live snapshot fails closed to `observe`, and startup `load()` fails
loudly. Standing policies remain available as an optional narrowing: a covering
policy whose `maxAutonomy` is below the domain level lowers the effective
autonomy, and when several cover one scope the **lowest** ceiling wins so a
restriction is never defeated by a broader grant. The whole clone home is one
protected location — `config.json` (the endpoint key), `providers.json`,
`mcp.json` credentials, memory, conversations, the journal, checkpoints and
traces — with the Kernel's isolated sandbox as the only exception.

**Why it won.** The owner asked for "都改成自动执行…自动执行都变成模型自动判别，不然
学习成本有点高，这个 agent 变成傻瓜式的好一些". The old meaning of `act_auto`
required the owner to author a standing policy per resource — the domain
dropdown alone did nothing for a scoped step (`No standing policy covers ...` →
`approval_required`). The owner's own `~/.clone/policies.json` already sets all
three domains to `act_auto`, yet the browser-MCP entry was still needed for one
loopback read. That per-scope authoring is the learning cost being rejected.
Removing it does not widen what a step may touch: the scope still comes from the
plan model, and the Kernel still enforces the boundaries listed above.

**Alternatives rejected.**

- *Keep the policy-required rule and only improve the copy.* The owner already
  set every domain to `act_auto` and still hit approval prompts; the behavior,
  not the instructions, is what costs.
- *A per-step LLM judge at policy time.* The policy engine is synchronous and
  runs inside the execution loop; a model call per step adds latency and cost,
  and lets a prompt-injected plan argue for itself. The plan model already
  produces the scopes; the deterministic Kernel should check them, not ask
  another model.
- *Let `act_auto` bypass the risk gate for external/irreversible steps too.*
  `approval-before-external-execution` is a Kernel invariant; external effects
  and irreversible work still pause for the owner. The owner asked about the
  three domains, not about removing every confirmation.
- *Auto-grant the home directory or an implicit workspace.* Unchanged and still
  rejected: a write must name its target. The default is about who judges a
  declared scope, not about inventing one.
- *Make every domain `act_auto` in the UI only.* A UI default the engine reads
  as `observe` is a lie; the default lives in `AuthorityPolicyEngine`.
- *Keep the per-file protected list.* It protected the journal and policies but
  missed `~/.clone/config.json`, `providers.json` and `mcp.json` the moment
  `act_auto` made an uncovered scope automatic; the next credential file would
  repeat the bug. The clone home is the correct unit, with one named exception.
- *Keep the old `max()` union across covering policies.* Under the new meaning
  of a policy as a narrowing, a broad higher-ceiling policy silently defeats an
  explicit lower one and the owner's restriction becomes unreachable. The
  lowest ceiling is the only aggregation consistent with the UI's promise.

**Evidence.** `AuthorityPolicyEngine.#judge` returned `approval_required` when
`covering.length === 0` even at `act_auto` (`src/authority/policy-engine.ts`),
and `authority.test.ts` plus `benchmark/gate/policy-cases.json` pinned that
behavior. The owner's live config is `files/shell/network: act_auto` plus one
`network:read:127.0.0.1` policy written for the browser-MCP preview. The native
read gate already admits any non-protected read (`decideTool`), so a read policy
added friction without an additional enforcement. The five
act_auto-without-policy cases failed before (78% agreement, 5 over-blocks) and
pass after; the irreversible and protected-path guard cases held before and
after. An adversarial review then caught three follow-ups that this entry now
covers: the per-file protected list left `config.json`, `providers.json` and
`mcp.json` open under the new default; a broad higher-ceiling policy defeated a
lower-ceiling one; and a parseable-but-semantically-corrupt `policies.json`
(e.g. `"files": "Observe"`, or `policies` as an object) silently became
all-`act_auto`. All three are fixed and pinned: `overlapping-policies-lowest-ceiling-wins`
in the gate, and the clone-home, corrupt-config and cross-process cases in
`authority.test.ts` / `path-gate.test.ts`. The command and both outcomes are
recorded in `docs/engineering/optimizations.md`.

**What it costs.** A fresh install now arms scoped writes and execution on the
three enforced domains without the owner visiting Settings. The audit still
records every `policy.decided` with its scopes, and the owner can set any domain
back to `observe` or add a narrowing policy — but the default no longer fails
closed for a declared scope. The whole clone home is closed to workers except
the isolated sandbox; a future tool that legitimately needs another clone-home
path must add an explicit exception to both protection lists and the Seatbelt
profile. Policies can only narrow relative to the domain, and the lowest
covering ceiling wins; an owner who relied on stacking grants should be told
that a later, lower policy now restricts. Corrupt `policies.json` fails closed
in the live snapshot and loudly at startup.

**Reversal condition.** If a run writes, executes or reads something the owner
did not intend because of a mis-declared or injected scope, restore `observe` as
the missing-domain default and require a covering policy for `act_auto` again
(the 2026-11-24 observe-approval path remains the one-step alternative); if only
one domain misbehaves, lower that domain instead. If a legitimate worker task
needs a clone-home file other than the isolated sandbox, add that path by name
to both protection lists and the Seatbelt profile; do not shrink the root. If
owners rely on union-of-grants, add an explicit grant marker instead of
restoring `max()` aggregation. If owners report that the

## 2026-11-24 — The UI uses the macOS system typeface, four weights and normal tracking

**Decision.** Body and display text use `-apple-system`/SF Pro with PingFang SC
for Chinese; monospace uses SF Mono. Font weights collapse to 400/500/600/700,
and letter-spacing is never tighter than -.025em (most headings use -.01em).
The 14px/1.5 body size is unchanged.

**Why it won.** The computed body font was Avenir Next, not the system face.
Avenir's geometric Latin next to PingFang's Chinese produced the uneven
"not quite HD" texture; the UI also used about eighteen distinct weights
(520–760) and up to -.06em tracking on Chinese headings, which synthesized
weights and cramped the glyphs. Claude Code desktop uses the macOS system face;
matching the platform is the highest-leverage change and touches no layout.
The existing `-webkit-font-smoothing: antialiased` also behaves consistently
once the family is the system font.

**Alternatives rejected.**

- *Keep Avenir Next for a distinctive brand.* A real display face can stay on
  the Latin wordmark only; body text should be the system face. A geometric
  face without Chinese forces a fallback that clashes.
- *Bundle Inter.* A web font adds a load and still is not the native macOS
  texture; the system face is already the reference.
- *Keep the fine-grained weights.* Avenir has four faces; 520–760 mostly
  synthesize or snap to the nearest face, so the hierarchy is mushy. Four steps
  plus size and color is clearer.

**Reversal condition.** If a deliberate brand display face is wanted, apply it
only to the Latin wordmark and keep the system body; if the app ships on
Windows or Linux, extend the fallback stack (Segoe UI, Noto Sans) and re-check
the weight mapping.

## 2026-11-24 — Audit tool calls read as sentences and labeled fields

**Decision.** The audit's Main Agent turn log and worker tool list render each
tool input as a sentence headline, labeled fields and lists; the raw JSON sits
behind a "原始参数" toggle. The recorded input cap rises from 2,000 to 8,000
characters for new turns, and a stored input that was cut at the old cap is
repaired by closing the open string and brackets before rendering, with a note
that the record was truncated.

**Why it won.** The owner reported the audit's `dispatch_task` / `daily_workspace_digest`
rows as unreadable JSON; the audit exists to answer "what did the agent do",
and a JSON blob answers it only for a developer. The summary is deterministic
(no model), the known tools get a sentence, and every input keeps its raw form
one click away for debugging. The same formatter serves the conversation-level
turn log and the run-level tool list, so the two views cannot drift.

**Alternatives rejected.**

- *Keep the JSON and ask the owner to read it.* That is the reported problem.
- *Render only known tools and keep JSON for the rest.* The generic fallback is
  the same formatter; a tool added tomorrow is still readable.
- *Drop the raw input entirely.* Debugging a bad tool call needs the exact
  arguments; hiding them would trade one unreadable view for another.
- *Repair truncated JSON by guessing missing fields.* The repair only closes
  open strings and brackets; fields that were never recorded stay missing and
  the note says so.

**Reversal condition.** If a tool's summary is still unreadable because its
input is not structured, add a structured field on the server for that tool
rather than teaching the formatter more heuristics; if owners stop needing the
exact arguments, the raw toggle can go.

## 2026-11-24 — "未提交" is a state, not an external action; the external role is not a switch

**Decision.** The fallback planner's external-cue detection treats `提交` as an
action only when it is not a state phrase (`未提交/已提交的文件`) and, under an
explicit read-only marker, only when it names a concrete target (`提交 PR`,
表单, 申请, 报告). A quoted error that merely contains the word no longer turns a
read-only review into an external step; the clear verbs (`发送`, `发布`,
`上传`) still count. When an external action is genuinely requested and no
connector exists, the error says the connector is not implemented and offers a
local alternative, instead of "enable it in Settings". The Settings agent page
computes its enabled badge from the four profiles and states that external
actions are not among them and have no switch.

**Why it won.** The owner's request — "只读审查 doc_translate 那 9 个未提交的
ToolBox 文件" plus a quoted "再提交这个外部动作" — was planned as an external
action and rejected before approval because the fallback planner matches
`提交` as a substring anywhere in the request. The profile it looked for
(`external-operator`) was deleted in `6ca928e` when the black-box CLI workers
were removed; the native provider does not support external actions, and the
settings normalizer drops the stale `external-operator` entry the owner still
has in `settings.json`. The old message pointed at a switch that does not exist
(the PATCH route returns 400 for that id). A read-only request must not be
blocked by a state word or by an error it quotes.

**Alternatives rejected.**

- *Remove `提交` from the cue list.* Genuine submissions ("提交 PR") would be
  missed.
- *Suppress every external cue under a read-only marker.* "只读审查后发给团队"
  genuinely asks for a send; the clear verbs must keep counting.
- *Add an `external-operator` profile.* There is no governed action connector
  or provider for it; a profile would let a worker claim external actions
  without a real action path.
- *Keep the "enable it in Settings" message.* It is unactionable: the profile
  does not exist and the API rejects the id.

**Reversal condition.** When a governed action connector ships, add a real
external profile and switch, route external steps to it, and remove the
special-casing; if a genuine submission phrased without a named target is
missed, extend the target list rather than dropping the read-only guard.

## 2026-11-24 — An artifact-contract gap asks a model judge, then the owner, instead of failing

**Decision.** When a completed subagent has recorded observation evidence but
not every required artifact, the runtime asks a bounded artifact judge — one
short prompt to the configured Main Agent endpoint, capped at 1,024 output
tokens with minimal reasoning and a 20 s timeout — whether the evidence or the
completion summary satisfies
the work order. `ACCEPT` records the verification as passed with the missing
artifact noted and the run continues. `REVIEW`, an unparsable answer, or an
unreachable endpoint records the verification as `needsReview`, settles the run
as `waiting_review`, and shows the accept/reject pair in the main conversation's
subagent row (and the task record). A work order with no evidence at all still
fails — there is no answer to review. Protected paths and unscoped writes remain
the policy engine's decision, never the judge's.

**Why it won.** The owner reported the same dead end three times: "准备交付物"
completes with a read-only answer, the artifact contract rejects it, and the
task ends as a failed card with no accept, reject, or retry. A phrase list
("只读", "不要修改") is brittle and was the previous lane's approach; a model
judge reads the actual request and evidence. The owner explicitly said
observation evidence and written files are both acceptable, and that a human
must be able to continue when the judge cannot decide. `waiting_review` is the
existing mechanism; the changes are who may enter it and where the buttons
appear.

**Alternatives rejected.**

- *Keep the hard failure and make the owner rewrite the request.* This is the
  behavior the owner rejected; it discards a completed answer.
- *Always accept observation evidence.* A genuine write request could then
  silently skip its deliverable.
- *A separate judge model setting now.* The configured endpoint already runs a
  small model; a one-word prompt and a 1,024-token cap keep the cost bounded. Add a
  setting only if owners want to tune the judge independently.
- *Detect read-only intent with phrases.* The previous lane's approach; wording
  varies and a genuine write can contain "read" too.

**Reversal condition.** If a real run records a false accept for a missing
artifact of kind `artifact`, tighten the prompt or route every `artifact` gap to
the owner; if the judge adds more than ~5 s per work order or is unreachable in
most runs, drop it and default to review.

## 2026-11-24 — A work-order review is decided in the main conversation

**Decision.** When a subagent's artifact contract needs review, the main
conversation's subagent row carries the summary, the missing criteria,
"继续（接受观察证据）" and "判为失败". Accept settles the run as completed, reject
as failed, through the existing review API. The task record keeps its copy of
the review, and the full trace link now says it opens a read-only audit.

**Why it won.** The owner said "在这里由人工确认继续执行" while looking at the
main conversation, and previously reported that clicking through to the task
record did not explain what the page was for. The decision belongs where the
failure is visible; the task record stays the durable copy.

**Alternatives rejected.**

- *Only the task record may decide.* It forces a navigation the owner does not
  understand; the previous behavior is what produced this report.
- *No inline decision, only a link.* The link alone was reported as unclear and
  leaves the run dead in the owner's view.

**Reversal condition.** If the two decision surfaces drift or owners report
duplicate or conflicting buttons, centralize again and make the row link the
only path.

## 2026-11-24 — The memory page is a flat, search-first list; type stays a machine signal

**Decision.** The Memory page defaults to one flat list ordered by last use,
with the search box and a row of type chips. The five collapsible type groups
are removed. The stored `type` field and everything it drives — the
context-budget share, the preference recall boost and floor, same-type conflict
comparison, and the procedure evidence gate — are unchanged. The new-memory
form defaults to `fact`.

**Why it won.** The type taxonomy earns its keep in the runtime, not in
browsing: a preference claims 50% of the memory context budget (the code records
a 56.7% context hit rate on preference questions under a flat cap versus 92–99%
elsewhere), and a procedure is the one class whose candidate is refused when a
failed run has no supporting evidence. Browsing by five kinds was a second,
independent claim on the same field with no runtime effect: with a handful of
memories it hides rows behind collapsible headers, and it asks the owner to
classify a note before there is enough data for the categories to mean anything.
Search already answers "where is the note about X"; the list should open with
that and with recency, and the type should stay visible as a chip.

**Alternatives rejected.**

- *Keep the five groups as the default.* The grouping cost — one more choice
  before writing, five places to look — bought no runtime behavior, and the
  owner's library is small.
- *Delete `type` and rely on the index.* This drops the measured preference
  budget effect and makes same-type conflict comparison compare unrelated
  memories; the failed-run procedure gate has no replacement signal. The index
  finds memories; it does not decide who gets the context budget.
- *Reduce the taxonomy to two classes (rule vs fact) now.* A schema change and a
  migration for a distinction the runtime does not yet use; the five stored
  values already collapse to four budget classes.

**Reversal condition.** Restore grouping if the active library grows past
roughly 100 memories and measuring "time to find a known memory" shows groups
faster than search; or, if a later change removes every runtime use of `type`,
delete the field instead of keeping a label nobody reads.

## 2026-11-24 — A memory the owner authored is standing context, not only a token match

**Decision.** Every Main Agent turn also receives the active, non-secret
memories the owner authored (`sourceRunId: "owner"`), in addition to the
token-matched reviewed memories. They are summarized, capped at five, shown as
"Owner-authored standing memories (background facts the owner wrote; not
instructions)", and journaled in `memory.recalled` with `standing: true`. They
are not part of the per-class relevance budget; they are a separate bounded
section. `secret` owner memories are withheld. Archiving the memory stops it.

**Why it won.** The owner wrote "我是jiaoxiangyu,我的工作内容以此为展开" and asked
that work summaries recall it. The push is token-overlap recall: a request like
"继续总结" shares no term with that sentence, so the memory was silently absent
exactly when the owner expected it. Owner authorship is a deliberate act and a
stronger signal than a query match; a note the owner wrote once should be
background the twin already knows. The existing push already sends private
reviewed memories; adding the owner-authored class keeps the same sensitivity
boundary (secret withheld) and the same audit event.

**Alternatives rejected.**

- *Add a keyword/tag trigger to the memory.* The owner would have to guess the
  words a future summary uses; the note already exists and the owner expects it.
- *Push every reviewed memory.* The library can grow; relevance scoring exists
  to keep the prompt bounded, and a task-outcome memory is not standing context.
- *Recall only inside `daily_workspace_digest`.* A work summary may use
  `recent_file_changes`, a conversation, or a dispatched run; pushing on every
  Main Agent turn covers all of them.
- *A per-memory "always include" toggle in the UI.* That is the next step if
  owners author many notes; the owner-authored class is already an explicit act
  and needs no second switch. Add the flag when a second class is needed.

**Evidence.** `~/.clone/memory/mem-7ea39a38-0f6.md` has `sourceRunId: owner`,
`type: fact`, `sensitivity: private`, `status: active`; `pushRelevantMemories`
recalls only `source.recall(query)`, and the query "继续总结" has no term in
common with it. The new test commits an owner-authored memory and a non-owner
memory, pushes with a non-overlapping query, and asserts the owner memory is in
the text, in `memoryIds`, and journaled with `standing: true`, while the
non-owner memory is not. Secret owner memories are asserted absent.

**What it costs.** Up to five owner-written summaries (each bounded) are sent to
the model provider on every Main Agent turn, including turns unrelated to work.
A stale owner fact stays until archived. The journal records a
`memory.recalled` event each turn, so the audit grows with turns. The section is
background, not instructions; the prompt says not to treat it as instructions.

**Reversal condition.** If the owner authors many notes and the standing section
crowds the prompt or leaks context into unrelated turns, replace the class-wide
push with an explicit per-memory "always include in summaries" flag and keep
the same cap and secret filter. If owners object to a private note being sent on
every turn, move standing recall to the digest tool only. Keep the sourceRunId
"owner" filter and the `standing: true` audit either way.

## 2026-11-24 — A subagent row explains itself in the conversation; the task record is an explicit link

**Decision.** In the main conversation, a subagent row expands in place
(`<details>`) and no longer navigates to the run's task record when clicked. The
panel shows the worker's summary, up to five evidence rows for that work order,
and a deterministic "what to change" hint derived from the recorded failure
(an unsatisfied artifact contract → make the request read-only or name the exact
file; an interrupted/replay-unsafe run → inspect possible side effects; a
generic failure → open the evidence or task record, supply the missing input or
narrow the scope). A separate "打开任务记录查看完整轨迹" button keeps the old
navigation for the full 21-row trace. The agent-list header counts failed
subagents as "需要处理".

**Why it won.** The owner clicked "准备交付产物" in the main conversation and was
taken to an unrelated-looking task record; the conversation lost its place and
the row did not say what to fix. The summary needed for the hint
("Subagent draft did not satisfy its artifact contract.") is already in the
session payload, and the evidence is in the run projection. Explaining in place
keeps the request, the answer, the failure and the next action in one view.

**Alternatives rejected.**

- *A separate sidebar session per subagent.* It would duplicate the run's task
  record, split one audited run into two places, and still make the owner
  navigate. If a full per-subagent workspace is needed later, add a drawer fed
  by the task record rather than a second session.
- *Keep navigating to the task record.* That is the reported failure: the
  conversation is lost and the fix is not stated.
- *Put the full execution trace inline.* Twenty-one rows per subagent would
  flood the conversation; the explicit task-record link keeps the trace one
  click away.
- *Let a model write the hint.* A deterministic mapping from the recorded
  failure is auditable, free, and cannot invent a cause. The raw summary stays
  visible above the hint.

**Evidence.** `apps/desktop/ui/app.js` `agentsMarkup` rendered every openable
row as `<button data-open-agent-run>` and the click handler called
`selectSession(runId)`; the comment in the same function says a subagent is a
work order inside its run, not a session. The screenshot shows the jump and the
generic "需要处理" row. The session payload already carries each subagent's
`title`, `status`, `agentId` and `summary`; `state.evidenceByRun` carries the
run's evidence with `workOrderId`/`stepId`. The new UI test pins the details
markup, the hint text, and the absence of `agent-row--open`; the evidence
mapping is covered by typecheck and the existing session-view tests.

**What it costs.** The row is taller when expanded, and the evidence list is
capped at five; the hint is a mapping for known failure shapes and ends with a
generic fallback, not a diagnosis. The full trace still requires the explicit
task-record link. The `agentFocus` scroll behavior now belongs to that link, not
the row.

**Reversal condition.** If owners need the full trace without leaving the
conversation, add a drawer that loads the task record; if the hint misleads,
remove it and show only the raw failure plus the task-record link; if inline
rows become noisy, collapse failed subagents into one summary card in the main
conversation. Keep the explicit task-record link in every variant.

## 2026-11-24 — The composer's model and effort are saved with the conversation, not the page origin

**Decision.** The model and effort a conversation keeps are stored in
`<clone home>/turn-choices.json`, one entry per conversation id, and served to
the desktop on the dashboard and through `GET`/`PUT /api/main-agent/turn-choice`.
The composer reads the daemon's entry first; browser local storage stays only as
a cache for a new request that has no conversation id yet. The stream and query
handlers also save the choice a turn actually ran with. Two empty fields remove
the entry, so "follow Settings" is an absence, not an override.

**Why it won.** The composer used local storage keyed by conversation id, and
the app loads the daemon at an ephemeral `127.0.0.1:<port>` origin. Local
storage is scoped to the origin, not the conversation id, so every daemon
restart (a new port) silently dropped the choice. The UI already said "随对话
保存"; the storage was page-scoped, not conversation-scoped. The daemon's clone
home is the one store that survives a port change and is already the owner's
data.

**Alternatives rejected.**

- *Pin the daemon to a fixed port.* A fixed port collides with a second runtime
  and with whatever else the owner runs; the port was made ephemeral for that
  reason.
- *Store the choice in the turn ledger or the transcript.* The ledger is the
  record of what was said and done; a picker preference is neither, and writing
  it there would make it look like history the model should read.
- *Use a browser cookie.* A cookie has the same origin scope as local storage.
- *Use a Tauri/webview store.* The window navigates to the daemon's HTTP origin,
  not the bundled asset origin, so the origin problem returns unless the app
  stops loading from the daemon.
- *Keep local storage only and re-pick after a restart.* That is the bug the
  owner reported: the choice was lost when the daemon restarted.

**Evidence.** `apps/desktop/ui/app.js` defined `TURN_CHOICE_STORAGE` and read
`localStorage` keyed by conversation id; the daemon endpoint changed
`127.0.0.1:50708` → `127.0.0.1:57575` across restarts on this machine, and the
composer showed "默认模型 / 使用模型默认" after the restart. The new
`src/main-agent/turn-choice-store.ts` is pinned by
`test/turn-choice-store.test.ts` (write, partial update, clear, malformed file,
owner-only file); `test/companion-config-api.test.ts` covers the GET/PUT route
and clearing; `test/ui-structure.test.ts` proves the composer prefers the
daemon's entry and falls back to local storage only when the daemon has none.

**What it costs.** A new owner-data file (`turn-choices.json`, mode 0600) and a
slightly larger dashboard session payload. Entries are capped at 500 by
last-update time; a deleted conversation can leave a stale entry until the cap
prunes it. A model id that later disappears from the catalog still appears as
the "current choice" option (the existing outside-catalog behavior). The
desktop keeps local storage as a cache, so a new request made before routing
still has a choice.

**Reversal condition.** If the app later serves its UI from a stable origin (for
example a bundled asset origin) and no longer depends on the daemon's port,
local storage alone is simpler; remove the server store if no other surface
needs it. If `turn-choices.json` grows or carries deleted conversations, prune
by the live conversation list instead of only the 500-entry cap. Keep the
daemon store as the source of truth while the port is ephemeral.

## 2026-11-24 — A scoped reversible write under an observe-only files domain asks the owner once

**Decision.** A `reversible_write` step that declares a `files` write scope and
runs while the `files` domain is still `observe` is no longer a hard failure.
The policy returns `approval_required`, the run enters `waiting_approval`, and
the existing approval card lets the owner allow this exact step once or deny
it. An approval lifts only the observe-only denial for this step's declared
scopes; it creates no scope, opens no protected path, and leaves the domain at
`observe` for every later step. The owner's auto path is unchanged: setting
`files` to `act_auto` with a covering standing policy lets the worker's scoped
writes proceed without a per-step confirmation. Other domains (shell, network)
and external or irreversible risks keep their current hard gates.

**Why it won.** The owner asked for Claude Code auto-like behaviour: the
worker's model decides the write inside its declared scope, and a refusal can
be confirmed by the owner. `act_auto` already provides the auto half; the
missing half was that the default `observe` domain failed a scoped write
outright, so the owner had no accept/reject action. Reusing the existing
step-level approval route is the smallest change that supplies that action: the
UI, the journal event, the run status and the approval code already exist. A
per-tool-call approval would reopen the 2026-11-19 decision (the native worker
has no approval callback; a per-call prompt needs a new pause/resume channel
and blocks the loop), and it would not give the owner more information than the
step's declared scopes.

**Alternatives rejected.**

- *Let the model self-approve writes.* The model is not the authority; a
  prompt-injected worker must not be able to open a path. This change only
  gives the owner a button, and only for a step that already names its target.
- *Turn every `observe` denial into an approval request.* External and
  irreversible steps keep their stricter gate; an observe-only shell or network
  domain must stay a denial. Only a reversible files write with a declared scope
  is approvable.
- *A per-tool-call approval channel.* Reverses 2026-11-19 for marginal
  information, and the worker's tool loop has no callback to pause on. The step
  is the existing approval unit; its scopes are visible before execution.
- *Only a UI mode switch.* A switch alone would not help the current failure:
  the owner's domain is `observe`, and the run already failed before any switch
  could be made.

**Evidence.** `AuthorityPolicyEngine.#judge` returns `denied` for any non-read
scope while the domain is `observe`, even when `approved` is true; `authority.test.ts`
pins that today. `executeOwned` turns `denied` into a failed run and
`approval_required` into `waiting_approval`; the server's
`/api/runs/:id/approve`, `approveQueryRun` and the approval card are already in
use for `act_with_approval`. The owner's `~/.clone/policies.json` has no
`files` domain, so the default is `observe`. The new tests cover: an
unapproved scoped write → `approval_required`; approved → `allowed`; a
protected target stays `denied` even when approved; an unscoped write stays
`denied`; a shell/network scope stays `denied`; an `irreversible` step stays
`denied`; `act_auto` remains allowed without approval.

**What it costs.** An observe-only files domain can now write once after a
click, so "observe" no longer means "no write can ever happen" — it means "no
write without the owner's explicit one-step approval". The approval is per
step, not per file: a step with several write scopes is approved as a whole.
The card does not yet list every target; the plan and the audit do. A stale
approval is keyed to the run and step id, so a re-planned step needs a new
approval.

**Reversal condition.** If one-step approvals become a rubber stamp, or a
prompt-injected worker gets the owner to approve a scope the owner did not read,
remove the observe exemption and require raising the domain to
`act_with_approval`/`act_auto` before a write can be proposed. If owners need
per-file decisions, add a target list to the approval card first; do not add a
per-call channel without that evidence. Keep protected paths and unscoped
writes permanently denied.

## 2026-11-24 — The resident daemon records FSEvents, and generated files stay out of the ledger

**Decision.** The companion daemon — already a resident launchd LaunchAgent
(`ai.clone.companion`, KeepAlive) — watches every learned folder with Node's
recursive `fs.watch`, which macOS implements on FSEvents. Each event is
classified (`created` / `modified` / `removed`), filtered, deduplicated per path
for 30 seconds, and appended to `workspace-history/days/<key>/<day>.events.jsonl`.
The 30-minute content capture stays as it is; the event file records *that* an
operation happened and *when*, and the daily digest merges it with content
diffs, Git, turns, runs, verifications and memory writes. The same noise filter
is applied at capture and in the digest's mtime fallback: hidden and generated
directory names, generated-file patterns, and the repository's own `.gitignore`
(untracked ignored paths). The number of skipped generated files is reported,
not silently dropped.

**Why it won.** The owner asked for FSEvents and for useless information to be
filtered. A 30-minute poll only sees net content changes: a file created and
removed between polls leaves nothing, and the exact operation time is lost.
FSEvents while the daemon runs gives the operation stream at kernel cost. The
window-closed case is already covered because the runtime is a launchd agent,
not the window; FSEvents adds latency and transient visibility, not a new
"closed" guarantee. Mac sleep/off cannot be covered by any user-space watcher
(FSEvents does not replay while the process is dead), so the existing
mtime-based backfill on the next capture remains the answer for that gap.

**Alternatives rejected.**

- *Install a second launchd agent for the watcher.* The daemon is already the
  resident agent; a second one duplicates the ledger lock, the folder list and
  the shutdown path.
- *Run a full capture on every event.* A build burst would stat 20,000 files
  every few seconds. The event append is O(changed paths); content stays on the
  capture cadence.
- *Read and store content on the event.* The file may already be gone when the
  event is handled; reading it synchronously in the listener would block the
  watcher. The capture stores content for what survives; the event log honestly
  records the operation that left no file.
- *Filter only by directory name.* `.DS_Store`, `*.log`, `*.tsbuildinfo`, source
  maps and build outputs inside ordinary folders would still flood the digest;
  file patterns and the repository's `.gitignore` are required.
- *Exclude every dotfile.* `.gitignore`, `.editorconfig` and other meaningful
  dotfiles are work; the filter names known tool/OS junk instead.
- *Use `chokidar` or the `fsevents` package.* Node's recursive `fs.watch` is
  FSEvents-backed on macOS and adds no dependency; the 30-minute capture covers
  any events the watcher misses.
- *Only record events, drop the content capture.* The owner's original ask is a
  content-level daily diff; events say when, the capture says what.

**Evidence.** `src/desktop/daemon-supervisor.ts` renders a KeepAlive LaunchAgent
and `~/Library/LaunchAgents/ai.clone.companion.plist` exists on this machine;
`ps` shows the bundled `desktop-sidecar.ts` running from the installed app, so
closing the window does not stop the daemon. A live probe on this machine
(Node 24, macOS) showed recursive `fs.watch` reporting `sub/x.md` on create and
delete. `src/main-agent/tools/recent-changes.ts` currently filters directory
names only; `.DS_Store`, generated files and gitignored outputs pass through.
`test/workspace-noise.test.ts` (patterns and `.gitignore`), `test/workspace-watch.test.ts`
(event classification, dedupe, noise skip) and `test/daily-digest.test.ts`
(event merge) pin the behavior.

**What it costs.** One recursive watcher per learned folder (at most five), with
the kernel's FSEvents stream; a shallow turn-ledger watch refreshes the folder
set when a new folder is learned. The event file is capped at 5,000 records per
folder per day and pruned with the day files. Gitignored sets are cached for
five minutes and invalidated by a `.gitignore` event. Events during Mac sleep
are lost; content of a file created and deleted between the event and the
capture is lost. The filter can hide a generated-looking path the owner
considers work (a `*.log` they edit by hand); the file stays on disk and the
digest's coverage line says how many paths were filtered.

**Reversal condition.** If event volume or watcher CPU becomes noticeable, raise
the dedupe window or watch only the folders named in the last day's requests; if
the event log confuses more than it explains, remove it and keep the 30-minute
capture; if owners report a filtered path as work, add a narrow allowlist (not a
folder setting) with the report as the evidence. Keep the `.gitignore` filter:
it is the owner's own definition of generated output.

## 2026-11-24 — A bounded daily ledger gives the workspace a content-level day diff

**Decision.** The twin keeps its own change ledger for the folders it has learned,
in `<clone home>/workspace-history`: a content-addressed text blob per changed
version, a per-day JSONL record of `(path, before, after, time)`, and a per-folder
state map of each file's current identity. The daemon's maintenance loop captures
incrementally at most every 30 minutes — stat the known files, ask Spotlight for
new ones, and pay a bounded full walk only for the first baseline. A new read-only Kernel
tool, `daily_workspace_digest`, renders one local day as: file changes with
unified diffs for text files, each repository's commits and status for that day,
the day's runs, verifications and memory-document writes, and a coverage section
that names what it could not see. The tool never starts a ledger capture inside
a turn; when no ledger covers the day it reuses the existing bounded
Spotlight-or-walk read and reports the answer as mtime-only.
`recent_file_changes` stays the cheap live list for "what changed today / in the
last N hours".

This supersedes the 2026-11-19 scope "The tool reads file names and Git status,
never file contents" for learned folders, and only through this ledger and its
caps.

**Why it won.** The 2026-11-19 entry chose metadata only, so the owner's answer
in the 2026-11-24 screenshot can name files and commits but cannot show what
inside a document changed; a folder outside Git has no content record at all.
The owner asked for the workspace to be readable "每天当作 diff，查看具体的操作内容"
and for records beyond Git. A content diff needs a before state, and the
filesystem offers none for arbitrary folders (see rejected alternatives), so
the twin has to record its own baseline. Putting capture in the maintenance
loop keeps the 5.2 s pruned walk of a 130 GB tree (2026-11-19 measurement) off
the turn path: the first capture pays it once, and later captures only stat
known files plus Spotlight's new-file query.

**Alternatives rejected.**

- *Keep names + mtimes + Git and add another search.* The missing thing is
  content, not another index: `search_history` already reaches every conversation
  and `recall_memory` every reviewed note. Another search over the same file
  names still cannot answer "what changed inside this document".
- *Snapshot the whole tree each turn or each day.* The 2026-11-19 entry measured
  a pruned walk at 5.2 s on this machine; paying it per turn makes every
  "what did I do today" question cost seconds before it can answer, and a full
  manifest every ten minutes would be mostly duplicated bytes. The state map
  carries the same information at the price of one stat pass.
- *Use Git as the diff engine by committing into the owner's repositories.*
  The twin must not create commits in the owner's work, most personal documents
  are not in a repository, and the 2026-11-19 write entry removed any implicit
  write root. Git stays a read-only extra stream inside the digest.
- *Depend on Time Machine/APFS local snapshots or IDE local history.* (Assumption,
  not measured.) Local snapshots exist only where a backup tool configured them,
  browsing them needs `tmutil` and elevated access, and VS Code/JetBrains history
  is per-IDE and has no documented interface. The ledger must work on folders
  where none of these exist.
- *Store one full manifest per day.* A 20k-entry manifest is about 3 MB; one per
  folder per day is about 1 GB per year for five folders. Day deltas store only
  the changes, which is exactly what the digest reads.
- *Store a full file copy per change, like the checkpoint store.* A checkpoint
  keeps copies for one dispatch; a daily ledger would keep every version of
  every document forever. Content-addressed blobs, 90-day pruning and a 512 MB
  cap bound it.
- *Let `daily_workspace_digest` capture on demand.* It would put the baseline's
  60 s per-folder walk inside a turn, and capturing at read time still cannot
  invent a before-state for a past day. Capture belongs to the daemon; the tool
  reads, and falls back to the existing bounded mtime read when the ledger has
  no coverage.

**Evidence.** `src/main-agent/tools/recent-changes.ts` (`statFile`, `readRepository`) reads
only metadata and Git; the 2026-11-19 trade-off states "The tool reads file
names and Git status, never file contents." Spotlight accepts both
`$time.iso(<timestamp>)` and `$time.today(-N)` (verified on this machine on
2026-11-24: a future ISO cutoff returned no matches, a 400-day cutoff returned
files), and the existing Spotlight path answered `~/work` in 0.13 s. The existing
`snapshotWorkspace` already bounds a walk at 20,000 files and hashes files ≤2 MB,
so the same limits carry over. `test/workspace-ledger.test.ts` and
`test/daily-digest.test.ts` pin capture, day windows, diffs, fallback coverage,
protected refusal and the merged activity sections.

**What it costs.** The clone home now stores private file content. `~/.clone`
is a protected location for workers — `workspace-history` is added to the
protected roots — so no worker can read the ledger; the digest
returns excerpts to the Main Agent only when the owner asks for a day. A
learned folder may contain a protected root (a home folder contains
`Library/Keychains`), so every content read is checked against the protected
list, not only the folder root; credential-shaped files (`.env`, `.npmrc`,
keys) are tracked by identity but never read into a blob and never diffed.
Caps: 5 learned folders, 20,000 files per folder, 512 KB per text blob, 512 MB
total blobs, 5,000 change rows per folder per day, 90-day retention. Binaries and
larger files are identified by `meta:size:mtime` only — listed as changed, never
diffed. Nothing is recorded while the app is closed, while a folder is over the
cap, or before the first baseline capture; the digest says so in a coverage
section instead of claiming a complete day. The first capture reads up to 20,000
small text files once; later captures stat the known files and ask Spotlight for
new ones at most every 30 minutes. A capture that is not aborted writes its
check file every time but rewrites the full state map only when the map
changed. A crash between a blob write and the usage write can undercount the
budget until the monthly prune recomputes it.

**Reversal condition.** If the owner reports days with real work missing because
the app was closed or the folder exceeds 20,000 files, move capture to an OS-level
watcher (FSEvents/launchd) or raise the caps, and record the measured coverage
gap. If blob storage or the stat pass becomes noticeable, raise the interval or
capture only folders named in the request; do not keep the 30-minute cadence by
default. If any file's content reaches a context the owner did not ask for
(a symlink escaping a learned folder), stop storing content, keep hashes, and
require an explicit per-day content request.

## 2026-11-24 — The Main Agent writes the worker brief; the Kernel appends only facts

**Decision.** A `PlanStep` and a `SubagentWorkOrder` gain an optional
`workerBrief`. When it is present, the Main Agent's text is the worker's task
prompt: the worker's system message is the brief plus a short, fixed execution
contract (tool names, the gate, the stop condition), and the user message
contains only the facts the Kernel resolved after planning — workspace,
objective, required inputs, evidence contract, memory packet, refused scopes,
and acceptance criteria. When it is absent, the previous template is used
unchanged. `dispatch_task` gains `workerBrief`; the deterministic fallback
planner and the LLM planner both carry it onto the primary execution step or
work order, and the planner's own text cannot override the Main Agent's.
`MAIN_AGENT_CHARTER_VERSION` moves to 8; the daily-digest guidance added in
parallel takes the current tree to 9. The charter is reorganised around the
reply / `dispatch_task` / `propose_work_plan` decision and the brief contract.

**Why it won.** The 2026-11-17 Forbidden City trade-off records the failure
this closes: both natural attempts produced zero artifacts because
`dispatch_task` → `runQuery` → `buildFallbackPlan` replaced the Main Agent's
task with a generic `local-draft` objective, and `buildInstructions` passes the
work-order objective, so the worker received “只在本地准备可修改、可回退的结果”
instead of the task. The worker prompt is also split today: the boundary is
restated in `native-worker-prompt.ts` and again in `buildInstructions`, while
the Main Agent can state task-specific constraints only in `instructions` or
`objective` and cannot reach the worker's system prompt at all. Letting the
Main Agent write the brief gives one author for the task prompt and leaves the
Kernel only the facts it alone can know. The tool gate is code (`decideTool`),
so moving task prose out of the fixed template does not move enforcement; a
refused call still returns its reason to the worker.

**Alternatives rejected.**

- *Add `workerBrief` as a suffix under the existing template.* Rejected: the
  brief would still be buried under generic prose, and the two layers would
  keep disagreeing about the boundary and the stop condition.
- *Let the Main Agent write the evidence contract and the memory packet too.*
  Rejected: those are Kernel-resolved after planning. A stale copy would be
  worse than none, and the memory packet must be journaled with the step that
  received it.
- *Remove the execution contract along with the template.* Rejected: the tool
  list is the calling convention, not task content. A worker that does not know
  which tools exist or that a refusal is final wastes rounds and may loop.
- *Apply the brief only to `dispatch_task`.* Rejected: `propose_work_plan` is
  the path that carries a full plan, and both paths must share one contract or
  the worker prompt depends on which tool the Main Agent chose.

**Reversal condition.** If main-agent-authored briefs correlate with more
boundary-violating tool calls, more missing-artifact failures, or more runs
that finish without the required evidence than the fixed template, restore the
fixed boundary and keep only the task-specific brief. Compare on the Forbidden
City natural variant and the native-worker regression suite.

## 2026-11-24 — The settings page lists MCP servers, their tools and skills, with a load toggle

**Decision.** Add a read-only catalog API (`GET /api/tools`) and a narrow
enable/disable endpoint (`POST /api/tools/mcp/:id/enabled`) to the local
companion, plus a **工具与技能** settings tab. The tab shows every server in the
clone home's `mcp.json` — id, transport, enabled state, and each declared tool
with its risk and description — and a **加载 / 停用** button per server. It also
shows the skills found under `<clone home>/skills` and
`<workspace>/.clone/skills`, with unparseable skills reported separately. The
catalog never returns `env`, `command`, `args`, or any credential; the toggle
rewrites only the selected server's `enabled` field in `mcp.json`, atomically
and with the existing 0600 mode, preserving every other field and server.

**Why it won.** The settings page had no MCP or skill surface at all — a search
of `apps/desktop/ui` and `companion-server.ts` for `mcp`/`skill` returns
nothing — so the owner had to edit `mcp.json` by hand to load or unload a
server. `workerTools` reads `mcp.json` when it builds a worker adapter
(`src/workers/provider-catalog.ts`), so `enabled` is the real load switch and the
next worker run sees the change; no runtime restart is needed. The declaration is
also the authority `mcpToolSpecs` uses for risk, so showing declared tools is
showing what the worker can actually be offered. The skill loader already
scans `<root>/<name>/SKILL.md` (`src/skills/skill-loader.ts`) but had no UI;
listing its result is a read-only view, not a new skill authority. The current
clone home makes the need concrete: `playwright` (10 tools), `agent-tools`
(7 tools) and `agent-exec` (2 tools) are installed, and every one of them is
otherwise invisible in the app.

**Alternatives rejected.**

- *Spawn each server and call `tools/list` from the settings API.* Rejected: a
  settings read would start child processes, duplicate the MCP client and its
  gate, and let a broken server hang the page. The `mcp.json` declaration is the
  risk authority the worker already trusts; a live probe can be a separate
  "test connection" action later.
- *Let the browser edit `mcp.json` itself.* Rejected: the window has no
  filesystem access, and the write must be atomic and 0600; the sidecar owns
  configuration writes.
- *Return the full server entry, including `env`, `command` and `args`.*
  Rejected: `env` may hold credentials and `args` may include tokens. The
  catalog exposes only id, transport, enabled and the declared tool metadata.
- *Restart the runtime after a toggle.* Rejected: `workerTools` builds the tool
  table per run; a restart would interrupt the open conversation for no gain.
  The UI says the change applies to the next worker run.
- *Add install buttons for bundled or third-party servers now.* Deferred: the
  browser installer needs a workspace and port, and third-party servers need a
  command/args/env review. A load button controls an installed server; adding a
  server remains an owner install action.
- *Add skill enable/disable toggles.* Deferred: the skill loader has no
  production `skillRoots` caller yet; wiring skills into the Main Agent turn is
  its own change. The catalog is read-only for skills.
- *Build a MCP marketplace.* Deferred: it needs signature/provenance and a
  review surface for the command, args and environment a server would receive.

**What was given up.** The catalog describes declarations, not live server
health: a server whose declared tools drift from what it actually offers will
look stale until a live-probe action exists, and the worker still only sees the
declared tools. The load button changes the owner's `mcp.json`; the file remains
the source of truth. Skills are listed but cannot be toggled. `enabled` is per
clone home, so the same server list is used by every workspace; only the skill
roots are workspace-aware. Installing a server still requires its installer or a
hand-edited `mcp.json`.

**Evidence.** The installed `mcp.json` on 2026-11-24 has `playwright` with 10
tools, `agent-tools` with 7 and `agent-exec` with 2; `rg -i "mcp|skill"` over
`apps/desktop/ui` and `companion-server.ts` found no settings surface.
`workerTools` loads `mcp.json` per adapter (`provider-catalog.ts`), and
`loadSkills` returns parsed skills and rejected files. `test/mcp-settings.test.ts`
is **6/6**: the safe projection (no `env`/`command`/`args`), the atomic toggle
preserving other servers and fields, invalid ids and bodies, skill discovery and
rejected skills, and the root-workspace guard. The route test in
`test/companion-config-api.test.ts` (`23/23`) covers the live catalog, the
credential-blind response and the load/unload endpoint; `test/ui-structure.test.ts`
(`34/34`) pins the tab, the panel, the `/api/tools` call and the
`data-tool-toggle` hooks. `npm test` is **1038/1038**, `npm run typecheck` exits
0 and `npm run gate` is **PASS** with the baseline unchanged. On the rebuilt app,
`GET /api/tools` returned the three servers (10/7/2 tools), zero skills and the
clone-home root; the first live probe exposed a Finder-launched workspace of
`/`, which would have shown `/.clone/skills`; `skillRootsFor` now omits a root
workspace, and the test asserts it.

**Reversal condition.** If declared tools routinely disagree with what a server
offers, add a timeout-bounded "test connection" action that starts the server
through the same MCP client. If the owner needs to add servers from the UI, add a
reviewed install flow rather than letting the model or the page supply argv. If
skills become wired into the Main Agent turn, add a skill toggle to this tab. If
servers must differ per workspace, add a workspace-scoped config and show the
scope in the card.

## 2026-11-23 — A sandboxed, allowlisted command runner gives the worker a test loop

**Decision.** Add a second bundled stdio MCP server, `agent-exec`, with two
tools: `list_commands` (read) and `run_command` (write). Commands are an
owner-written allowlist of argv arrays in `<clone home>/agent-exec.json`; the
installer seeds it from the project — the `test`, `typecheck`, `lint`, `check`,
`gate` and `build` scripts of `package.json`, or `pytest`, `go test`,
`cargo test`, `mvn test` or `gradlew test` when those project types are detected.
`run_command` takes only a command name: no shell, no model-supplied arguments.
The server runs `execFile` with the workspace as cwd, a minimal environment
(`PATH`, `HOME`, `LANG`, `TMPDIR`, `CI`), a 240-second timeout, a process-group
kill and a 100 KB output cap that keeps the tail. On macOS it wraps the command
with `/usr/bin/sandbox-exec -p <profile>`; the profile comes from
`buildSeatbeltProfile` with the workspace (plus the package caches) as the
write roots, network off and the kernel's protected roots denied. When no
sandbox is available it refuses to run unless the config explicitly sets
`allowUnsandboxed: true`. No commit tool is added; committing remains the
repair lane's job.

**Why it won.** The 2026-11-22 entry deferred shell because `decideTool` refuses
`external` and no worker-facing sandbox existed. The builder already exists in
`src/authority/seatbelt.ts` with no call sites, `/usr/bin/sandbox-exec` is
present on this machine, and a smoke profile ran `/bin/echo` successfully. The
repair lane itself records the gap: its prompt says "You have no shell tool: the
lane runs the whole suite and the typecheck after you stop"
(`src/repair/repair-lane.ts`), and the lane runs the suite through an injected
command runner (`src/repair/gates.ts`). A code agent that cannot reproduce or
verify a bug writes the fix blind; running the project's own test/typecheck
scripts inside the step closes that loop. The project's scripts are the
smallest command surface, and an owner-authored allowlist is inspectable in a
way model-supplied argv is not.

**Alternatives rejected.**

- *A general `run_command` whose argv comes from the model.* Rejected: it is
  arbitrary command execution, the exact authority gap the gate cannot express;
  the allowlist is the smallest surface that still enables the loop.
- *Add a new `execute`/shell risk and enforce shell scopes now.* Deferred:
  `resolveGrants` parses `shell` scopes but discards them
  (`src/authority/path-gateway.ts`), and `decideTool` has no command check. A
  new risk touches the worker loop, the MCP client, policy and tests. Revisit
  when the shell scope is enforced; until then the allowlist plus the OS sandbox
  is the boundary.
- *Run commands unsandboxed because the project's own tests are trusted.*
  Rejected: tests are project code and can read credentials, write outside the
  workspace or reach the network. The sandbox is the boundary; on non-macOS the
  runner refuses unless the owner explicitly opts out.
- *A dedicated `run_test` that accepts a test file path or extra arguments.*
  Rejected for v1: it is runner-specific and widens the argument surface. The
  project's own `test` script is the abstraction; the owner can add a focused
  script to `agent-exec.json`.
- *Add LSP, symbol navigation or a debugger now.* Deferred: executing the
  project's tests and typecheck is the blocker for bug fixing; a language
  server or debugger needs its own inventory and contract. Revisit on a task
  where search, read and typecheck are insufficient.
- *Add an HTTP POST/API tool or a database tool.* Deferred: both need a
  separate network/credential contract; `fetch_url` covers reading a known URL,
  and no evidence in this repository shows a database task.
- *Add a git commit tool.* Rejected: committing remains the repair lane's and
  the owner's job; the worker gets status/diff/log only.

**What was given up.** Only allowlisted commands run: no one-off `node -e`, no
`git clone`, no package installation. The owner edits `agent-exec.json` to add a
command, which is a deliberate act. `run_command` is declared `write`, so a
read-only step cannot run tests; the step must be `reversible_write`. The
sandbox confines writes to the workspace, temp directories and the package
caches, denies network and denies the protected roots; a test that needs the
network or writes outside fails, and on Linux or Windows the runner refuses by
default. `sandbox-exec` is deprecated; if a future macOS removes it, the runner
refuses until a replacement sandbox is wired. Output is a 100 KB tail, so a
very large log is truncated. The detected command list is a heuristic; the
owner reviews the JSON.

**Evidence.** `src/authority/seatbelt.ts` builds the profile and
`wrapWithSandbox`; `/usr/bin/sandbox-exec` is present, and
`sandbox-exec -p '(version 1)(allow default)(deny network*)' /bin/echo sandbox-ok`
printed `sandbox-ok` on 2026-11-23. `src/repair/repair-lane.ts` states the worker
has no shell and the lane runs the suite and typecheck; `src/repair/gates.ts`
runs tests through an injected runner. The new `test/agent-exec-mcp.test.ts` is
**17/17**: declarations, config validation, command detection, a real allowed
command, a non-allowlisted command, the sandbox refusal, a denied write outside
the workspace and inside `.git`, the timeout and the output cap. The live
macOS sandbox is exercised, not assumed. The first probe let a `.git` write
through because the temp workspace's `/var` spelling did not match the kernel's
`/private/var` path; `agentExecSandboxProfile` now resolves the workspace with
`realpathSync`, and the test asserts the write is denied. `npm test` is
**991/991**, `npm run typecheck` exits 0 and `npm run gate` is **PASS** with the
baseline unchanged; the commands are recorded in the optimization log.

**Reversal condition.** If the allowlist is too narrow for real bug fixing — the
owner repeatedly needs a command that is not in `agent-exec.json` — implement
the shell-scope/`execute`-risk contract instead of widening the allowlist to
arbitrary argv. If `sandbox-exec` is removed or breaks common test runners,
remove the `agent-exec` entry from `mcp.json` until a replacement sandbox
exists. If the tools produce more unsafe or incorrect calls than useful ones,
remove the entry. If a maintained MCP SDK or a sandboxed exec domain arrives,
replace the hand-written server rather than growing it.

## 2026-11-22 — A bundled local MCP server fills the worker's search, git, date and web gaps

**Decision.** Add one owner-installed stdio MCP server, `agent-tools`, that a
native worker opts into through `mcp.json`. It exposes seven tools:
`search_text` and `find_files` (read; recursive literal/regex search and glob
discovery in the workspace), `git_status`, `git_diff` and `git_log` (read;
`execFile` only, never a shell), `current_time` (read; ISO/local time and time
zone), and `fetch_url` (network; HTTP(S) GET with private-address refusal,
redirect re-validation and a response cap). The installer copies a
self-contained server into the clone home and merges the `agent-tools` entry
into `mcp.json`; every other server is preserved. No write tool and no shell
tool are declared. Both tools that take a path declare a `pathField`, and the
server itself skips the protected roots and symlinked directories while
walking, so a search rooted at the home directory is not a way around the
protected-location rule.

**Why it won.** The native worker's built-in surface is exactly four file
tools — `read_file`, `list_directory`, `write_file`, `edit_file` — asserted in
`test/mcp.test.ts`; it cannot find a symbol across files, see a diff or a
commit history, learn the wall-clock date, or read a documentation URL. The
repair lane's own log records 12 of 31 rounds spent reading files before it
began pre-extracting defect locations (`src/repair/repair-lane.ts`);
`read_file` returns a 400-line window and the loop caps a tool result at 8,000
characters, so finding a symbol by repeated reads is the expensive path this
replaces. The Main Agent is deliberately tool-less for files
(`src/main-agent/prompt.ts` says so), so a missing capability belongs on the
worker. The parity study lists
Glob, Grep, WebFetch and WebSearch among Claude Code's canonical tools
(`docs/study/claude-code-parity.md` section 2.2); this bundle closes the
search, discovery, web-read and date gaps without adding the shell. MCP is
already the intended second tool source (`src/workers/mcp-client.ts`): a
server is disabled unless `mcp.json` says `"enabled": true`, every tool needs a
declared risk, path-taking tools are checked per call, and output is framed as
untrusted observation. The browser integration already establishes the
installer-and-declaration pattern (`src/integrations/browser-mcp.ts`). One
server keeps the cost to one opt-in entry and one child process, and the tools
share one workspace root and one output convention.

**Alternatives rejected.**

- *Implement these as built-in worker tools.* They would be offered to every
  worker and every step, including steps that need neither git nor network;
  the MCP path keeps them opt-in and lets `mcp.json` remain the authority for
  each tool's risk. The cost accepted instead is one child process and JSON-RPC
  framing.
- *Use the Python reference servers (`mcp-server-git`, `mcp-server-fetch`).*
  They add a Python/uv runtime dependency and do not know clone-ai's per-tool
  risk declarations or protected-path rule. Their package names and behaviour
  are assumed as of 2026-11-22; no live install was measured.
- *Declare a generic filesystem MCP.* Skipped: it duplicates the four built-in
  file tools, and a generic server's write path would not understand the
  step's write roots or the `.git` write guard (`decideTool`).
- *Declare a memory MCP.* Skipped: clone-ai already has a reviewed memory
  pipeline (`recall_memory`, `read_memory`); a second, unreviewed memory store
  would split memory authority.
- *Add sequential-thinking MCP.* Skipped: no verified gap. The loop, plan
  proposal and the model's own reasoning already provide structure, and the
  tool produces no executable evidence. This judgment is an assumption, not a
  measurement.
- *Add a shell or `run_command` tool.* Deferred: `decideTool` refuses
  `external`, and no worker-facing sandboxed exec domain is wired. A shell
  server would either be refused or widen authority. Revisit when a
  Seatbelt-backed exec domain is available to workers.
- *Add GitHub, Slack or Notion MCP.* Deferred: the MCP client has no OAuth
  flow and only forwards environment names a server declares. Without an
  owner-configured token these servers cannot authenticate. Revisit when a
  token is configured and a task needs the service.
- *Add web search MCP.* Deferred: a search provider needs its own API key.
  `fetch_url` covers "read this known URL", which is the documented need.
  Revisit when a search key is configured.
- *Add SQLite or another database MCP.* Skipped for now: no evidence in this
  repository of data work that needs a database; adding it now would be
  speculation. Revisit only on an explicit owner request with a read-only
  database role.
- *Add chrome-devtools MCP.* Deferred: it overlaps the existing Playwright MCP.
  Its extra value is performance traces and network inspection, and no current
  task needs them. Revisit on a performance task.
- *Ship `current_time` as its own server.* Rejected: a one-function server
  costs more configuration and process overhead than one tool in this bundle.
- *Inject the date into every step instruction instead.* Rejected: the Kernel
  already holds the clock, but injection still cannot answer an explicit "what
  time is it" or a time-zone conversion request, and it changes every step's
  prompt; one opt-in read tool costs one schema. This is the weakest of the
  seven additions and is marked as an assumption, not a measured gain.

**What was given up.** The server is a child process per worker step; a step
that calls no tool pays only lazy startup and the tool-table tokens. The tools
are not available to the Main Agent (by design) and not to providers that
cannot take MCP configuration. `fetch_url` is GET-only, sends no credentials,
refuses private addresses, and caps the body; a page behind a login or a POST
API is out of scope. It is offered only to a step that already carries a
network scope: the all-or-nothing network grant is unchanged, so an ordinary
read-only or reversible-write repair step still cannot use it. Making
documentation lookup available there would need a separate read-only-network
contract, which this entry does not introduce. Git is read-only in effect, not
only in intent: `--no-optional-locks` and `GIT_OPTIONAL_LOCKS=0` stop index
refreshes, `--no-textconv` and `--no-ext-diff` stop repository-configured
helpers from running, `core.fsmonitor=false` stops the fsmonitor hook, and a
revision that starts with `-` is refused before git can read it as an option.
Committing remains the repair lane's job, not a worker tool. Search resolves
the root before walking, so a symlink into `~/.ssh` is refused even when the
link's own name is outside; a query over 500 characters, a line over 20 KB, and
a walk over 100,000 entries are bounded. Search and discovery skip `.git`,
`node_modules`, build output, binary files and the protected roots, so a match
inside a skipped tree is not found; the skip list is a constant, not
owner-configurable. The installer pins the node path, so rerun it after a Node
upgrade, as with the daemon installer. DNS rebinding between the address check
and the request is not fully prevented; the network grant and the opt-in server
are the accepted boundary.

**Evidence.** `test/mcp.test.ts` still asserts the built-in-only four-tool
table and the risk gate. The new `test/agent-tools-mcp.test.ts` starts the
server as a real child, calls `tools/list` and `tools/call`, exercises search,
discovery, git and time, asserts the fetch refusals (private host, non-HTTP
scheme, embedded credentials), and checks that every declared tool has a risk
and that no write or shell tool is declared. Before this change neither the
server nor its test existed. The live network path is exercised only through an
injected fetch in the test; no public URL was called, so live network behavior
is marked assumed. `npm test`, `npm run typecheck` and `npm run gate` are
recorded in the optimization log.

**Reversal condition.** If the child process or the added tool-table tokens
measurably slow a step, or if these tools produce more wrong or unsafe calls
than useful ones, remove the `agent-tools` entry from `mcp.json` — the server is
opt-in — and move only the surviving tools into the built-in table. If no step
ever carries a network grant, remove `fetch_url`; if a read-only-network
contract arrives, revisit it. If a maintained MCP SDK or a sandboxed exec
domain arrives, replace this hand-written server rather than growing it.

## 2026-11-20 — The effort picker offers the known vocabulary, marked by what the model declared

**Decision.** The composer's effort picker no longer shows only the levels the
selected model advertises. It offers the known vocabulary — `none`, `off`,
`minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra` — with the model's
declared levels first under "模型声明" and every other known level under
"其他已知 · 可能映射". Each option is labeled in Chinese with the provider
spelling (`低 · low`), so the owner can see both the meaning and the exact value
sent; a chosen undeclared level also shows a small "Provider 可能映射" caveat
beside the closed select, where the group label is no longer visible. When the
gateway declares no levels for the model, the picker shows one "已知 · 模型未声明"
group instead of pretending a declaration exists. A saved level outside the
vocabulary still appears as the current choice. The choice is saved exactly as
rendered, so a mapped level cannot be silently cleared on the next change. The
server's `EFFORT_LEVELS` and its self-review whitelist are unchanged: this is a
picker contract, not a change to what a turn accepts.

**Why it won.** The owner's screenshot showed the default model
(`deepseek/deepseek-v4.1-flash`) with only four rows: 使用模型默认, low,
high, max. The gateway reports exactly those three levels for that model
(`/v1/models`), while other models it lists declare up to seven —
`low/medium/high/xhigh` for Gemini 4 Hydrogen and
`none/low/medium/high/xhigh/max/ultra` for GPT-6.1 Terra. A direct probe of the
gateway with the default model and an undeclared `reasoning_effort` returned
HTTP 200 with a reasoning answer for `medium`, `minimal`, `xhigh`, `ultra`,
`none` and `off`. The short list was therefore a discovery artifact, not a
provider limit, and the picker had been hiding levels the provider accepted.

**Alternatives rejected.**

- *Keep only the gateway-declared levels.* This is the current state the owner
  reported as too narrow; the probe shows it is also stricter than the provider.
- *Show extra levels without marking them.* The owner could not tell a declared
  level from one the provider may map or ignore. The group name and the closed-state
  caveat are what mark it.
- *Call the second group "supported".* The probe proves acceptance, not that the
  provider honors the request; "可能映射" is the truthful label.
- *A free-text effort field.* It moves validation and discovery errors into the
  turn, and the owner loses the useful labels; the vocabulary is small and known.
- *Expand the server's `EFFORT_LEVELS` and the self-review whitelist too.* The
  self-review is a conservative proposer, and `normalizeEffort` already forwards
  any bounded name; widening those lists would change a different contract for
  the picker's sake.

**What was given up.** An undeclared level is a request, not a guarantee: the
provider decides whether to honor or map it, and a refusal reaches the turn as
a normal failure. The picker shows the provider spelling rather than localized
names alone, because the name is what is sent. The list is longer (up to ten
rows), so the open dropdown is no longer a glance; the declared group stays first
so the safest choices are still at the top. The closed-state caveat costs one
short line whenever a mapped level is selected.

**Evidence.** `/v1/models` from the local Magpie gateway (11 models, per-model
`reasoning_levels`); the probe above (`POST /v1/chat/completions`, `max_tokens`
1, six undeclared levels, all 200); the owner's screenshot; the new structural
test asserts the two groups, the labels and the option count for a model that
declares `low/high/max`.

**Reversal condition.** If undeclared levels routinely produce failed or
degraded turns for the default model, restrict the picker to declared levels
again. If the gateway starts reporting a per-model default effort, show that
value next to 使用模型默认. If a provider rejects an undeclared level at the
gateway boundary with a local error, the group can stay but should say which
levels are refused.

## 2026-11-20 — A backlog of failed follow-ups is one row, not a wall

**Decision.** Two or more `failed_task` opportunities collapse into one summary
row above the conversation: a warning icon, "任务跟进", the count, the newest
failure's title (with the shared "任务需要跟进：" prefix removed), and an
expand control. The cards themselves stay in the DOM inside
`#opportunity-failure-cards`, hidden until expanded, so `aria-controls` resolves
and the toggle flips `hidden` in place without moving keyboard focus. The
expanded list scrolls inside the strip when it outgrows the viewport. A single
failure still renders its card: one alert is information. Non-failure
opportunities (deadlines, goals, observations) stay visible while failures are
collapsed, because they are things to act on rather than backlog. The expanded
failure card also says the same thing once: its title drops the prefix the chip
already names, its `whyNow` replaces the raw ISO stamp with the owner's local
date and time, and a trailing sentence is dropped only when it exactly restates
the title. Any structure the display helper does not recognise is kept as
written; the server prose is not rewritten.

**Why it won.** The owner's screenshot showed three near-identical failure cards
occupying 205 px of a 1080 px window (y=84–279) before the conversation began;
the date divider and the turn head were pushed to y≈308 and y≈415. The cards
repeated the same "任务跟进" chip, the same title prefix and a `whyNow` sentence
that ended by restating the title, and each carried the same three buttons. The
summary row measures 40 px and the conversation now starts at y≈124 — 155 px
returned to the reading area — while the count and the newest failure stay
visible and all actions are one click away.

**Alternatives rejected.**

- *Keep every card visible.* That is the 205 px backlog the owner reported as
  uncomfortable, and it makes the first screen read as an inbox instead of a
  conversation.
- *Hide the failures entirely.* Their actions (查看原因, Agent 设置, 忽略) are
  the next step for each failure; hiding them would hide the work.
- *Collapse one failure too.* A single failure is information, not a wall; a
  summary row would add a click for no gain.
- *Use a `<details>` element.* The native marker and the need to style its
  summary as a card row add markup for no benefit; a real button with
  `aria-expanded` and `aria-controls` is the same disclosure in the app's own
  language, and it keeps focus in place.
- *Flatten the summary to a hairline row.* The opportunity strip's existing
  language is cards; a second visual grammar inside the same strip would make
  the non-failure cards look unrelated.
- *De-duplicate by parsing every possible card sentence.* The display helper
  only recognises the documented shapes: the source prefix, the ISO stamp and a
  trailing exact restatement. Anything else is kept as written, so a change in
  the backend's wording loses the de-duplication but never the information.
- *Convert the ISO stamp with a fixed timezone or leave it raw.* Local time is
  what the owner reads; an invalid date falls back to the raw stamp rather than
  throwing.

**What was given up.** A failure is one click away instead of on screen. The
summary must carry the count and the newest title accurately, or it lies about
what is behind the click. An expanded backlog can scroll inside the strip; a very
long list is bounded by that scroll rather than by silently dropping cards. The
summary row is a new element in the strip, with its own focus ring and chevron.

**Evidence.** Before/after measurements from the working-tree fixture at
1468×1080 with the owner's real conversation data: `.opportunity-strip` 205 → 50
px, `.opportunity-summary` 40 px, `.conversation` top 279 → 124 px. The
structural test renders three failure cards collapsed and expanded, checks the
count, the prefix removal, local-time replacement, exact-restatement removal and
the unrecognised-structure fallback, `aria-expanded`, the hidden wrapper, the
non-failure card staying outside the hidden wrapper, and the card actions.

**Reversal condition.** If the owner misses failures behind the summary, show the
newest failure card plus a summary for the rest. If the count and the expanded
cards diverge (the backend returns more cards than the strip renders), fix the
rendering before keeping the count. If the strip's own scroll feels wrong above
the chat, move the expanded list into a separate panel instead of growing the
strip.

## 2026-11-20 — The conversation reads as one quiet voice

**Decision.** Four small reading changes, all in CSS plus the turn markup:
the owner's bubble is 14 px / 1.7 with no "你" overline — right placement
identifies the speaker, and the bubble's existing padding, radius and fill are
kept; the turn's author, status word and time become one left-side byline
instead of a status stranded at the right edge, and the routine 完成 keeps its
green word and pin; the reply's prose is capped at a 620 px measure (~43
full-width characters), shared with the request bubble's maximum measure, and
the live streaming `.clone-text` gets the same cap so a settling turn does not
jump narrower; the composer's model and effort pickers become 25 px pills with
an 11 px value, a custom chevron and a more legible 10.5 px label, instead of a
10.5 px native select with no visible boundary.

**Why it won.** At 1468×1080 the before reply ran 754 px, ~52 full-width
characters per line; the reading lens measured the owner's bubble at 13.5 px and
the reply at 14.5 px, and the two adjacent blocks read as two type systems. The
"你" overline made a one-line request 61 px tall; the reply itself is the
speaker's evidence, and the owner's bubble no longer repeats it. The turn head's
green dot and 完成 sat under the request bubble's right edge, where they could
read as the request's completion; clustering the whole byline on the left
removes that misread without deleting a truthful status word. The 760 px prose
ran past the comfortable band and was wider than the bubble's own 620 px cap;
sharing the 620 px measure makes request and answer use one ruler. The
composer's 10.5 px select had no border until hover and looked like a footnote;
its value is now readable at a glance and the control looks like a control.

**Alternatives rejected.**

- *Remove the completed status word entirely.* The absence of a badge would be
  the signal, but it would remove truthful status information; the green word
  stays.
- *Keep the status and time as one right-hand group.* The reading lens showed
  the status could read as the request's completion; the byline belongs on the left.
- *Cap the prose at 660 px instead of 620 px.* 660 px holds ~45 characters and
  adds no line here, but it does not share the request bubble's measure; 620 px
  makes both voices read with the same ruler.
- *Keep the native select's platform arrow.* The app already draws its own
  chevrons for disclosure rows; one more would be a second arrow language.
  The pill's custom chevron matches those controls and lets the closed state
  carry its own boundary.
- *Shrink the type instead of narrowing the measure.* The 2026-11-19 trade-off
  names the measure as the lever; shrinking the type would trade comfort for
  line count.

**What was given up.** A narrower measure can add lines to long answers; tables
and code scroll sooner inside the reply. The green completion word remains the
reply area's only saturated color on a normal turn. The pill's custom chevron is
CSS rather than a platform control, so the closed state is worth checking in the
macOS window (the options popup itself stays native).

**Evidence.** Before/after measurements from the working-tree fixture at
1468×1080 with the owner's real conversation data: reply 760 px / 52 characters
→ 620 px / ~43; bubble 61 px → 46 px (14 px / 1.7, original padding); head text
"clone-ai 完成 14:13 · 66.1 s" with the whole byline at the left; composer value
10.5 px native → 11 px pill in a 25 px control. The structural test pins the
bubble, the left byline, the green completion, the 620 px measure and the pill
shape.

**Reversal condition.** If 620 px still reads too wide, try 660–680 px with a
multi-paragraph fixture; if long answers become too tall, restore 760 px and
shrink the type instead. If the green completion word is too loud, mute the word
and keep the pin. If the left byline loses a useful right-edge cue, move the time
back to the right while keeping the status beside the author. If the pill row
crowds the composer at narrow widths, fall back to the borderless select rather
than hiding the controls.

## 2026-11-20 — A verification failure says why, once

**Decision.** `CompositeVerifier` prefixes "Verification failed." exactly once,
stripping a sub-verifier's identical prefix before joining. `EvidenceVerifier
.checkFile` distinguishes four cases instead of one: a path outside the
authorized roots (or protected) says it is outside the roots this step may
verify; an existing directory says it is a directory, not a promised file; an
unreadable file says it exists but could not be read; only a truly absent path
says it does not exist. The existing assertion that pinned "does not exist on
disk" for an existing outside path is updated to the new message.

**Why it won.** The audit found the recorded `fa36a720` summary read
"Verification failed. Verification failed. …" and reported an existing directory
outside the root as "does not exist on disk". The failure reason is now what the
owner and the Main Agent read (the failed-run reason fix), so a missing
deliverable, an unauthorized path and a wrong file type must not look the same.

**Alternatives rejected.**

- *Keep one generic message for every failure.* It is the misleading text this
  entry fixes.
- *Stat the raw outside path to report whether it exists.* It would reveal
  existence outside the verifier's boundary; the outside-root message is enough.
- *Only fix the duplicate prefix.* The misleading reason would remain.
- *Add structured reason codes now.* The readers show prose; a code adds a
  contract without a consumer yet. It is the reversal condition below.

**What was given up.** A path that is both outside and a directory reports
"outside" rather than "directory". A protected location inside a root reports
"outside or protected". The messages are prose, not machine-readable; old traces
keep the text journaled at the time.

**Evidence.** The audit findings and the recorded summary. The lane's regression
case covers an existing directory, an outside-root file, a missing file and the
composite's single prefix; it is red on the current code and green after. The
existing `test/verification.test.ts` assertion is updated with the fix. Four lane
runs cost ~408 s / 52 model calls / 410,701 tokens; after the working agent
updated that one test contract, the worktree suite was **952/952**, typecheck 0,
gate PASS. Landed as `78006a9`; on main the targeted cases are **18/18**, the full
suite **956/956**, typecheck exit 0, gate **PASS**.

**Reversal condition.** If readers need machine-readable causes, add a
category/root field instead of parsing prose. If statting outside paths becomes
acceptable, report existence precisely. If a consumer relies on the duplicated
prefix, keep a structured summary instead of the prose.

## 2026-11-19 — The answer is the section; the 结果 gutter is retired

**Decision.** A turn's answer starts at the section's left edge. The 52 px
label gutter existed to separate 上下文 / 派发 / 结果 on one axis; only 结果
remains, so the gutter no longer reserves a column. The 结果 label is hidden in
the conversation, the reply (or the error) is set at 14.5 px / 1.75 in the full
reading measure, and the 依据 line becomes the section's footer: a hairline above
it, the counts at the left, and 查看审计 pushed to the right end. The same rules
cover the live streaming card and legacy history entries, because they share the
same `.log-step` container. The label stays in the markup, hidden, so a turn
that regains in-place steps can restore the gutter by rule instead of rebuilding
the markup.

**Why it won.** The owner's 2026-11-19 screenshot of a stopped turn (three failed
runs, a long reply in a 52 px shaft) came with "这种展示不好看". The turn had just
lost its 产物 rows to the change recorded in "The sidebar is conversations only;
run detail lives in the audit"; what remained was a 13.5 px paragraph indented
into the gutter, then a 10.5 px 依据 line with the audit control buried among
its facts — the silhouette of a build log holding one line of content. Once the
runs left, nothing was left for the gutter to separate: it only narrowed every
answer by 64 px and labelled the obvious. The label stays as markup because the
history and live paths share it; hiding it in CSS is one reversible rule and
keeps those paths single-sourced.

**Alternatives rejected.**

- *Keep the gutter, enlarge the reply inside it.* The 64 px loss and the label
  remain; an empty 52 px column beside one paragraph is the log look itself.
- *Remove the label from the markup and restore it if steps return.* Three paths
  (turn, history, live card) share the step container; deleting the label means
  editing all three and the test that pins history, for a visual rule a single
  selector already expresses.
- *Put 依据 on its own row without a rule.* It then reads as one more small
  line under the answer. The hairline is what makes it the section's close; the
  right-aligned control gives the footer an end.
- *Shorten the 依据 facts to make room for the link.* The counts are the grounds
  the owner asked to keep ("都要有论据"); placement must not drop them.
- *Wrap the whole answer in a card again.* The card was removed deliberately on
  2026-11-19 ("The transcript separates a turn, a task update and a child run by
  structure"); the fix is type and rhythm, not a container.

**Evidence.** Before: `.log-step` was a 52 px + 1 fr grid, `.log-reply` 13.5 px /
1.68, and `.log-basis` 10.5 px with no rule and the audit link inline after the
facts. After, measured in the browser at 1240×900: `.log-step` computes to a
760 px single column, `.log-reply` 14.5 px, `.log-basis` a 1 px top rule, and
`.log-basis-open` is pushed to the column's end. The same four states were
rendered at 1240×900 and 720×900: a completed answer with a heading and list, a
failed turn with the error block and 下一步, a legacy history entry, and the
owner's stopped-turn shape. `test/ui-structure.test.ts` pins the final layer:
one-column `.log-step`, hidden `.log-step-label`, 14.5 px reply, footed 依据 with
a top rule, and `margin-left: auto` on the audit control.

**What it costs.** The answer has no visible "结果" label; the author overline
and the top rule name the level instead. A long reply is wider and slightly
larger, so it occupies more vertical space. The audit link sits at the far right,
further from the counts it explains, and on widths near 640 px the footer wraps
with the link on its own line at the right. The label remains in the DOM as dead
markup for readers of the source until the live/history paths stop sharing the
step container.

**Reversal condition.** If a turn regains in-place steps (上下文 / 派发 return to
the conversation), restore the gutter and show the labels. If the missing 结果
label makes the section ambiguous, name the level in the head overline instead of
re-adding a gutter. If the wider measure makes long answers hard to scan, cap the
reply's measure near 68 cjk characters rather than shrinking the type.

## 2026-11-19 — One runtime per clone home: dev mode takes the LaunchAgent down, a second sidecar refuses to start

**Decision.** `npm run desktop:dev` boots the `ai.clone.companion` job out of the
user's GUI domain for the dev session and bootstraps the same plist back when
the driver exits. Independently, `startCompanionServer` takes a directory lock
(`companion-runtime.lock`) inside the clone home before it hydrates the journal
and refuses to start while another live process owns it, naming the owner's pid.

**Why it won.** The dev driver's only exclusion was `pkill` on
`src/desktop-sidecar.ts`. launchd's `KeepAlive` restarts that job — the unified
log records `service inactive: ai.clone.companion` at 16:37:11, 16:55:47,
17:38:55 and 17:41:50 on 2026-11-19, and the 17:41:50 restart coincides with the
dev driver's child app spawn and a new daemon that published at 17:41:52 — so
the dev app's own sidecar always became a second writer on the owner's home. At 17:44 `ps` showed the launchd daemon (pid 46832)
and the dev sidecar (pid 53933) both alive; `companion-endpoint.json` named
53933 and `main-agent-turn-owner.json` was claimed by it too. When the dev
sidecar closed, `clearCompanionEndpointIfOwned` deleted that file although 46832
was still serving. A packaged window then read no endpoint, waited 120 × 0.5 s,
and showed the reported card, "launchd 没有在 60 秒内发布端点" — the screenshot is
timestamped 17:38:59. The daemon republished at 17:38:55, when launchd recorded
the old instance inactive and spawned a new one; the window recovered on its
30-second retry. A deterministic
reproduction (two servers on one temporary home) repeats the sequence: A
publishes `:64237`, B overwrites with `:64239`, B `close()` removes the file,
and A still answers `/api/health` with 200.

**Alternatives rejected.**

- *Keep `pkill` as the exclusion.* launchd restarts the killed job before the
  dev app has finished launching; the two-writer state is then guaranteed, not
  accidental. This is the mechanism that produced the report.
- *Accept two sidecars and republish the endpoint on a heartbeat.* It addresses
  the symptom only: two schedulers, two turn-owner claims and two journal
  writers remain — the condition behind the 2026-11-18 raced
  `failed -> verifying` transition.
- *Give the dev driver its own clone home.* UI work has to see the owner's real
  conversations, tasks and memory; an empty home hides the state being
  developed and reintroduces the "tasks vanished" confusion the preview-home
  removal already fixed.
- *Wait for the lock instead of refusing.* A second daemon that blocks would
  start later behind the app's back and claim the turn ledger mid-session.
  Refusing is visible at once in the window's stderr and the daemon log.
- *Pause only the dev sidecar's writes.* Partial exclusion still leaves two
  processes serving `/api/*`; the window could attach to the wrong one.

**What was given up.** While `desktop:dev` runs, the resident twin is unloaded,
so a packaged launch during that time starts a private runtime (the LaunchAgent
is absent from launchd's domain). If the driver is SIGKILLed, the job stays
unloaded until login or a reinstall; the plist stays on disk, so login restores
it and `node scripts/install-daemon.mjs` restores it sooner. A second manual
sidecar on a live home now exits with an error instead of starting — deliberate,
and the error names the owning pid.

**Evidence.** `ps` showed 46832 (launchd) and 53933 (child of the dev app) both
running; `companion-endpoint.json` named `http://127.0.0.1:63042` pid 53933 while
46832 answered health; `main-agent-turn-owner.json` named 53933. The launchd log
(`log show --predicate 'eventMessage CONTAINS "service inactive: ai.clone.companion"'`)
lists the restarts. The two-server reproduction and the red regression test are
`test/companion-singleton.test.ts`. The repair lane could not take this defect:
its trigger is a failed Run trace, and this failure happens before any run
exists (the same gap recorded for the 2026-11-19 effort fix); the owner approved
the direct patch. Live after the fix (18:29–18:33): the job was absent from
launchd's domain while the dev session ran, exactly one sidecar owned the
endpoint and the turn ledger with `/api/health` 200, and stopping the driver
restored the job and started a new daemon.

**Reversal condition.** If launchd gains a supported "pause KeepAlive without
unloading" or the app can hand the job to the dev driver without bootout,
replace the bootout. If a legitimate workflow needs two sidecars on one home
(for example a read-only companion), give that process a separate home or a
read-only mode; do not remove the lock. If the lock ever blocks a test or tool
that intentionally shares a home, that path must be given its own home, not an
exception in the daemon.

## 2026-11-19 — The sidebar is conversations only; run detail lives in the audit

**Decision.** The sidebar no longer nests the Runs a turn dispatched. A
conversation is one row — the main conversation pinned first, then today and
earlier — with no `N 个任务` summary and no child rows; runs with no
conversation (scheduled, repair, opportunity) no longer appear there either.
The one exception is a task waiting for the owner: it stays in the 需要你处理
section, because a decision that is invisible is a decision missed. The
conversation pane drops the 产物 rows that listed spawned runs; each turn keeps
its reply and the one-line 依据 with 查看审计. Every run stays reachable in
设置 → 审计与轨迹, whose record list already opens a run's session.

**Why it won.** The owner's 2026-11-19 report, reading a conversation with three
failed runs: "只显示主对话…子agent怎么执行任务的都放在审计里面…这样太乱了，
最后都不知道哪个是哪个，每次对话只有返回结果". The 2026-11-19 entry "The
sidebar's top level is the conversation, and tasks nest inside it" made each
dispatched run a child row; with several runs per turn the sidebar became a
process log, and two runs with similar titles were indistinguishable. The audit
already lists every execution record with 查看记录, so the detail has a home.

**Alternatives rejected.**

- *Keep nesting but collapse by default.* The summary line ("3 个任务 · 3 个失败")
  still changes every turn and still counts runs the owner cannot tell apart;
  the clutter is the count, not the expansion.
- *Keep only failed runs as children.* Which runs appear would change with
  status, so a task's position would move, and two similarly named runs would
  still be ambiguous.
- *Drop the 需要你处理 section too.* The opportunity strip only carries
  failed/cancelled cards, so an approval would wait with no visible entry point.

**What was given up.** Opening a run from the conversation requires the audit.
The sidebar no longer shows how many runs a conversation spawned or any
background run with no conversation; the conversation no longer shows run ids
inline. A hidden conversation's restore row no longer reports its task count.

**Evidence.** `test/regression/ui-sidebar-hidden-restore.test.ts` renders the
sidebar sandbox: before, a conversation's running and waiting tasks appear as
`data-test-session` rows and the count includes them; after, the running and
scheduled tasks are absent, the waiting task appears once under
`session-group-needs`, and the count is conversations plus waiting tasks.
`test/ui-structure.test.ts` asserts the sidebar source has no
`session-children`, no `session-group-auto` and no `data-child-group`, and the
turn log has no `data-log-run`. `npm test` 934/934, `npm run typecheck` exit 0,
`npm run gate` PASS.

**Reversal condition.** If owners cannot find a running or scheduled run, add a
status filter (or a dedicated 运行 view) in the audit rather than re-nesting runs
in the sidebar.

## 2026-11-19 — Reasoning effort is whatever the gateway declares, not a fixed seven

**Decision.** The per-turn `effort` field and `PATCH /api/config`'s
`mainAgentEffort` accept any non-empty reasoning-effort name (trimmed, at most
64 characters) instead of only the seven values in `EFFORT_LEVELS`. The
gateway's per-model `reasoning_levels` is the authority for what a model
accepts; the known list stays as the picker's fallback when the gateway
declares nothing and as the self-review proposal filter. `effortChoices()` is
deleted: its "narrow to levels we understand" rule was the rejected design.

**Why it won.** The composer and Settings pickers already list exactly what the
gateway declares (`reasoningLevelsFor`), and the gateway declares more than the
known list: `openai/gpt-6.1-terra` declares
`none, low, medium, high, xhigh, max, ultra`. The server rejected `none` and
`ultra` with HTTP 400 at `src/companion-server.ts:144` / `:1131`, so the owner
could pick a level the model advertises and get a refusal. The composer
picker's own trade-off already treats the provider as the authority for the
model id ("the picker accepts any non-empty model id; the provider remains the
authority"); effort now follows the same rule.

**Alternatives rejected.**

- *Narrow the picker to `effortChoices()`.* It drops `none`/`ultra` for models
  that declare them — the opposite of what a picker driven by the gateway is
  for — and makes the app's list the arbiter of an external service's
  vocabulary.
- *Extend `EFFORT_LEVELS` with `none` and `ultra`.* It hard-codes today's
  gateway names; the next level a provider adds breaks it again.
- *Ask the gateway inside the request path.* A network call per turn, and a
  down gateway would turn a valid level into a 400 — the same mismatch in a
  worse place.

**What was given up.** A hand-edited `config.json` or `CLONE_AI_MAIN_EFFORT`
can now carry a level no model declares; the gateway is lenient (every probed
level returned 200) and may ignore it silently. The turn ledger still records
the effort, so the audit shows what was asked for.
`test/companion-config-api.test.ts`'s "rejects an unknown effort" assertion is
replaced by the opposite contract.

**Evidence.** Live gateway (`curl 127.0.0.1:3425/v1/models`): eleven models
declare 3–7 levels each, including `none` and `ultra` (both on terra);
`reasoning_effort` set to `off`/`ultra`/`medium`/`xhigh`/`minimal` across three
models returned 200 every time, so no provider-level rejection exists to catch.
Before the change `POST /api/main-agent/stream` with `effort: "ultra"` returned
400 `effort must be one of off, minimal, low, medium, high, xhigh, max`; after
it reaches the provider body as `reasoning_effort: "ultra"`.

**Reversal condition.** If a provider starts failing an unknown effort in a way
the owner cannot see, validate against that provider's declared levels, queried
once per turn and cached, rather than restoring a fixed list.

## 2026-11-19 — 新请求 is the only creation entry; the main conversation is a pinned row

**Decision.** The sidebar's 对话 button beside 新请求 is removed. 新请求 stays the
only creation action and keeps the router. The main conversation becomes a pinned
first row of the conversation list — labeled 主对话 from the existing
`session-group-main` string, without a hide control — and the tasks its turns
dispatched nest under it like every other conversation's children.
`buildDashboard` emits the main conversation as a `kind: "conversation"` row once
it has a turn, a dispatched task, or legacy history on disk, so an empty home has
exactly one talk entry; `renderSessions` pins the row above 今天/更早. A hidden
main conversation stays hidden and offers the existing restore control. Deleting
the main conversation from the UI is refused.

**Why it won.** The two stacked controls read as the same action. 新请求 opens a
blank conversation surface; 对话 opens the main conversation, and `renderSession`
renders the same welcome surface when the thread has no visible turn log
(`apps/desktop/ui/app.js:2377`, `welcomeMarkup` at 1777). The owner's 2026-11-19
report is that the difference needs explanation. The runtime already claims one
top-level row kind — a conversation (the 2026-11-19 "The sidebar's top level is
the conversation" entry) — and the main conversation was its only exception,
carried by a dedicated control that duplicated the list's navigation.

**Alternatives rejected.**

- *Keep 对话 and drop 新请求.* A message typed in the main thread continues its
  history; a fresh goal would no longer reach the router that starts a new Main
  Agent (added in `fabd3c1`). The capability would be lost, not merged.
- *One 对话 button with a 新请求 action inside the conversation top bar.* Both
  capabilities survive, but creation moves into the content and remains a second
  control that is less discoverable than a row in the list.
- *Keep 新请求 and add a 主对话 history link on the welcome surface.* The second
  sidebar control disappears, but the main thread becomes reachable only through
  新请求 → link (two clicks) and has no row where every other thread lives. The
  owner opens the welcome to start work, not to navigate.
- *Make the existing 主对话 group header clickable.* The header exists only when
  the main conversation dispatched tasks; a main thread with only direct answers
  would have no entry.
- *Always show a 主对话 row, even on an empty home.* It would open the same
  welcome surface as 新请求, recreating the duplication this merge removes.
- *Sort the main row by recency like every other thread.* It is the purest one-row
  shape, but the owner's original thread then falls under 更早 and, on a busy
  home, toward the bottom of the list; the fixed entry is lost. Pinning keeps the
  entry stable while the row stays a row.
- *A split or dropdown control.* The owner must still know which half to press;
  the two labels remain.

**What it costs.** On a home where the main conversation has content, one more
pinned row and +1 in the 最近 count; the fixed label hides the thread's topic, so
the preview has to carry it; the main conversation can no longer be hidden from
the UI (its × is omitted and `deleteSession` refuses it); its children are capped
together with the row; and a startup with no saved selection may now open the main
conversation because it is part of `sessions`. The row's preview comes from the
turn ledger, so a legacy clone home whose main history predates the ledger shows
此前的对话记录 rather than a preview until the thread is opened. Clicking the row
while a new request is being typed still drops that text, exactly as clicking any
conversation row from the welcome already does; that draft path is a separate
change.

**Reversal condition.** If owners report that the pinned row reads as an action
again, or that a blank request state must be reachable without a row, restore a
separate 对话 entry — never a button and a row for the same thread at once.

## 2026-11-19 — A failed run's lesson must cite the failure

**Decision.** A memory of type `procedure` mined from a failed run is accepted
only when at least one of its cited evidence items records a failure (an error,
a failed test, a missing file, a denied or timed-out call, a regression). The
mining prompt marks those evidence lines `[failure]` and says that no marked
line means no lesson. Every mined summary, failed or not, is also told not to
restate or paraphrase the parent task. The rule is enforced in the pipeline, not
only in the prompt: a lesson that cites only successful observations is dropped
and journaled with its reason.

**Why it won.** Run `16494863…` failed because `README.md` did not exist. Its
only recorded evidence was a successful `list_directory` of `/Users/user/.clone`;
the miner still wrote "下次应先直接读取当前工作区根目录的 README.md，而不是列出
/Users/user/.clone…" as a procedure citing that listing, and it became
`mem-81aab49b-a11`. Re-running the exact inputs against the same prompt on
2026-11-19 produced a task-restating procedure in **2/2 fresh samples**, in two
different wordings; the stored memory is a third. The same prompt on the same
inputs as a *completed* run returned only the durable preference (2/2), so the
defect is the failed-run branch, not the prompt as a whole. The prompt already
said "if the evidence shows no clear cause, return []"; 3/3 outputs ignored it,
which is why a deterministic backstop is needed.

**Alternatives rejected.**

- *Rely on the existing prompt instruction.* It was present in all three bad
  outputs; the model treated the work order as the cause.
- *Add a paraphrase-similarity rule to `restatesTaskObjective`.* The recorded
  candidate covers 0.54 of its terms from the objective; the deliberately kept
  `paraphrased-objective` gate case covers 0.74. Any threshold that catches the
  first also drops the second, and the gate keeps paraphrases on purpose. The
  evidence rule tests a fact about the run, not a wording guess.
- *Record failed tool calls as evidence so a lesson can cite the real `ENOENT`.*
  That is the better long-term source, but a failed observation could satisfy a
  promised observation at verification. Deferred until evidence carries an
  outcome the verifier cannot count as success.
- *Mine only completed runs.* It loses the lessons the failed outcome exists to
  capture.
- *Auto-archive the existing memory.* It was owner-approved; archiving is the
  owner's decision, so the fix only prevents new ones.

**What it costs.** A failed run whose cause exists only in tool errors or the
verification verdict (no evidence line records it) now yields no lesson. That is
a deliberate false negative: a missing memory is cheaper than a confident wrong
one. Existing memories are not touched.

**Reversal condition.** When failed tool results or verification failures are
recorded as citable evidence with a distinct kind that verification cannot count
as a successful observation, relax the citation requirement and let lessons
cite them. If a benchmark shows the rule drops more useful lessons than it
prevents, revisit the citation requirement rather than loosening it silently.

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
(`16494863…`) showed the worker listing `/Users/user/.clone` and reading
`/Users/user/.clone/README.md`; that is the hidden-folder confinement the owner
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

## 2026-11-19 — Model and effort are chosen in the composer per conversation

**Decision.** The composer gains two pickers next to the send box — model and
reasoning effort — and the choice travels with the turn: `POST
/api/main-agent/stream` and `/api/main-agent/query` accept an optional `model`
and `effort`, which override the persisted `config.json` value for that one
turn. The desktop remembers the choice per conversation in localStorage. Turns
without an explicit pick (the main conversation, a routed continuation, WhatsApp
and scheduled turns) use the configured default model (`mainAgentModel`, set by
the Magpie gateway's own 使用此模型 action or the environment) and send no
`reasoning_effort`, so the provider default applies. The Settings page no longer
shows model or effort controls: the owner asked for one place to choose, and the
composer is that place; the gateway card on the Agent page still binds the
default endpoint model. The effort list comes from the gateway's declared
`reasoningLevels` for the selected model, with the known level list as the
fallback when the gateway declares none. Wiring the override exposed that the
Main Agent read `mainAgentEffort` and recorded it in the turn ledger but never
put `reasoning_effort` in the provider request; the request now carries it, so
the existing setting (and the new picker) actually changes the reasoning budget
instead of only the audit row.

**Why it won.** Effort is a property of the request, not of the installation: a
quick lookup should not force the same reasoning budget as a refactor. With the
choice only in Settings, changing it for one task silently changes WhatsApp and
scheduled work too. The owner named Claude Code desktop as the reference, where
the model/effort picker sits in the composer and a choice belongs to the
session; this change mirrors that placement. After seeing the first version,
the owner asked to remove the Settings model/effort rows entirely: the
composer's empty option said "follow Settings", which pointed at a value hidden
in another dialog, and two control surfaces made it unclear which one wins. The
owner's request and screenshots are the evidence for the placement; the
follow-up is the evidence for removing the duplicate; the code path
(`readMainAgentEffortPreference` reads only env/config once per turn) is the
evidence that no per-turn override existed.

**Alternatives rejected.**

- *Keep the Settings rows as defaults (the first version).* The owner rejected
  it after using it: "follow Settings" referred to a value in another dialog,
  and two places looked authoritative. Removed at the owner's request; the
  default model is still set where the gateway is bound, and the effort default
  stays in config/environment.
- *Make the composer pickers write `config.json`.* One conversation's cheap-model
  choice would silently change every other surface, and the composer and the
  Settings page would compete over the same value with no visible winner.
- *Persist the choice on the server now, keyed by conversation.* It needs a new
  preference store, a read API and a migration for one desktop interaction;
  localStorage already holds per-conversation UI state (selected session, child
  groups), and no other surface needs the choice yet.
- *Guess the effort levels instead of asking the gateway.* Rejected already in
  `src/workers/effort.ts`: the gateway reports what each model accepts, so the
  picker lists only declared levels and otherwise falls back to the known set.
- *Keep a second copy in Settings labeled "default".* That was the first
  version; the owner asked for a single place. The composer's empty option now
  means the configured default model and the provider-default effort, and the
  note says the pick is saved with the conversation.

**What was given up.** The per-conversation choice lives in the desktop's
localStorage: clearing site data or opening the same data directory in another
client reverts to the configured default, and WhatsApp/scheduled turns never see
it. The desktop has no control for the default effort of turns without a
composer: it comes from `CLONE_AI_MAIN_EFFORT` or a self-review action that
writes `mainAgentEffort`. The default model remains settable through the gateway
apply action; without it, it comes from the environment. A conversation can
change models mid-thread; history carries over, so the new model sees the old
transcript (the turn ledger records `modelId` and `effort` per turn, so the
audit can explain it). The picker accepts any non-empty model id; the provider
remains the authority and reports an unknown id as a failed turn.

**Evidence.** `test/companion-main-agent.test.ts` adds a turn that carries
`model: "composer-model"` and `effort: "high"` and asserts the OpenAI-compatible
request body the fake provider receives contains that model and
`reasoning_effort: "high"`; a second turn without overrides still receives the
configured default model and no `reasoning_effort`.
`test/companion-config-api.test.ts` rejects an unknown effort with HTTP 400
before any model call. (That assertion was replaced on 2026-11-19 by
"Reasoning effort is whatever the gateway declares, not a fixed seven" above:
the gateway declares per-model levels outside the built-in set, and the
provider is the authority.) Before the change the stream endpoint had no
`model` or
`effort` field, so neither assertion could pass; the provider body also had no
`reasoning_effort` field at all, which is how the recorded-but-unsent effort was
found. There is no failed run trace for that class — the turn completes, just at
the provider's default — so the repair lane had nothing to replay; the wiring
change is pinned by the provider-body test.

**Reversal condition.** If WhatsApp or scheduled turns must share the same
per-conversation choice, move the store to the server keyed by conversation id
and have the desktop read it back. If owners expect a composer change to become
the default, make the composer write `config.json` and remove the
per-conversation store. If owners need a visible default effort for turns
without a composer without editing the environment, add a compact "set as
default" action to the composer (or restore a single default control in
Settings) rather than two copies. If the gateway's `reasoningLevels` proves
unreliable for a provider, keep the fallback list and label the picker as
advisory.

## 2026-11-19 — A provider stop is a failure, not a completed answer

**Decision.** The agent loop treats any defined `finish_reason` outside
`stop/end_turn/stop_sequence/completed` as `model_error`: `length` /
`max_tokens` keep the truncation message, while `content_filter`, safety or a
provider-specific stop gets "the model stopped without completing an answer
(finish_reason: …)". `describeFailureForOwner` maps a blocked/stopped answer to
a Chinese summary and next step.

**Why it won.** The audit found a no-tool-call assistant message with
`finish_reason: content_filter` (and provider-specific stops) recorded as a
completed turn; the owner saw a blocked or partial answer as the model's
answer. Magpie's repetition stop is now preempted by the local no-progress
guard; the remaining provider stops are exactly what the finish reason names.

**Alternatives rejected.**

- *A blocklist of known failure values.* It misses provider-specific stops; a
  whitelist fails closed and a new normal value can be added when observed.
- *Detect stop-notice text.* The Magpie notice arrives as ordinary content with
  `finish_reason: stop`; text matching is provider-specific and brittle. The
  local guard is the defense for that case.
- *Add a new `provider_stop` terminal reason.* It would add a reason to the
  worker and Main Agent mappings for no behavioral difference; `model_error`
  with the finish reason in the message and the display mapping is enough.
- *Only change the UI mapping.* The turn would still be stored as completed.

**What was given up.** A provider that uses a proprietary normal finish value
outside the four is reported as failed; add it to the set when observed. The
partial content stays in the reply but the turn fails, so it is not presented as
a complete answer. A stop notice delivered with `finish_reason: stop` remains
indistinguishable; the local guard handles the repetition case.

**Evidence.** The audit recorded the content_filter case as completed. The new
loop tests: `content_filter` is red on the old code (completed) and green
(`model_error`), an unknown `safety` value fails, and `stop` still completes.
The failure-display test asserts the Chinese summary and next step. `npm test`
**951/951**, typecheck exit 0, gate **PASS**.

**Reversal condition.** If a provider's normal completion reason is rejected,
add that value to the normal set rather than allowing all unknown values. If
providers deliver stop notices with `stop`, handle them in the provider adapter.

## 2026-11-19 — A failed trace carries the step's instructions

**Decision.** `FailedTrace.plan` now carries each step's `instructions`, redacted
`acceptanceCriteria`, `requiredCapabilities`, `scopes` and `subagents` count, read
from the run's `plan.created` event. The repair lane can reproduce a plan- or
verification-level failure from the trace alone instead of the working agent
restating the step in a decision brief.

**Why it won.** The verifier repair's first lane run failed the
`regression-missing` gate because `FailedTrace.plan` held only
`id/title/risk/agentId`; the worker could not obtain `plan[0].instructions` and
stopped without writing a case. The real instructions were in the journal and
had to be pasted into the decision brief for the retry. A trace that cannot
reproduce the plan is not the self-contained hand-off its module claims to be.

**Alternatives rejected.**

- *Add only `instructions`.* Acceptance criteria and capabilities are what the
  regression test asserts against and what the worker needs to choose the
  production file; carrying them together costs little.
- *Point the lane at the owner's journal.* The lane runs in an isolated clone
  home and a worktree; the owner's journal is not its input, and a path into it
  would break the isolation the lane is built on.
- *Re-export the trace at lane time from the live journal.* The trace is the
  evidence of what failed; regenerating it can see a moved-on journal and a
  different plan.
- *Keep the reduced plan and require a decision brief.* That is the workaround
  this replaces; it makes every plan-level repair depend on a human/agent
  reading the journal.

**What was given up.** Traces grow: the real step instructions are about 1 KB,
each string is capped by the existing redaction (1,500 characters), and a wide
plan carries up to eight steps. Redaction and the cap can lose detail the
worker would otherwise read. The trace remains a copy, not the journal.

**Evidence.** The verifier lane's first run (`8464295d`) failed
`regression-missing` with "the staged trace's plan[0].instructions is missing";
the retry succeeded only after the brief pasted journal sequence 1818. The new
test in `test/failed-traces.test.ts` adds instructions, criteria, capabilities
and scopes to the fixture and asserts the trace carries them redacted.

**Reversal condition.** If traces become too large to stage or carry, export
only the steps the failure names, or a sanitized plan plus a plan id the lane
can read from a copied fixture. If redaction cannot keep up with the added
fields, drop `scopes` before dropping instructions.

## 2026-11-19 — A first-send failure shows the owner-facing reason, not the raw loop error

**Decision.** The SSE `failed` event carries `errorSummary` and `errorGuidance`
from `describeFailureForOwner`, and the transient first-send failure card
renders the summary, the next step and the raw error in a collapsed detail —
instead of only the raw English loop error. The raw error stays in the payload,
the ledger and the interruptions record.

**Why it won.** The audit found that the first send with no streamed reply skips
the ledger refresh (`wasComposing && !reply`), so the raw "The agent called
get_run_status 5 times … making no progress" was the only text the owner saw.
The Chinese summary and next step already existed in the ledger, but appeared
only after a manual refresh. This is the 2026-11-19 no-progress stop itself; the
owner saw English internals instead of "已停止以免空转".

**Alternatives rejected.**

- *Always refresh on failure.* The first-send guard exists because the refresh
  can render the welcome screen over the error card; it also costs a round trip
  on every failure. The SSE payload already has the error; carry the summary
  with it.
- *Replace the raw error with the summary.* The raw error is needed for
  diagnosis; keep it in a collapsed detail and the interruptions record.
- *Translate only the existing `{message}` template.* The template has no
  next-step slot, and every failure would get the same sentence.
- *Make the ledger card the only surface.* That is what failed for a first send;
  the transient card is what the owner sees.

**What was given up.** The failed event grows by two short strings. The
transient card and the ledger card are two renderers of the same mapping and can
drift. The raw error remains in the DOM (collapsed) and in the interruptions
record.

**Evidence.** The audit recorded the SSE payload carrying only `error`, the UI
rendering `response-interrupted-detail`, and the first-send refresh guard. The
new server test scripts five identical `get_run_status` calls: the failed event
carries the Chinese summary and guidance, and the ledger row is failed. The UI
structure test asserts the transient card reads `payload.errorSummary` /
`payload.errorGuidance`. Before the change the event has no summary or guidance
and the card falls back to the raw template.

**Reversal condition.** If the failure mapping must be localized per UI
language, send structured fields and render them per locale. If the ledger
refresh becomes safe for a first send, remove the transient renderer and show
the ledger card.

## 2026-11-19 — A failed turn stays visible in the sidebar while its child run is active

**Decision.** A conversation row's status gives a failed or interrupted latest
turn precedence over a non-waiting active child; waiting children still win.
The preview shows the turn's failure and, when a child is still active, appends
"N 个任务仍在执行". A completed or running turn with an active child still reads
running. The child row keeps its own status.

**Why it won.** The 2026-11-19 no-progress stop marks the turn failed while the
run it spawned continues by design. `conversationStatus` checked active children
before the latest turn's failure, so the sidebar read running for the whole run —
eleven minutes in the incident — and the owner saw the failure only after
opening the conversation. `conversationPreview` did the same with
"N 个任务正在执行". The status slot is the one place the owner scans; a running
child does not mean the conversation's last turn answered.

**Alternatives rejected.**

- *Keep running precedence and add a separate failure badge.* The row already
  has one status slot; a second signal must be learned and the preview would
  still say running.
- *Mark the child row failed.* The child is running; that would lie about the
  child.
- *Wait until the child finishes to show the turn failure.* That is the masking
  this fixes.
- *Move failed turns into 需要你的确认.* That section is for owner decisions;
  a failed turn is not a decision, and the status plus preview is where the
  owner already looks.
- *Give a failed child the same precedence.* A failed child among active
  siblings is a different case; this entry is about the conversation's own last
  turn.
- *Require the failed turn to be newer than the child's last update.* The
  incident's run updates after the turn fails (running → verifying), which would
  re-hide the failure; the conversation's last turn is the fact that matters.

**What was given up.** A conversation whose latest turn failed but whose child
is still working no longer reads 运行中; an owner scanning for active work sees
需要处理 and the preview's "N 个任务仍在执行". The row's status is no longer a
pure aggregate of its children; it includes the conversation's own last turn.

**Evidence.** The audit reproduced the old order in `conversationStatus`
(active child → running, before the latest-turn failure) and in
`conversationPreview` (active count before the turn). The incident's turn
completed at 06:14:21 (failed under the new guard) while its run stayed active
until 06:25:46. The new test appends a failed turn and a queued child under the
same conversation and asserts status `failed` and a preview containing the
failure plus "1 个任务仍在执行"; a waiting child still yields `waiting_approval`,
and a completed turn with an active child still yields `running`.

**Reversal condition.** If owners expect the row to read running whenever a
child is active, require the failure to be newer than the child's last update or
add a separate failure badge. If the combined preview is confusing, show the
failure only in the conversation pane.

## 2026-11-19 — A failed run carries its reason, and the Main Agent can read it

**Decision.** When a run fails, the `run.status_changed` payload carries a
`reason`: the policy decision's reason on a denial, the verification summary on
a failed verification or a rejected review, and the existing execution message
on a worker failure. Replay therefore sets `run.failureReason` for every
failure, not only worker errors. `dispatch_task` returns `failureReason`,
`runStatusInfo` prints a `Failure:` line for a failed run, and the work update
and opportunity read `run.failureReason` instead of only `execution.failed` or
the status payload. Reasons are capped (500 characters) with the full event
still in the journal.

**Why it won.** In the 2026-11-19 incident, two `dispatch_task` runs
(`2c8b917a`, `09499a28`) failed on a policy denial. `dispatch_task` returned only
`failed`, `get_run_status` printed no reason, and the Main Agent re-dispatched
the same objective 6.6 s later. The verification failure of `fa36a720` was
journaled with a precise summary, but `run.status_changed` had only
`{status:"failed"}`; the work update was empty and the opportunity card said
"没有记录到具体原因". The execution-failure path already passes a message into
the status (`runtime.ts:568`), which is the model to follow.

**Alternatives rejected.**

- *Return the full journal or policy event to the model.* Too much context; the
  actionable sentence is enough.
- *Add a new `get_run_failure` tool.* One more tool and one more round; the
  model already reads the run status.
- *Surface the reason only to the owner, not the model.* The duplicate dispatch
  was model-driven; the model needs it.
- *Change the policy to allow the write.* The denial is correct; the defect is
  that it was silent.
- *Make the owner open the audit.* The conversation should know why the work it
  dispatched failed.
- *Store the reason only in `verification.completed`.* That event already
  exists; the readers use the run record, the work update and the opportunity,
  all of which key off the status transition.

**What was given up.** Reasons are prose in the journal and can be long or
technical; they are capped, and the full verification event remains. A policy
reason may name a path; the plan already carries the scope and redaction
applies. The owner may see a technical sentence instead of a friendly generic;
that is better than silence.

**Evidence.** Journal seq 1794/1795 and 1808/1809 (denied; the status payload
carries only the status), 2433/2434 (verification failed; the status payload
carries only the status), `work-updates.jsonl` line 14 (empty summary), and the
opportunity at seq 2436 ("没有记录到具体原因"). The audit findings record the
same evidence. The repair lane produced `test/regression/failure-reason.test.ts`;
it is red before (6 assertions covering the policy denial, the verification
replay, the status reader and the dispatch result) and green after, and landed
as `443aa73`.

**Reversal condition.** If reasons make the journal unwieldy or leak data,
store a truncated summary plus a pointer to the event, or a structured
category/scope. If readers need machine-readable causes, add fields instead of
prose.

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
`"/Users/user/.clone"` from those instructions.

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
- *Widen the verifier's roots so `/Users/user/.clone` exists.* The path is a
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
current tree: `[{"path":"/ pnpm-workspace.yaml"},{"path":"/Users/user/.clone"}]`.
The pre-`6dc13f0` extractor returned `["/Users/user/.clone", "AI/.clone"]`, so
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

**Superseded (main conversation navigation).** [2026-11-19 — 新请求 is the only
creation entry; the main conversation is a pinned row](#2026-11-19--新请求-is-the-only-creation-entry-the-main-conversation-is-a-pinned-row)
replaces the "stays the fixed navigation entry, never a row" clause; the rest of
this entry stands.

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

**Superseded clause (2026-11-19, later the same day).** The aggregate order
above is now waiting > latest-turn failure > running > recent failure >
completed: a failed or interrupted latest turn outranks a non-waiting active
child, and the preview shows the failure plus the active count. See the entry at
the top of this file. A completed/running turn with an active child still reads
running, and a waiting child still wins.

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
(`deepseek/deepseek-v4.1-flash`). The gateway card keeps the connection
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
and a 当前模型 deepseek/deepseek-v4.1-flash card directly above the same
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
/Users/user/.clone" names an input location, not a file it promises to
produce. A path that is a file promise, including an absolute path containing
spaces, is kept whole: `Write /tmp/verify/Clone AI/out.md` extracts the full
path, never `AI/out.md`. The verifier keeps its workspace read boundary, its
symlink refusal and its write rules; nothing outside the workspace becomes
readable.

**Why it won.** Run `fa36a720…` was a read-only investigation. Its instructions
introduced `/Users/user/.clone` as 数据目录 and
`/Users/user/Documents/Clone AI/.clone` as 项目运行目录. The extractor treated
both as promised files, split the second at the space, and the verifier failed
the run with `"/Users/user/.clone" was promised but does not exist on disk;
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
/Users/user/.clone，项目运行目录 /Users/user/Documents/Clone AI/.clone。" Both
clauses end with 目录. The current extractor returns both paths (the second
truncated), and the verifier reports both missing. `/Users/user/.clone` exists
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
(journal seq 1818) also says "候选位置包括 … 以及 /Users/user/.clone 里的线索"
and "package.json / pnpm-workspace.yaml". On the merged extractor those produce
`/Users/user/.clone` again and a new false promise `/ pnpm-workspace.yaml`, and
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
`/Users/user/work/knowledge_base/README.md` (six requests); the new extractor
returns `/Users/user/work`. Against the live machine, `recent_file_changes`
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
  `/Users/user/work/knowledge_base/README.md` while its worker's workspace was
  `/Users/user/study/clone-ai` (the checkout), so the worker reported the file
  as "outside the workspace". The prompt named the right workspace; the tool did
  not receive it.

**Evidence.** Runs `c03c7cea` and `cd74804b` were planned as a `prepare` step
with a `draft` subagent requiring `local-draft`; `subagent.verified` failed with
"Missing required artifact evidence: local-draft". Run `b1e04b18` had a
read-only plan but failed because `dispatch_task`'s runtime fell back to the
checkout. After both fixes, the live check on a knowledge-base workspace
(`CLONE_AI_LIVE_WORKSPACE=/Users/user/work/knowledge_base`, native /
`openai/gpt-6.1-terra`) produced **one** run (`99504e85`): a single
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
  loaded from `/Users/user/study/clone-ai`, while the owner's configured
  workspace was `/Users/user/Documents/Clone AI` and the project being asked
  about was `/Users/user/work/knowledge_base`. The agent sounded like it was
  working on clone-ai because it was reading clone-ai's rules.
- *Let the Main Agent search the home folder for a named project.* Discovery
  outside the workspace widens the trust boundary. It needs an owner-authorized
  `files` scope and its own decision; until then the honest answer is "not in
  this workspace", with the path or a workspace switch.
- *Let the worker "find the project in the workspace" and accept what it reads.*
  Run `062716a9` did exactly that: `list_directory("..")` was refused, all nine
  evidence rows came from `/Users/user/Documents/Clone AI`, and the run still
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
`workspacePath: /Users/user/Documents/Clone AI`; the RAG project is at
`/Users/user/work/knowledge_base`. After the `resolve` fix, live run
`496d2061` read `/Users/user/work/knowledge_base/README.md` through an absolute
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
phrasing. Using `openai/gpt-6.1-terra` at `http://127.0.0.1:3425` and a fresh
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
`openai/gpt-6.1-terra`) started 2026-11-18T07:18:22.108Z and completed
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
although `~/.clone/config.json` names `/Users/user/Documents/Clone AI` and that
folder holds the 1.3 MB vendor file. `launchctl print` showed
`working directory = /Users/user/study/clone-ai` and no default-workspace
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

**Evidence.** Two runs of the same trace with Magpie `deepseek/deepseek-v4.1-flash`:
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
