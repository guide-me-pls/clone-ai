# Local command runner (agent-exec MCP server)

[简体中文](agent-exec-mcp.zh-CN.md)

The native worker can read, search and edit a project, but it cannot run the
project's tests. That makes a bug fix a blind edit: the worker changes the code,
stops, and the repair lane runs the suite afterwards. This page installs
**`agent-exec`**, a bundled MCP server that runs only the commands the owner
lists in `agent-exec.json`, inside a macOS Seatbelt sandbox. It is the worker's
reproduce → fix → verify loop.

## What the worker gets

| Tool | Risk | Purpose |
| --- | --- | --- |
| `agent-exec.list_commands` | read | List the owner-approved commands (name, argv, description) |
| `agent-exec.run_command` | **write** | Run one command by name; no shell, no model-supplied argv |

`run_command` is declared `write`, so only a `reversible_write` step is offered
it. A read-only step can list the commands but cannot run them. The tool output
is framed by the MCP client as an untrusted observation, like every other MCP
result.

## Install

```bash
node --experimental-strip-types scripts/install-agent-exec.mjs \
  --workspace /path/to/project
```

This writes four things in the clone home (default `~/.clone`):

- `mcp-servers/agent-exec-server.ts` — a copy of the server;
- `agent-exec.sandbox` — the Seatbelt profile for this workspace;
- `agent-exec.json` — the owner-written command allowlist;
- `mcp.json` — an enabled `agent-exec` entry, preserving other servers.

`--print` writes nothing and prints the config, profile and `mcp.json` entry.
`--clone-home` targets another clone home. Existing commands in
`agent-exec.json` are preserved; detected commands are added by name.
`--replace` replaces the command list with what was detected.

The installer detects a starting set:

- `package.json` scripts named `test`, `typecheck`, `lint`, `check`, `gate` or
  `build` become `npm run <name>`;
- `pyproject.toml`, `pytest.ini` or `setup.cfg` becomes `python3 -m pytest`;
- `go.mod` becomes `go test ./...`;
- `Cargo.toml` becomes `cargo test`;
- `pom.xml` becomes `mvn test`;
- `gradlew` becomes `./gradlew test`, otherwise `build.gradle` becomes
  `gradle test`.

Review the detected list. A test command is still project code; the sandbox is
the boundary, not the name.

## The allowlist

`agent-exec.json` is plain JSON. The server never accepts an argv from the
model; it only resolves a name.

```json
{
  "workspace": "/Users/owner/project",
  "sandboxProfile": "/Users/owner/.clone/agent-exec.sandbox",
  "commands": [
    { "name": "test", "argv": ["npm", "run", "test"], "description": "Run the test suite." },
    { "name": "typecheck", "argv": ["npm", "run", "typecheck"], "description": "Run the TypeScript checker." },
    { "name": "test:one", "argv": ["node", "--experimental-strip-types", "--test", "test/foo.test.ts"], "description": "Run one test file." }
  ]
}
```

Add a focused command by editing the file on the host (the worker cannot write
it); rerunning the installer keeps it. Do not add `deploy`, `publish`, `start`
or a long-running server. The next worker step reads the new file; restart the
runtime if the change does not appear.

## Use it in a task

A bug-fixing step runs:

1. `agent-exec.list_commands` — see what is available;
2. `agent-exec.run_command` with `{"name":"test"}` — reproduce the failure;
3. edit with `edit_file`;
4. run the test again, then `typecheck`;
5. `agent-tools.git_diff` — inspect the change.

The command output includes the exit code, duration and the tail of stdout and
stderr. A non-zero exit is returned as a tool error with that output; the model
can read it and try again. The Kernel still decides completion and the repair
lane still runs its own suite and typecheck — the runner is a feedback loop, not
a source of evidence by itself.

## Safety boundary

- **No shell.** The server uses `execFile`/`spawn` with an argv array and never
  interprets the model's text as a command. The model supplies only a name.
- **Owner allowlist.** Only commands in `agent-exec.json` run. The list is
  inspectable and editable; adding a command is a deliberate host action.
- **Minimal environment.** The command receives `PATH`, `HOME`, `LANG`,
  `TMPDIR` and `CI`; no model keys, cloud tokens, database passwords or other
  ambient credentials.
- **macOS Seatbelt.** The command is wrapped by `/usr/bin/sandbox-exec` with a
  profile from `src/authority/seatbelt.ts`: writes stay in the workspace, the
  temp directories and the package caches (`~/.npm`, `~/.cache`); network is
  off; the kernel's protected roots (keys, browser profiles, the journal and
  policies) are denied; the workspace's `.git` is write-denied, so a test
  cannot commit, reset or rewrite the checkout.
- **Timeout and cleanup.** The default is 240 seconds per command (600 maximum);
  the MCP request timeout is 660 seconds. A timeout kills the command's process
  group, and the server forwards its own SIGTERM to any command still running
  when the step ends. A test that hangs cannot outlive the step.
- **Output cap.** Each stream keeps the last 50 KB and says it was truncated.
  A huge passing log is shortened; a failing summary at the end survives.
- **No sandbox, no run.** On a platform without a sandbox (or if
  `/usr/bin/sandbox-exec` disappears) the server refuses unless the config
  explicitly sets `allowUnsandboxed: true`. `sandbox-exec` is deprecated by
  Apple; if a future macOS removes it, commands refuse until a replacement is
  wired.
- **Source can still be changed.** A test script is project code and can
  overwrite source files inside the workspace. That is the same write surface
  the worker's `write_file` already has; `.git` and everything outside the
  workspace are the additional boundaries.

## Uninstall

Set `"enabled": false` for `agent-exec` in `mcp.json`, or remove the entry.
Then delete `mcp-servers/agent-exec-server.ts`, `agent-exec.sandbox` and
`agent-exec.json`. Restart the runtime.

## Status

Declarations, config parsing, command detection, merge behavior, a live
allowlisted command, the sandbox refusal, a denied write outside the workspace
and inside `.git`, the timeout and the output cap are covered by
`test/agent-exec-mcp.test.ts` (17 cases). The live probes are macOS-only and
skip where no sandbox exists. See
[`docs/engineering/optimizations.md`](../engineering/optimizations.md) under
2026-11-23 for the eval commands and the execution chain.
