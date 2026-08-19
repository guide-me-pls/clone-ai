# 黑盒 Agent 边界

[English](coding-cli-adapters.md) · **简体中文**

Clone AI 把 Coding Agent 当作黑盒：只提供 Prompt 与 Workspace，然后仅凭观察判断结果——
进程退出状态，以及磁盘上真正发生了什么变化。不解析任何 Agent 的内部协议、流式格式或会话模型。

```text
WorkOrder -> 策略 + 能力检查
  -> BlackBoxWorkerAdapter    传入 Prompt · 预算 · 硬截止 · 终止
     |                        执行前/后对 Workspace 拍快照
  <- 退出状态 + Workspace 差异 + 输出尾部
-> Artifact -> 验证 -> WorkReceipt
```

## 接入一个 Agent 是改配置

任何无头 Agent 都只是一份启动配方。在 `<dataDirectory>/providers.json` 里声明一条，它就可以
被选用——不改源码，不写 Adapter 类：

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

`{{prompt}}` 与 `{{workspace}}` 会在派发时替换。`promptVia: "stdin"` 表示通过 stdin 而不是
参数传入 Prompt。与内建 ID 相同的声明会覆盖内建项，因此所有者可以重新调整自带 Agent 的启动方式。

| 内建 | 命令 |
| --- | --- |
| Claude Code | `claude -p {{prompt}}` |
| Codex CLI | `codex exec --skip-git-repo-check {{prompt}}` |
| Pi | `pi -p {{prompt}}` |
| opencode | `opencode run {{prompt}}` |

**权限边界：** Provider 声明只说明如何启动某个 Agent、以及它可以看到哪些凭据。它不能授予审批、
不能扩大预算、不能改变 Run 状态、不能宣布成功。

## 证据靠观察，不靠索取

黑盒 Agent 不知道 Clone AI 的约定，也不能被指望去申报自己产出了什么。因此 Clone AI 不去问它：
派发前对 Workspace 拍快照，结束后做差异比较，新增与修改的文件就是产物，每一条都用真实路径作为
locator 记录。

这比之前"要求 Worker 打印一行声明"更严格，因为它**不需要对方配合**。它同时也解决了完成判定：
当 WorkOrder 要求产物而 Workspace 毫无变化时，工作就是没有发生——无论 Agent 说了什么。
被删除的文件是真实变更，但永远不是产物。

Receipt 仍然不可授予。Artifact 只能证明某个文件存在；只有可信运行时才能证明外部动作确实发生。

## 失败要在 Agent 之间比较

每次失败都会被归入一个粗粒度类别——`launch_failed`、`timeout`、`aborted`、`nonzero_exit`、
`no_artifact`、`missing_credential`、`missing_input`、`permission_denied`、`network`、
`unknown`——并附带一个去掉了路径、ID、数字与时间戳的归一化 signature。

重试时 Runtime 会刻意换**另一个** Provider。重复同一个黑盒很少产生不同结果，而第二个意见正是
下一步得以成立的前提：

```text
Agent A 失败 ─┐
              ├─ 原因不同   -> 再换一个 Agent
Agent B 失败 ─┘
              └─ 诊断类别相同
                    -> 障碍在任务或环境中
                    -> 停止重试，升级给所有者
```

在**有诊断意义的**类别上一致（两个 Agent 都找不到凭据）本身即构成印证，因为各自独立的产品会用
自己的措辞描述同一堵墙。而在兜底类别（`nonzero_exit`、`unknown`）上一致本身什么都不能证明，
因此这些类别还额外要求措辞重合。

## 黑盒的代价

| 特性 | 后果 |
| --- | --- |
| 不解析协议 | 任何无头 Agent 都能靠配置接入 |
| 没有会话身份 | 崩溃后是**重跑**，不是续跑 |
| 没有工具事件 | 进度就是 Agent 自己的输出行，没有更细粒度 |
| 证据来自文件系统 | 没写进文件的工作，等于没做 |

失去续跑是不解析协议的诚实代价：不读 Agent 的会话模型，就没有会话 ID 可以重新打开。
幂等性由 WorkOrder 的 `maxAttempts` 以及"产物是可观察事实"这一点来承担。

## 已验证与尚未声称

- 完整的黑盒链路由针对脚本化 Agent 的测试覆盖：workspace-diff 产物、只说话不写文件的 Agent、
  命令不存在、卡死 Agent 撞上硬截止、环境白名单，以及跨 Provider 的交叉印证。
- 类型检查与自动化测试套件在不产生付费请求的情况下通过。
- **黑盒重写之后**尚未对真实安装的 Agent 做过实跑；内建启动配方来自各产品文档中的无头模式，
  属于推断而非观察。
- `workspace-diff` 会遍历文件系统并跳过常见构建目录。超大 Workspace 以 20,000 个文件为上限，
  超过 2 MB 的文件用大小与修改时间而非内容哈希标识。
