# Agent invocation audit

[简体中文](agent-invocations.zh-CN.md)

Every Main Agent invocation writes to a shared, append-only ledger at
`~/.clone/audit/invocations.jsonl`. This is deliberately independent of
`CLONE_HOME`: an external agent can isolate its Run journal in a temporary
directory, but its request, visible reply, errors, model, caller and Run ids
still appear in the owner's audit view.

## What is recorded

- a unique invocation id, caller kind (`codex`, `claude-code`, `whatsapp`,
  `cli`, or an explicit value), surface, pid and optional caller session id;
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
- CLI: `clone-ai invocations` or `clone-ai invocations show <id>`.
- API: `GET /api/invocations` and `GET /api/invocations/:id`.

## Caller identity and overrides

The CLI detects `CODEX_THREAD_ID`, `CLAUDE_SESSION_ID` and `CLAUDE_CODE_SESSION_ID`
automatically. An integrating agent should set:

```bash
CLONE_AI_CALLER=my-agent
CLONE_AI_CALLER_SESSION=run-123
```

Use `CLONE_AI_AUDIT_HOME` to move the shared ledger for a controlled deployment
or a test. It is a directory; the ledger is written under its `audit/`
subdirectory. `CLONE_HOME` and `CLONE_AI_DATA_DIR` do **not** move it in
production.
