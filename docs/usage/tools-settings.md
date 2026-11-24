# Tools & skills in Settings

[简体中文](tools-settings.zh-CN.md)

The desktop settings page now has a **工具与技能** / **Tools & skills** tab. It
lists every MCP server in the clone home's `mcp.json`, every tool that server
declares, and every skill found under the owner's skill roots. Each server has a
**加载 / 停用** (Load / Unload) button. Loading writes only that server's
`enabled` field; the next worker run sees the change.

## What the tab shows

- **MCP servers** — id, transport, enabled state, and each declared tool with
  its risk (`read`, `write`, `network`, `external`) and description. The catalog
  never returns `env`, `command`, `args` or `url`; those can carry credentials.
- **Skills** — name, description and `SKILL.md` path for each skill found under:
  - `<clone home>/skills`
  - `<workspace>/.clone/skills`

  A malformed `SKILL.md` is listed under "无法解析的技能" with its reason, not
  silently dropped.
- **MCP configuration problems** — a broken `mcp.json` entry is reported above
  the server cards instead of hiding the rest of the catalog.

In this clone home on 2026-11-24 the tab shows:

| Server | Tools | Enabled |
| --- | --- | --- |
| `playwright` | 10 browser tools | yes |
| `agent-tools` | 7 read/network tools | yes |
| `agent-exec` | `list_commands`, `run_command` | yes |

No skill was found under the two roots; the tab says so and shows the roots.

## Load and unload

Press **停用** on a loaded server to remove it from the worker's next tool table;
press **加载** on a disabled server to restore it. The button writes
`mcp.json` atomically with mode 0600 and preserves every other server and field
— including `command`, `args`, `env` and unknown keys. The change applies to the
next worker run; no runtime restart is needed because `workerTools` rebuilds its
table per run.

A loaded server is still filtered per step: a `network` tool such as
`agent-tools.fetch_url` needs a network scope, and `agent-exec.run_command` is a
`write` tool offered only to reversible-write steps. Loading a server does not
grant those scopes.

## Add a skill

Create a directory with a `SKILL.md` under one of the roots:

```text
~/.clone/skills/my-procedure/SKILL.md
```

```markdown
---
name: my-procedure
description: One line the model and the owner see in the listing.
allowed-tools: read_file, search_text
---

The full procedure. This body loads only when the skill is invoked.
```

The tab reads the skill list; the body stays on disk. Skills are a clone-ai
concept, not the Claude Code skill library; the two do not share a directory.

## Safety and limits

- The catalog is a declaration view. It does not start a server or call
  `tools/list`; a server whose real tools drift from `mcp.json` will look stale
  until a live-probe action exists. The worker only sees the declared tools.
- The toggle changes the owner's `mcp.json`; the file remains the source of
  truth. The page cannot install a server, run a command, or read a credential.
- `enabled` is per clone home, so the same server list is used by every
  workspace; only the skill roots are workspace-aware.
- The skills view is read-only. Wiring skills into a Main Agent turn and adding
  an enable/disable control is a separate change.

## Status

The safe projection, atomic toggle, malformed-file reporting, skill discovery
and rejected-skill reporting are covered by `test/mcp-settings.test.ts`; the
route is covered by `test/companion-config-api.test.ts`; the tab and its load
controls are pinned by `test/ui-structure.test.ts`. See
[`docs/engineering/optimizations.md`](../engineering/optimizations.md) under
2026-11-24 for the eval commands and the execution chain.
