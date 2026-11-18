# Agent invocation audit

[简体中文](agent-invocations.zh-CN.md)

Every Main Agent invocation writes to a shared, append-only ledger at
`~/.clone/audit/invocations.jsonl`. This is deliberately independent of
`CLONE_HOME`: an external agent can isolate its Run journal in a temporary
directory, but its request, visible reply, errors, model, caller and Run ids
still appear in the owner's audit view.

## What is recorded

- a unique invocation id, caller kind (`codex`, `claude-code`, `whatsapp`,
  `desktop`, or an explicit value), surface, pid and optional caller session id;
- the user-visible request and final visible reply;
- failure text when the turn fails;
- workspace, data directory, session file, model, provider and effort;
- Run ids created during the turn;
- start time, end time and duration.

Private model reasoning is never recorded. Text is PII/token-redacted and
truncated before it reaches the ledger. A start without an end remains visible
as `running`, which is the honest representation of an interrupted process.

## Where to read it

- Desktop: **设置 → 审计与轨迹 → Agent 调用**.
- API: `GET /api/invocations` and `GET /api/invocations/:id`.

## Searching and hiding records

The desktop view searches the whole shared ledger on the server, not just the
page it already loaded, and shows `显示 N / 共 M 条`. Matching is a
case-insensitive substring over the request, visible reply, error, caller,
surface, workspace, data directory, model, provider, effort and Run ids. The
**主 Agent 回合** tab searches the journal the same way.

Deleting a record appends a tombstone (`{"phase":"deleted","id":…}`) to the
ledger and removes it from the default list. The original start and reply lines
are never rewritten, because several processes append to the same file. Tick
**含已删除** to see hidden records and restore one; **删除这 N 条** marks only
the records currently loaded in the filtered list, so the owner always sees
what is about to be hidden. This is privacy hygiene, not erasure: the lines
stay on disk, and `includeDeleted=1` or the detail endpoint can still read them.

- `GET /api/invocations?q=<text>&limit=<1..500>&includeDeleted=1` returns
  `{records, total, hidden}`; `total` counts matches before the limit, and
  `hidden` counts matches withheld only because tombstones are excluded (so the
  UI can say "all remaining records are hidden" instead of "there are none").
- `POST /api/invocations/delete` and `POST /api/invocations/restore` take
  `{ids: string[]}` and return `{changed}`.

## Caller identity and overrides

The ledger detects `CODEX_THREAD_ID`, `CLAUDE_SESSION_ID` and
`CLAUDE_CODE_SESSION_ID` automatically. An integrating agent should set:

```bash
CLONE_AI_CALLER=my-agent
CLONE_AI_CALLER_SESSION=run-123
```

Use `CLONE_AI_AUDIT_HOME` to move the shared ledger for a controlled deployment
or a test. It is a directory; the ledger is written under its `audit/`
subdirectory. `CLONE_HOME` and `CLONE_AI_DATA_DIR` do **not** move it in
production.
