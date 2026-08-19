# 最小 LLM 闭环

[English](minimal-llm-loop.md) · **简体中文**

这是 Clone AI 第一个刻意保持很小、但真正调用模型的 Agent Loop。它是学习用的垂直切片，
尚未并入生产级 Supervisor Runtime。

```text
用户目标
  -> 持久化 Run 事件
  -> OpenAI Responses 模型选择 Tool
  -> 本地 Tool 在 Workspace 边界内执行
  -> Tool 结果回传模型
  -> 模型给出最终回答
  -> 响应检查 + 持久化完成事件
```

实现位于 `src/loop/`。在它与既有 Supervisor 拥有稳定、共享的 Task 与 Event Contract 前，
它会刻意保持隔离；这样真实的 Loop 就不会被旧的确定性 Demo Adapter 遮住。

## 现在真实具备的能力

- 使用原生 `fetch` 实现的 OpenAI Responses API Adapter，不依赖 SDK。
- 模型可选择的原生 Function Tool：限定在当前 Workspace 的 `list_files` 与 `read_file`。
- 模型选择 Tool、Tool 结果反馈、多轮模型调用和最终回答。
- 为每次模型、Tool 与完成事件写入 `.clone-ai/llm-loop.jsonl` 追加式 JSONL Trace。
- Mock 的 `write_file` Tool：它只返回建议写入的 Receipt，绝不会修改文件系统。
- Checkpoint 与事件重放恢复：重启后执行待处理的安全读取，再从持久化的 Responses 协议历史继续模型。
- Tool Runtime：稳定 Operation ID、协作式超时/取消、风险 Policy、审批路由、Receipt 生成，以及中断后的保守对账。
- 可通过、可重试、要求重规划、要求审批或失败的验证结果。
- 模型调用、Tool 调用、验证重试和耗时的 Run Budget。

## 这个 Loop 刻意尚未包含的内容

- 个人 Memory、SubAgent、Schedule、Connector 与外部副作用。
- 领域级验证；第一版 Verifier 只拒绝空的最终回答。
- 真实的邮件、日历、支付或浏览器 Connector。这样的 Tool 必须先在 `reconcile` 中实现外部 Receipt 查询，
  才能在崩溃后安全重试。
- Provider 上报的 Token/货币预算；当前预算是确定性的：耗时、模型调用、Tool 调用和验证重试。
- 生产级 Claude Code、Codex、Pi 与 opencode 黑盒 Worker 边界；本 Loop 仍是隔离的模型/Tool
  学习垂直切片，不承载这些 Provider 的协议。

## 运行方式

先安装依赖：

```powershell
npm install --ignore-scripts
npm run typecheck
npm test
```

在要运行的 PowerShell 窗口中设置 OpenAI API Key。不要把它放进源码或提交进仓库：

```powershell
$env:OPENAI_API_KEY = "your-key"
$env:CLONE_AI_OPENAI_MODEL = "gpt-5" # 可选，默认值
npm run loop -- "Read README.md and explain the current Clone AI runtime in five bullets."
```

请求会发送给配置的远程模型。Adapter 设置了 `store: false`，并把对话记录保留在本地进程内，
但这仍是远程模型调用；学习这个 Loop 时请使用不含个人敏感信息的仓库。

可直接检查 Trace：

```powershell
Get-Content .clone-ai/llm-loop.jsonl
```

## 推荐代码阅读顺序

1. `src/loop/contracts.ts`：模型、Tool、结果与事件的边界。
2. `src/loop/tools.ts`：受 Workspace 约束的真实读取与 Mock 写入边界。
3. `src/loop/agent-loop.ts`：逐轮状态机与持久化事件顺序。
4. `src/loop/run-state.ts`：Event Projector，事件如何变成可恢复的下一步。
5. `src/loop/checkpoint.ts` 与 `src/loop/recovery.ts`：原子 Checkpoint 写入和 Checkpoint 后事件重放。
6. `src/loop/openai-responses-model.ts`：模型 Function Call 与本地对话记录恢复。
7. `test/agent-loop.test.ts`：无需 API Key 的确定性证明，覆盖 Loop、状态机和 API Adapter Payload。

## 状态机与 Checkpoint

Journal 是追加式的事实来源；Checkpoint 是“下一步安全动作”的物化视图，带有
`lastAppliedSequence` 标记：

```text
事件日志                              Checkpoint
--------                              ----------
model.completed(tool call)     ->    status = waiting_tools
                                      pendingToolCalls = [read_file(...)]
                                      lastAppliedSequence = 4
```

第一版可 Checkpoint 的状态机是：

```text
created -> waiting_model -> running_model
                            |                \
                            | Tool calls       \ final answer
                            v                   v
                       waiting_tools         verifying
                            -> running_tool       -> completed / failed
                            -> waiting_model
```

每写入一个持久事件，Loop 都会投影 `LoopRunState`，并原子替换 `<run-id>.json`。重启时，
`restoreLoopRun` 读取该 Checkpoint，只应用更高 Sequence 的事件。OpenAI Adapter 在每次模型
响应后保存 API 协议历史快照；新的 Adapter 可用它继续下一轮模型调用。

恢复器遵循状态继续，而不是从头重跑任务：

```text
waiting_tools -> 执行待处理的 Tool
waiting_model -> 从 continuation 重建 Model Adapter 并调用它
running_tool  -> 重试前先用稳定 Operation ID 对账
verifying     -> 继续验证
```

只读 Tool 会对账为 `not_started`，可安全重跑。没有对账处理器的副作用 Tool 会安全失败，
而不是被盲目重放。

## Tool 控制与收敛

每个 Tool Call 都有跨恢复保存的 `operationId`。外部执行前，本地 Policy 默认允许读取和可逆本地写入，
要求外部副作用先审批，并拒绝不可逆操作，直到存在更具体的 Policy。

验证是路由决策，而非简单布尔值：

```text
passed         -> completed
retryable      -> 把验证反馈回传模型
needs_replan   -> 把重规划反馈回传模型
needs_approval -> waiting_approval
failed         -> failed
```

该 Loop 也有确定性的安全 Budget。调用方可限制模型调用、Tool 调用、验证重试和总耗时；
预算耗尽时 Runtime 会记录终止失败，而不是无限循环。
