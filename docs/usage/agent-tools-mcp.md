# Local agent tools (bundled MCP server)

[简体中文](agent-tools-mcp.zh-CN.md)

clone-ai's native worker has four file tools. That is enough to read and change a
file whose path is already known, and not enough to find a symbol across a
repository, read a diff or a commit history, learn today's date, or open a
documentation page. This page installs **`agent-tools`**, a small bundled MCP
server that supplies exactly those read-only capabilities.

It is clone-ai's own server (`src/mcp/agent-tools-server.ts`), not a third-party
package. It uses Node built-ins only, so the installer can copy one file into
the clone home and the server runs without a build step or a Python runtime.

## What the worker gets

| Tool | Risk | Purpose |
| --- | --- | --- |
| `agent-tools.search_text` | read | Recursive literal or regex search, with a glob filter; returns `path:line: text` |
| `agent-tools.find_files` | read | Glob discovery (`**/*.ts`, `*.md`), returns relative paths |
| `agent-tools.git_status` | read | Branch and working-tree status |
| `agent-tools.git_diff` | read | Unified diff, optionally staged or against a commit |
| `agent-tools.git_log` | read | Recent commits as `hash date author subject` |
| `agent-tools.current_time` | read | ISO/local time, time zone, UTC offset, epoch milliseconds |
| `agent-tools.fetch_url` | **network** | One HTTP(S) GET, HTML reduced to text; private addresses refused |

No write tool and no shell tool is declared. `git_commit` and `run_command` are
deliberately absent: committing remains the repair lane's job, and a shell needs
a sandboxed exec domain the worker does not have yet.

A read tool can be offered to a read-only step. `fetch_url` is declared
`network`, so it appears only when the step declared a network scope; installing
the server does not grant one.

## Install

```bash
node --experimental-strip-types scripts/install-agent-tools.mjs \
  --workspace /path/to/project
```

This writes two things in the clone home (default `~/.clone`):

- `mcp-servers/agent-tools-server.ts` — a copy of the server;
- `mcp.json` — an enabled `agent-tools` entry, with every tool declared and
  risk-classified. Other servers in the file are preserved.

Use `--print` to inspect the entry without writing it, and `--clone-home` to
target another clone home. The entry pins the absolute Node path (the daemon can
be started by launchd with an empty `PATH`); rerun the installer after a Node
upgrade. Restart the runtime so the worker rebuilds its tool table from the new
`mcp.json`.

## Use it in a task

The tool names and argument shapes are in each description, so a workspace
instruction can stay short:

```markdown
## Repository inspection
The `agent-tools.*` tools are read-only. Use `search_text` to find a symbol
before changing it, `git_diff` to see what changed, and `git_log` when the
history explains the code. `fetch_url` needs a network scope.
```

A request such as "找到所有调用 `parseConfig` 的地方，改完用 `git_diff` 检查一下"
is then enough: the worker can search first and inspect its own change after.

## Safety boundary

- The server is **read-only**. It cannot create, edit or delete a file, run a
  shell, commit, push or post.
- A tool that names a path declares `pathField: "path"`, so the Kernel checks
  that path before the call, exactly like `read_file`. Search and discovery do
  not descend into symlinked directories, and they skip the same protected
  roots as `src/authority/scope.ts` (SSH keys, cloud credentials, browser
  profiles, the journal and policies). The test keeps the two protected lists
  in sync.
- Search skips `.git`, `node_modules`, build output, binary files and files over
  1 MB, and stops after 100,000 directory entries or the requested match count.
  A match inside a skipped tree is not found; narrow the root or raise
  `maxResults` when that matters.
- `fetch_url` accepts only `http:` and `https:`, refuses URLs with embedded
  credentials, resolves the host and refuses loopback/private/link-local/CGNAT
  addresses, re-checks every redirect, sends no cookies or credentials, and
  caps the body at 200,000 bytes. A DNS rebinding between the check and the
  request is not fully prevented; the network grant and the opt-in server are
  the accepted boundary.
- Git commands run with `execFile` (no shell), a 10-second timeout, a 200,000
  byte cap, `GIT_TERMINAL_PROMPT=0`, and `--no-optional-locks` so a read does
  not refresh the index. `--no-textconv` and `--no-ext-diff` stop a repository's
  configured diff helpers from running, `core.fsmonitor=false` stops the
  fsmonitor hook, and a revision that starts with `-` is refused. `git_diff` can
  read a repository at the path the step names; the Kernel's read gate still
  blocks protected locations.
- The server is a child process of the worker step and is closed when the step
  ends. A server that fails is a tool error the model sees; it does not kill the
  run.

## Uninstall

Set `"enabled": false` for the `agent-tools` server in `mcp.json`, or remove the
entry. The copied `mcp-servers/agent-tools-server.ts` can then be deleted.
Restart the runtime.

## Status

Declarations, the merge, the protected-root list, address checks, search,
discovery, git, time and the fetch refusals are covered by
`test/agent-tools-mcp.test.ts`, including a real stdio child and a `workerTools`
wiring case. The live network path is exercised with an injected fetch; no
public URL is called. See
[`docs/engineering/optimizations.md`](../engineering/optimizations.md) under
2026-11-22 for the eval commands and the execution chain.
