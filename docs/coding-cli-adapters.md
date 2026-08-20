# Black-box agent boundary

**English** · [简体中文](coding-cli-adapters.zh-CN.md)

Clone AI treats every coding agent as a black box. It supplies a prompt,
scoped context, and a workspace, then judges the result by observation: process
lifecycle and actual filesystem changes. It does not parse a provider's
protocol, session database, tool stream, or completion claim.

```text
WorkOrder -> policy + capability + approval
  -> BlackBoxCliWorker    prompt · budget · deadline · termination
     |                        environment allowlist
     |                        workspace snapshot before / after
  <- exit status + workspace diff + redacted output tail
-> observed artifacts -> verification -> Run state
```

## Integrating an agent is configuration

Built-in launch recipes live in `src/workers/providers.json`. A user can add
or override a recipe in `<dataDirectory>/providers.json`:

```json
{
  "providers": [
    {
      "id": "opencode",
      "label": "opencode",
      "command": "opencode",
      "args": ["run", "{{prompt}}"],
      "env": ["ANTHROPIC_API_KEY"],
      "timeoutMs": 900000
    }
  ]
}
```

`{{prompt}}` and `{{workspace}}` are substituted at dispatch. With
`promptVia: "stdin"`, the prompt is sent on stdin instead of appearing in the
argument list. A declaration with a built-in id overrides that recipe. `env`
contains variable names only; no credential value belongs in source or config.

| Built-in | Command |
| --- | --- |
| Claude Code | `claude -p {{prompt}}` |
| Codex CLI | `codex exec --skip-git-repo-check {{prompt}}` |
| Pi | `pi -p {{prompt}}` |
| opencode | `opencode run {{prompt}}` |

A declaration controls launch mechanics and visible environment only. It
cannot grant approval, extend a WorkOrder budget, change Run state, or declare
success.

## Evidence is observed

The adapter snapshots the Workspace before dispatch and diffs it afterwards.
Added and modified files become artifact evidence with their real relative
paths; deleted files are changes but not artifacts. When an artifact is
required and no file changed, the result is `no_artifact`, regardless of what
the agent said. Receipts remain unavailable to a normal black-box provider.

## Recovery does not use provider memory

The Kernel stores a durable JSON checkpoint for the Workspace before the first
attempt. If a worker or supervisor dies, the Kernel compares the checkpoint
with the current Workspace:

- no changes: rerun a new session;
- enough added/modified required artifacts: reconcile observed artifacts and
  avoid repeating the work;
- deletion, unexpected read-only writes, incomplete artifacts, or a missing
  checkpoint: emit a structured recovery failure and wait for the owner.

This is why `--resume` is not a dependency for Claude Code, Pi, or any future
provider. Provider resume can optimize a retry, but it cannot be the source of
truth.

## Workspace concurrency

A Workspace uses an exclusive lease during a WorkOrder. It serializes readers
with writers as well as writers with writers, preventing agents from
overwriting each other or observing a half-written project. The lease combines
an in-process queue with an atomic lock file and can reclaim a dead supervisor's
lock using the owner PID.

## Failure JSON and corroboration

Failures use stable categories such as `launch_failed`, `timeout`,
`nonzero_exit`, `no_artifact`, `missing_credential`, `missing_input`,
`permission_denied`, `network`, `partial_side_effect`,
`unexpected_side_effect`, `recovery_blocked`, and `unknown`.

A report carries provider/agent identity, a normalized signature, and redacted
human-readable detail. The owner may add patterns and guidance in
`<dataDirectory>/outcomes/failures.json`; the file is loaded as diagnostics only,
never as execution authority. Independent providers that fail with the same
diagnostic category corroborate a task or environment obstacle. Catch-all
categories also need overlapping signatures before retries are stopped.

## Verified boundary

The scripted black-box tests cover workspace artifacts, claims without writes,
missing commands, hard deadlines, environment isolation, failure categories,
checkpoint arbitration, workspace locking, and cross-provider corroboration.
The default suite never needs a paid provider request. Live provider smoke tests
remain opt-in and are not evidence that another provider's launch recipe is
correct.
