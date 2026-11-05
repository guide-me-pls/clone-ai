# Nightly repair from failed traces / 从失败轨迹出发的夜间修复

This is the part of the RSI loop that can be trusted with a machine: it turns a
bad day into a failing test, a fix, and a **draft pull request**. It never
merges, never touches the serving checkout, and never edits the rules that
govern it.

这是 RSI 回路里可以交给机器的那一部分：把一次糟糕的运行变成一条失败的测试、一个修复，和
一个**草稿 PR**。它从不合并、不碰正在服务的检出，也不修改约束它自己的规则。

```bash
# record the failures (redacted) that the night job will read
clone-ai traces export
clone-ai traces            # list what is on disk
node scripts/nightly-rsi.mjs --dry-run
```

## What a trace contains / 轨迹里有什么

Per failed run: the request, the plan and risks, which provider ran which step,
the failure stage/category/reason, gateway error samples, evidence locators, the
owner's own pass/fail label, and the last few progress lines. Everything is
passed through PII and token redaction before it is written under
`~/.clone/failed-traces/`.

每次失败的 Run：请求、计划与风险、哪一步由哪个 Provider 执行、失败阶段与类别与原因、网关
错误样本、证据位置、所有者的合格/不合格判定，以及最后几行进度。写入
`~/.clone/failed-traces/` 之前，全部经过 PII 与 token 脱敏。

Implicit failures are recorded too, because no error code names them: a step
retried three or more times, a run the owner cancelled, a run labelled
"不合格", or a "不对，重来" within ten minutes of the run ending.

隐性失败也会记录，因为没有任何错误码会命名它们：同一步骤重试三次以上、所有者取消的 Run、
被判为"不合格"的 Run，或者运行结束后十分钟内出现的"不对，重来"。

## The five gates / 五道闸门

1. **Isolated worktree** — `git worktree add` on `main`; the serving checkout is
   never the place a model writes code.
2. **Test first, verified red by the script** — the model may only add files
   under `test/regression/`; the outer script then runs them and refuses to
   continue if they already pass (that would not be a reproduction).
3. **Tests are hashed** — after the fix phase the same hashes must hold, so a
   model cannot make the suite green by rewriting the test.
4. **Protected paths** — `src/authority/`, `src/core/policy.ts`, `contracts`,
   `.github/`, `scripts/`, `.claude/`, `package.json` may not appear in the diff.
5. **Draft PR only** — the branch is pushed and `gh pr create --draft` runs;
   merging stays with the owner. If `gh` is unavailable a patch file is written
   to `~/.clone/rsi/` instead.

1. **隔离 worktree**；2. **先写测试并脚本验红**；3. **测试文件哈希校验**；4. **受保护路径不可进入 diff**；
5. **只产出草稿 PR**（`gh` 不可用时落为补丁文件）。

The model runs headless (`claude -p`) with a narrow `--allowedTools` list and no
web tools, capped by `--max-turns`. Errors from either phase are written to
`~/.clone/rsi/phase1.json` / `phase2.json`; a lock file prevents overlapping runs.

模型以无头模式运行，`--allowedTools` 很窄、禁用网络工具、限制轮次；两阶段的输出写入
`~/.clone/rsi/`。锁文件防止两次运行重叠。

## Scheduling on macOS / 在 macOS 上定时

Use launchd, not cron: an OAuth-authenticated Claude Code keeps its credentials
in the login Keychain, which a bare cron session cannot unlock. Install
`scripts/com.cloneai.rsi.plist.example` into `~/Library/LaunchAgents/`, adjust
the paths, and load it in the GUI domain:

用 launchd 而不是 cron：OAuth 登录的 Claude Code 把凭据放在登录钥匙串里，纯 cron 会话
解不开它。把示例 plist 放进 `~/Library/LaunchAgents/`，改好路径后在 GUI 域加载：

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cloneai.rsi.plist
launchctl kickstart -k gui/$(id -u)/com.cloneai.rsi   # run once now
```

Set `RSI_NOTIFY_URL` to any endpoint that accepts `POST {"text": "..."}` to get
the morning message; wiring it to WhatsApp is one line once the bridge's sender
is reachable from a CLI.

把 `RSI_NOTIFY_URL` 指向任何接受 `POST {"text": "..."}` 的端点即可收到晨间消息；等 WhatsApp
桥的发送器能被 CLI 调用后，接上它只是改一行。

## What it does not do / 它不做什么

- It does not merge, deploy, restart the daemon, or change its own schedule.
- It does not modify the regression tests, the policy engine, the sandbox, or
  the authority model.
- It does not run when there are no traces, and it keeps the worktree on any
  failure so a person can look.
- It cannot prove a fix is safe: tests plus a diff check bound the damage, and a
  human reads the PR. Treat the PR as a proposal, not a result.

它不合并、不部署、不重启、不改自己的计划；不改测试、策略、沙箱与权限模型；没有轨迹时不运行；
任何失败都保留 worktree。它也无法证明修复是安全的：测试加 diff 检查只是限定伤害范围，PR 仍需人读。
