# 本地浏览器验收（Playwright MCP）

[English](browser-mcp.md)

clone-ai 的原生 Worker 只有四个文件工具。它能写出一个页面，却不知道页面能不能跑。
本页把**本地、由所有者开启的浏览器**接成 MCP 工具源：Worker 可以打开刚写好的页面、读控制台、
断言状态，并给所有者留下一张截图。

底层是 Playwright MCP（微软的 `@playwright/mcp`）。clone-ai 不发布、不修改这个服务器；
它提供的是围绕它的策略。

## Worker 能拿到什么

| 工具 | 风险 | 用途 |
| --- | --- | --- |
| `playwright.browser_navigate` | read | 打开 `http://127.0.0.1:<端口>/` |
| `playwright.browser_console_messages` | read | 改动后读错误/警告 |
| `playwright.browser_snapshot` | read | 可访问性快照（DOM/菜单） |
| `playwright.browser_evaluate` | write | 读游戏/DOM 状态、断言数值 |
| `playwright.browser_press_key` | write | 按一个键（菜单、简单控制） |
| `playwright.browser_take_screenshot` | write | 在工作区内保存 PNG |
| `playwright.browser_resize` | write | 1280×720 / 1920×1080 布局检查 |
| `playwright.browser_wait_for` | read | 等待文本或一小段时间 |
| `playwright.browser_navigate_back` | read | 页面前进/后退 |
| `playwright.browser_close` | read | 关闭页面 |

`browser_run_code_unsafe`、文件上传、拖放**没有声明**；即使服务器提供，Worker 也看不到。

Worker 看不见图片。截图是给所有者的；Worker 必须用 `browser_evaluate` 断言和控制台错误来验收。

## 安装

```bash
node --experimental-strip-types scripts/install-browser-mcp.mjs \
  --workspace /path/to/project \
  --port 8135
```

这会在 clone home（默认 `~/.clone`）写入两个文件：

- `mcp.json`：启用的 `playwright` 服务器，根目录为工作区，工具按上表声明并分级；
- `policies.json`：一条很窄的 `network read 127.0.0.1` 常设策略。

然后在另一个终端启动只读预览服务器：

```bash
node scripts/serve-workspace.mjs --root /path/to/project --port 8135
```

重启运行时，Worker 才会用新的 `mcp.json` 重建工具表。服务器只服务 `--root` 内的文件、
绑定 `127.0.0.1`、只支持 GET/HEAD，并为 ES 模块设置正确的 MIME。

要求：Node 24+、已安装 Google Chrome、`npx` 可用。首次启动会下载
`@playwright/mcp@0.0.85`，之后走 npx 缓存；浏览器使用已安装的 Chrome，不需要再下载 Chromium。

## 在任务里使用

在工作区放一段说明即可，用户提示词保持简短：

```markdown
## Local browser verification
A read-only static server serves this workspace at http://127.0.0.1:8135/.
After editing a page, navigate once, check console errors, assert the important
state with browser_evaluate, and take one screenshot for the owner.
```

之后一句"把方块改成绿色，写完自己用浏览器验收"就够了：主 Agent 规划修改，Worker 真的能验收。

## 安全边界

- 浏览器是**无头**、**隔离**、以工作区为根目录的。
- 声明的来源是本地预览服务器。其他主机不在工具声明的用途内；服务器配置了
  `--allowed-origins`，但正如 Playwright 文档所说，这个开关不是安全边界。
- `browser_navigate` 声明为 **read**，因为它是对所有者自己预览页面的本地观察。这样只读步骤
  不需要网络 Scope。`browser_evaluate` 与截图声明为 **write**，因为它们改变页面状态或创建文件。
- 浏览器子进程由 Worker 的 MCP 客户端启动，步骤结束时关闭。它不是 OS 沙箱；工具声明与工作区
  根目录才是边界。
- 只对愿意让浏览器读取的开发工作区启用。不要把 `--workspace` 指向存有凭据的目录。
- 首次启动需要联网下载 `npx` 包；之后服务器是本地的。

## 卸载

把 `mcp.json` 中 `playwright` 服务器的 `"enabled"` 设为 `false`，或删除该条目。不再需要
localhost 授权时，从 `policies.json` 删除 `browser-mcp-local-observation` 策略。重启运行时。

## 状态

声明与接线由 `test/browser-mcp.test.ts` 覆盖。端到端运行（Worker 真的导航、读控制台、断言状态
并保存截图）记录在
[`docs/engineering/optimizations.md`](../engineering/optimizations.zh-CN.md) 的
2026-11-17 — Local browser verification via Playwright MCP 条目。
