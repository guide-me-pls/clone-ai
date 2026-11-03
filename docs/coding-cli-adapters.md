# Black-box agent boundary

**English** · [简体中文](coding-cli-adapters.zh-CN.md)

Clone AI treats every coding agent as a black box. It supplies a prompt,
scoped context, and a workspace, then judges the result by observation: process
lifecycle and actual filesystem changes. It does not parse a provider's
protocol, session database, tool stream, or completion claim.

**Safe default:** Clone AI does not yet enforce an OS sandbox, so black-box workers are
blocked by default. The desktop settings allow the owner to explicitly acknowledge
`hostAccess: "unrestricted"`; this gives the process the user's file, network, and
credential access. Kernel approval cannot mediate its internal tools. Declared external
or irreversible actions are refused by black-box workers; a governed action connector
has not been implemented.

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

An unrestricted black-box process can change things outside the Workspace, so
an unchanged checkpoint does not establish that retrying is safe. Interrupted
or failed black-box work is not automatically replayed; the owner must inspect
the outcome. Older records without a replay-safety guarantee also fail closed.

For a trusted adapter that explicitly guarantees replay safety, the Kernel
compares its durable pre-dispatch checkpoint with the current Workspace:

- no changes: rerun a new session;
- enough added/modified required artifacts: reconcile observed artifacts and
  avoid repeating the work;
- deletion, unexpected read-only writes, incomplete artifacts, or a missing
  checkpoint: emit a structured recovery failure and wait for the owner.

Provider resume can optimize an authorized retry, but cannot be the source of
truth or make an unisolated black-box process safe to replay.

## Workspace concurrency

A Workspace uses an exclusive lease during a WorkOrder. It serializes readers
with writers as well as writers with writers, preventing agents from
overwriting each other or observing a half-written project. The lease combines
an in-process queue with a SQLite write lock that the OS releases when a
process dies. Legacy PID lock files are checked during migration; stop older
daemon versions before running the upgraded one.

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
