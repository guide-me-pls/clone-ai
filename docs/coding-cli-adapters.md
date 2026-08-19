# Black-box agent boundary

**English** · [简体中文](coding-cli-adapters.zh-CN.md)

Clone AI treats a coding agent as a black box. It supplies a prompt and a
workspace, then judges the result by observation alone: the process exit status
and what actually changed on disk. Nothing about an agent's internal protocol,
streaming format, or session model is parsed.

```text
WorkOrder -> policy + capability check
  -> BlackBoxWorkerAdapter    prompt in · budget · deadline · terminate
     |                        workspace snapshot before / after
  <- exit status + workspace diff + output tail
-> artifacts -> verification -> WorkReceipt
```

## Integrating an agent is configuration

Any headless agent is a launch recipe. Declare one in
`<dataDirectory>/providers.json` and it becomes selectable — no source change,
no adapter class:

```jsonc
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

`{{prompt}}` and `{{workspace}}` are substituted at dispatch. `promptVia:
"stdin"` sends the prompt on stdin instead of as an argument. A declaration
that reuses a built-in id replaces it, so the owner can retune how a shipped
agent is launched.

| Built-in | Command |
| --- | --- |
| Claude Code | `claude -p {{prompt}}` |
| Codex CLI | `codex exec --skip-git-repo-check {{prompt}}` |
| Pi | `pi -p {{prompt}}` |
| opencode | `opencode run {{prompt}}` |

**Authority:** a provider declaration says how to launch an agent and which
credentials it may see. It cannot grant approval, extend a budget, change Run
state, or declare success.

## Evidence is observed, not requested

A black-box agent does not know Clone AI's conventions and cannot be relied on
to announce what it produced. So Clone AI does not ask. It snapshots the
workspace before the dispatch and diffs it afterwards; added and modified files
are the artifacts, each recorded with its real path as the locator.

This is stricter than the previous convention of asking the worker to print a
declaration line, because it needs no cooperation. It also settles the
completion question: when a work order requires an artifact and the workspace
is unchanged, the work did not happen — whatever the agent said. A deleted file
is a real change but never an artifact.

Receipts remain ungrantable. An artifact proves a file exists; only a trusted
runtime can attest that an external action really happened.

## Failure is compared across agents

Every failure is classified into a coarse category — `launch_failed`,
`timeout`, `aborted`, `nonzero_exit`, `no_artifact`, `missing_credential`,
`missing_input`, `permission_denied`, `network`, `unknown` — with a normalized
signature that strips paths, ids, numbers, and timestamps.

On retry the Runtime deliberately picks a **different** provider. Repeating the
same black box rarely produces a different outcome, and a second opinion is
what makes the next step possible:

```text
agent A fails ─┐
               ├─ different reasons  -> try another agent
agent B fails ─┘
               └─ same diagnostic category
                     -> the obstacle is in the task or environment
                     -> stop retrying, escalate to the owner
```

Agreement on a diagnostic category (both agents cannot find a credential) is
treated as corroboration on its own, because independent products describe the
same wall in their own words. Agreement on a catch-all category
(`nonzero_exit`, `unknown`) proves nothing by itself, so those additionally
require overlapping wording.

## The cost of the black box

| Property | Consequence |
| --- | --- |
| No protocol parsing | Any headless agent integrates by configuration |
| No session identity | A crashed run **restarts**, it does not resume |
| No tool events | Progress is the agent's own output lines, nothing finer |
| Evidence from the filesystem | Work that was not written to a file counts as work not done |

Losing resume is the honest price of not parsing protocols: without reading an
agent's session model there is no session id to reopen. Idempotence is carried
by the WorkOrder's `maxAttempts` and by artifacts being observable facts.

## Verified and not yet claimed

- The full black-box path is covered by tests against a scripted agent:
  workspace-diff artifacts, a talkative agent that writes nothing, a missing
  command, a wedged agent hitting the deadline, the environment allowlist, and
  cross-provider corroboration.
- Type checking and the automated suite pass without a paid request.
- No live run against a real installed agent has been executed **since the
  black-box rewrite**; the built-in launch recipes are inference from each
  product's documented headless mode, not observation.
- `workspace-diff` walks the filesystem and skips common build directories.
  Very large workspaces are capped at 20,000 files, and files above 2 MB are
  identified by size and mtime rather than content hash.
