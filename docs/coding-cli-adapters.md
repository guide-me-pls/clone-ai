# Codex CLI and Claude Code adapters

**English** · [简体中文](coding-cli-adapters.zh-CN.md)

This is the first real execution-provider boundary in Clone AI. Codex CLI and
Claude Code keep their own internal agent loops; Clone AI remains Supervisor.

```text
WorkOrder -> policy + capability check -> CodingCliAdapter
  -> Codex CLI / Claude Code -> provider-owned agent loop
  <- JSONL events, session id, final message
-> Clone AI evidence + verification
```

## Current implementation

| Provider | Invocation | Resume |
| --- | --- | --- |
| Codex CLI | `codex exec --json` | `codex exec resume <session>` |
| Claude Code | `claude -p --output-format stream-json` | `claude --resume <session>` |

`CodingCliAdapter` converts provider output into Runtime events, applies a
WorkOrder duration budget, and supports cancellation. A provider cannot grant
approval, write Memory, change parent Run state, or declare final success.

Codex uses `read-only` Sandbox for read-only work and `workspace-write` only
for `reversible_write`. Claude Code uses `plan` Permission Mode for read-only
work and `acceptEdits` only for `reversible_write`. External side effects still
stop at Clone AI's approval boundary.

## Evidence contract

Agent completion is not proof of delivery. When an Artifact is required, the
worker must end with this exact line:

```text
CLONE_AI_EVIDENCE: {"kind":"artifact","summary":"...","locator":"relative/path"}
```

The Runtime records and validates the evidence. The next verifier must resolve
the locator in the bounded Workspace and inspect the actual file or receipt.

## Verified and not yet claimed

- Codex CLI `0.145.0` and Claude Code `2.1.220` are installed locally.
- Type checking and the full automated test suite pass without a paid request.
- No live Provider WorkOrder was invoked by this change.
- Provider-specific JSON event shapes and real Artifact inspection still need a
  read-only live smoke test.

## First safe smoke test

Use one provider at a time with this read-only WorkOrder:

```text
Analyze the current repository structure. Do not edit files or call external services.
Return one CLONE_AI_EVIDENCE observation naming the files you inspected.
```

Inspect the Journal for the provider session, normalized events, Evidence, and
Verification result. Let that observation determine the next optimization.
