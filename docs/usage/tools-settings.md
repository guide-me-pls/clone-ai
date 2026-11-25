# Tools & skills in Settings

[简体中文](tools-settings.zh-CN.md)

The **工具与技能** tab has two categories: **MCP servers** and **skills**. Each
server and each skill is one row; the row opens a detail page. Nothing is
expanded inline, even when a server declares a single tool. The tab also has two
markets — MCP and skills — reached from their category headers.

## What the tab shows

- **MCP servers** — one row per server with its id, transport, tool count and
  enabled state. The detail page lists every declared tool with its risk
  (`read`, `write`, `network`, `external`), a readable summary and a parameter
  table (name, type, required, default). The table is parsed from the
  description's `Args: {...}` block or, during install, from the probe's JSON
  schema — the raw fragment never reaches the page. The catalog never returns
  `env`, `command`, `args` or `url`; those can carry credentials.
- **Skills** — one row per installed skill with its description. The detail page
  shows the `SKILL.md` path, the tools the skill asks for, and the rendered
  Markdown body. Skills are read from:
  - `<clone home>/skills` (where the market installs)
  - `<workspace>/.clone/skills`

  A malformed `SKILL.md` is listed under "无法解析的技能" with its reason, not
  silently dropped.
- **MCP configuration problems** — a broken `mcp.json` entry is reported at the
  top of the MCP category instead of hiding the rest of the catalog.

A back link returns to the previous page; the list keeps its reading position.

## How skills are used

Every Main Agent turn receives a one-line listing of the installed skills in its
system prompt. Each skill is also a `Skill(name)` tool; calling it returns the
skill's body (the procedure). The body enters the turn only when the model asks
for it. A skill's `allowed-tools` line is guidance to the model; the Kernel gate
still decides what a step may run. A newly installed skill applies to the next
Main Agent turn — no restart.

## Load and unload

Press **停用** on a loaded server's detail page to remove it from the worker's
next tool table; press **加载** on a disabled server to restore it. The button
writes `mcp.json` atomically with mode 0600 and preserves every other server and
field — including `command`, `args`, `env` and unknown keys. The change applies
to the next worker run; no runtime restart is needed because `workerTools`
rebuilds its table per run.

A loaded server is still filtered per step: a `network` tool such as
`agent-tools.fetch_url` needs a network scope, and `agent-exec.run_command` is a
`write` tool offered only to reversible-write steps. Loading a server does not
grant those scopes.

## Install an MCP server

The **安装 MCP** button opens the MCP market: five reviewed servers (filesystem,
memory, sequential thinking, Playwright, Chrome DevTools), each pinned to one
npm version with typed inputs. Search matches Chinese or English terms. **配置**
opens the entry page; the client sends only the entry id and the input values,
and the server builds the package, argv and environment from
`src/mcp/mcp-registry.ts`. Two entries carry safety defaults: `memory` keeps its
graph at `<clone home>/mcp-memory.jsonl` instead of the npx cache, and
`chrome-devtools` installs with `--no-usage-statistics`; the filesystem entry
offers `--read-only` switched on.

Installation keeps the probe → risk → confirm chain:

1. Press **探测工具**. The runtime spawns `npx --yes <pinned spec> <args>`,
   performs the MCP handshake and lists the exposed tools. Nothing is written.
2. Assign a risk to each tool — or press **读取 / 写入 / 网络** to set them all.
   Every tool starts at **外部** (`external`), which the worker always refuses.
3. Press **安装** and confirm. The install re-probes the package, refuses when
   it exposes a tool the request did not declare, and writes one enabled entry
   into `mcp.json` atomically with mode 0600.

The installer resolves `npx` from the Node running the runtime (then Homebrew,
`/usr/local`, pnpm, volta and bun locations) and puts that Node directory first
on the MCP child's `PATH`; the absolute command is stored in `mcp.json`. This is
what makes an install work under the launchd daemon, whose `PATH` is only
`/usr/bin:/bin:/usr/sbin:/sbin`.

**手动安装** below the market keeps the free-text form for any npm package. An
entry that is already installed keeps its card with an **已安装** badge. A
**移除** button on each server's detail page deletes that entry. Every failure
happens before the write, so a refused install leaves `mcp.json` untouched.
Installing runs the package with the owner's privileges and no OS sandbox; that
is the cost of the flow, and it is why the agent cannot start one.

## Install a skill

**获取技能** opens the skill market: four built-in skills shipped with this
repository — weekly review, document review, release notes and deliverable
check. Opening one shows its summary, the tools it asks for and its full body.
**安装技能** writes `<clone home>/skills/<name>/SKILL.md` after confirmation;
**移除技能** on an installed skill deletes that directory. Only a direct,
non-symlink child of the clone home's skills root can be removed; a workspace
skill is readable but not removable from here.

A skill can still be written by hand: create
`<clone home>/skills/<name>/SKILL.md` with a frontmatter block (`name`,
`description`, `allowed-tools`, `disable-model-invocation`, `user-invocable`)
and a Markdown body.

```markdown
---
name: my-procedure
description: One line the model and the owner see in the listing.
allowed-tools: read_file, search_text
---

The full procedure. This body loads only when the skill is invoked.
```

Skills are a clone-ai concept, not the Claude Code skill library; the two do not
share a directory. Remote skill download is not enabled: there is no signing or
trust model for a third-party `SKILL.md` yet.

## Safety and limits

- The catalog is a declaration view. The worker only sees the tools `mcp.json`
  declares; the install flow's probe is the only place a package's real
  `tools/list` is read, and it refuses a package that exposes an undeclared
  tool. A server whose tools drift after install is filtered by the same gate
  as before.
- The page can install a server but cannot run a command or read a credential:
  `~/.clone` is a protected root, and `env`/`command`/`args`/`url` never reach
  the settings page. A skill install writes only inside the clone home's skills
  root; a remove requires that direct child and refuses a symlink.
- A skill body is data that enters a turn only on invocation. A workspace skill
  is whatever that project put under `.clone/skills`; read it before relying on
  it.
- `enabled` is per clone home, so the same server list is used by every
  workspace; only the skill roots are workspace-aware.
- Remote skills and MCP servers that need an API key are not installable from
  the market yet. The free-text npm form still works for keyless packages; a
  keyed server needs the env input described in the trade-offs.

## Status

The safe projection, atomic toggle, malformed-file reporting, skill discovery
and rejected-skill reporting are covered by `test/mcp-settings.test.ts`; the MCP
marketplace, its search and its argv/env resolution by
`test/mcp-registry.test.ts`; the install flow and the launchd `npx` resolution by
`test/mcp-installer.test.ts` and `test/mcp-host.test.ts`; the MCP and skill
routes by `test/tools-install-api.test.ts`; the built-in skill registry and its
clone-home confinement by `test/skill-registry.test.ts`; the Main Agent's skill
listing and `Skill(name)` body by `test/skill-runtime.test.ts`; the two
categories, jump rows, markets and skill pages by `test/ui-structure.test.ts`.
See [`docs/engineering/optimizations.md`](../engineering/optimizations.md) under
2026-11-25 for the eval commands and the execution chain.