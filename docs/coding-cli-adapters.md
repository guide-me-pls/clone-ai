# Supervised worker boundary

**English** · [简体中文](coding-cli-adapters.zh-CN.md)

Codex CLI, Claude Code, and Pi keep their own internal agent loops. Clone AI
remains Supervisor: it owns the WorkOrder, permissions, budgets, evidence, and
the decision that work is complete.

```text
WorkOrder -> policy + capability check
  -> SupervisedWorkerAdapter     budgets · deadline · abort→terminate
     |                           completion rule · evidence trust · redaction
     +-- ProviderTranslator      protocol only
  <- normalized events, session id, settled signal
-> Clone AI evidence + verification
```

## One core, several translators

Authority lives once, in `SupervisedWorkerAdapter`. A provider contributes only
a translator that maps its protocol onto seven neutral event shapes:

```text
session · text · turn · tool_start · tool_end · progress · settled · protocol_error
```

| Provider | Invocation | Resume | Settled signal |
| --- | --- | --- | --- |
| Codex CLI | `codex exec --json` | `codex exec resume <session>` | clean protocol-speaking exit |
| Claude Code (CLI) | `claude -p --output-format stream-json` | `claude --resume <session>` | `result` event |
| Claude Code (SDK) | `@anthropic-ai/claude-agent-sdk` | `resume` option | typed `result` message |
| Pi | JSONL RPC subprocess | `--session-id` | `agent_settled` |

Adding a coding agent means writing a translator (~100 lines) that cannot grant
approval, extend a budget, change Run state, or declare success. Selecting the
SDK transport for Claude Code is `CLONE_AI_CLAUDE_TRANSPORT=sdk`; the CLI
transport stays the default.

Codex uses `read-only` sandbox for read-only work and `workspace-write` only for
`reversible_write`. Claude Code uses `plan` permission mode for read-only work
and `acceptEdits` only for `reversible_write`. External side effects still stop
at Clone AI's approval boundary.

## Completion is a protocol fact, not an exit code

A process can exit 0 after being killed, exhausting its turns, or being pointed
at the wrong binary. Completion therefore requires an explicit settled signal.
A clean stream that never settled is reported as a failure.

A cooperative abort is likewise a request, not a stop. Every abort arms a grace
timer that force-terminates the session, so a wedged provider cannot hang the
supervisor. Budgets for duration, model calls, and tool calls are enforced in
the core for every provider.

## Environment and evidence

Each worker process starts from an empty environment and receives an explicit
allowlist: baseline OS variables, that one provider's credentials, and any
configured extras. Other secrets in the supervisor's environment stay invisible.

Agent completion is not proof of delivery. When an artifact is required, the
worker ends with this exact line:

```text
CLONE_AI_EVIDENCE: {"kind":"artifact","summary":"...","locator":"relative/path"}
```

The claim is verified, never trusted: only `artifact` is accepted, and only when
the locator resolves to a file that really exists inside the bounded workspace.
Every other claim — including any `receipt`, which would attest that an external
action happened — is downgraded to an observation recording the rejection. This
policy has exactly one implementation, shared by all providers.

Workers also receive the owner's reviewed memory as a scoped packet compiled by
the Kernel, so switching providers never means migrating memory between tools.
See [Runtime architecture and route](runtime-architecture-and-route.md).

## Verified and not yet claimed

- A live read-only Claude Code session completed end to end through this
  boundary against `claude-code 2.1.234` (`CLONE_AI_LIVE_SMOKE=1`). Recording it
  corrected three parsing errors and one Windows launch bug; the redacted stream
  is checked in as a replay fixture.
- Type checking and the full automated suite pass without a paid request.
- Codex CLI event shapes remain **inference, not observation**: no live Codex
  WorkOrder has been run, so its translator branch is unverified.
- The `CLONE_AI_EVIDENCE` line is still a text convention. Replacing it with a
  structured channel is future work for the SDK transport.
