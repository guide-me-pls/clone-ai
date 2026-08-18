# Pi 源码精读：agent loop · session 持久化 · 扩展与工具注册（阶段 B 第 1 步）

> 记录时间：2026-08-18 · 精读对象：`@earendil-works/pi-coding-agent` 0.84.2（npm 全局安装）
> 阅读入口：`node_modules/@earendil-works/pi-coding-agent/dist/` 与
> `node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/`
> 配套示例：`examples/sdk/01-13`、`examples/extensions/`（重点：`permission-gate.ts`、`plan-mode/`）
>
> 目的：阶段 B 第 2 步要在 Pi SDK 上起 `clone-main` agent（提案型工具 + Kernel 校验）。
> 本文回答三个问题：循环怎么跑、状态怎么活、工具怎么挂。

---

## 1. Agent Loop（`agent.js` 422 行 + `agent-loop.js` 553 行）

### 1.1 Agent：有状态的事件循环包装器

```text
Agent（agent.js）
├── state      systemPrompt / model / thinkingLevel / tools / messages / isStreaming / pendingToolCalls
├── prompt()   新消息 → runAgentLoop
├── continue() 从最后一条继续（最后必须是 user/toolResult；是 assistant 则先排空队列）
├── 队列        steeringQueue（当前 turn 结束后注入）/ followUpQueue（agent 将停止时运行）
├── 生命周期    runWithLifecycle：activeRun = { abortController, promise }
│              handleRunFailure → 生成 stopReason=aborted|error 的 assistant 消息
└── 事件        message_start/update/end · tool_execution_start/end · turn_end · agent_end
               listeners 顺序 await；agent_end 后仍等 listener 全部 settle 才算 idle
```

要点：

- **Agent 不绑定 provider**：`streamFn`（streamFunction）由外部注入，`convertToLlm` 负责把内部消息转成 provider 格式——这是"Pi 形态可以换 loop、Kernel 状态不跟着走"的代码基础。
- **钩子（全部可选）**：`beforeToolCall` / `afterToolCall` / `shouldStopAfterTurn` / `prepareNextTurn(+WithContext)` / `getSteeringMessages` / `getFollowUpMessages`。
- **`agent_end` ≠ 空闲**：事件监听器全部 settle 之后才算 idle（`waitForIdle()`）。这正是 RPC 模式里 `agent_settled` 语义的来源——完成信号要等持久化监听器落盘。

### 1.2 runLoop：双层循环

```text
外层 while(true)：                       ← followUp 队列驱动
  内层 while(hasMoreToolCalls || pending)：
    turn_start
    注入 steering 消息（message_start/end 并进 context）
    streamAssistantResponse → assistant 消息
    stopReason=error|aborted → turn_end + agent_end，立即返回
    提取 toolCalls → 执行（parallel 默认 / sequential）→ toolResult 消息入 context
    turn_end
    prepareNextTurn → 可换 model / reasoning / context（下一轮快照）
    shouldStopAfterTurn → 是则 agent_end 返回
    拉取新的 steering 消息
  内层退出 → 检查 followUp 队列，有则作为 pending 继续外层
  agent_end
```

关键细节：

- **`streamAssistantResponse`**：`transformContext` → `convertToLlm` → `streamFunction(model, {systemPrompt, messages, tools}, config)` → 事件流（`start`/`text_delta`/`toolcall_delta`/`done`/`error`）→ partial message 就地更新 `context.messages` 末尾 → `response.result()` 取最终消息。
- **工具执行管线**（`prepareToolCall` → `executePreparedToolCall` → `finalizeExecutedToolCall`）：
  1. 按名字查工具，找不到 → 立即 error result；
  2. `prepareArguments`（参数预处理）→ `validateToolArguments`（schema 校验）；
  3. **`beforeToolCall` 钩子**：可返回 `{ block: true, reason }`（可带 `terminate: true` 终止整个回合）；
  4. `tool.execute(toolCallId, args, signal, onUpdate)`；
  5. **`afterToolCall` 钩子**：可改写 content/details/usage/terminate。
- **`stopReason = "length"`**：输出被 token 上限截断时，该消息里的所有工具调用**全部作废**（参数可能不完整），逐个回 error 让模型重新发起。
- **`shouldTerminateToolBatch`**：一批工具结果全部 `terminate: true` 才终止循环。

### 1.3 对 clone-main 的含义

| 机制 | 用途 |
|---|---|
| `beforeToolCall` / 工具 execute 内 | **Kernel 校验的两个挂点**（提案型工具：propose_work_plan 等） |
| `stopReason=error/aborted → agent_end` | "崩溃即失败"语义，与 RPC 模式 `agent_settled` 对齐 |
| `prepareNextTurn` | 每轮后可换模型/思维级别（规划用高思维、执行用快模型） |
| steering / followUp 队列 | 外部事件（审批结果、Kernel 通知）注入常驻对话的通道 |

---

## 2. Session 持久化（`harness/session/`）

### 2.1 文件布局（`jsonl/repo.js`）

```text
<sessionsRoot>/--<cwd 转义>--/<ISO时间戳>_<id>.jsonl
第一行 header：kind="header" · version=4 · id · createdAt · cwd · parentSessionId · metadata
```

`create / open / fork / delete / list`；sessionId 白名单正则；同进程 create/fork 用 `activeCreateDestinations` 防竞争。

### 2.2 追加写 + 内存投影（`storage.js` + `state.js`）

写路径（每次变更）：

```text
enqueue（串行 tail 链）→ appendFile 一行（encodeMutation）→ state.applyMutation 同步投影
```

**`SessionState.applyMutation` 是唯一变更入口**，四条校验（违反即抛 `SessionError invalid_entry`）：

1. `seq` 必须等于 `sequence + 1`（乱序/重放拒绝）；
2. entry/record id 全局唯一；
3. entry 的 `parentId` 必须等于 lane 当前 leaf（**必须链到分支末端**）；
4. `parentId` 必须存在、record 必须引用存在的 lane。

四种 mutation：

| kind | 内容 |
|---|---|
| `entry` | message / model_change / thinking_level_change / active_tools_change / compaction / branch_summary / custom |
| `record` | operation_started / abort_requested / operation_finished / step_attempt / tool_started / queue_enqueued / queue_cancelled / write_deferred / usage |
| `lane` | 分支指针（leafId）——`view(lane)` 是分支会话视角 |
| `fact` | name / label |

**崩溃一致性**（`storage.js` `load`）：

- 加载时若**最后一行**是语法错误（torn tail）→ 判为未确认的半截追加 → 原子修复：有效前缀写 `.tmp` 再 rename 覆盖；
- 文件不以 `\n` 结尾 → 补写；
- codec 白名单外的类型/版本 → **拒绝加载**（`schema` 错误）。

**恢复 = 全量重放 mutations**（无快照；`compaction` entry 是唯一的压缩手段）。恢复时自动还原 model / thinking_level / active_tools（它们是 entry 类型）。

**open operations**：`operation_started` 入 `openOperationsByLane`，`operation_finished` 删除；**同一 lane 同时只能有一个 open operation**——这是"工具操作可恢复"的存储基础。

### 2.3 对 clone-main 的含义

- **扩展状态也走 session**：`pi.appendEntry("plan-mode", {...})` 持久化，`session_start` 时从 entries 恢复、重扫消息重建进度（`plan-mode/` 示例的标准做法）；
- clone-main 的 WorkPlan / 审批记录可以做成 **custom entries**（可审计、可恢复、与对话同文件）；
- "状态是投影、journal 是真相"——与 clone-ai 自己的 Journal→投影模型同构，两侧概念一一对应。

---

## 3. Extension 与工具注册（`dist/core/extensions/`）

### 3.1 发现与加载（`loader.js` 581 行）

```text
发现顺序：<cwd>/.pi/extensions/ → ~/.pi/agent/extensions/ → 显式配置路径
规则：*.ts/*.js 直接文件 · 子目录 index.ts/js · package.json "pi.extensions" 清单（不递归）
加载：jiti import → default export 必须是一个 factory 函数 → factory(ExtensionAPI)
```

**ExtensionAPI 两类方法**：

| 类 | 方法 |
|---|---|
| 注册类 | `on(event, handler)` / `registerTool` / `registerCommand` / `registerShortcut` / `registerFlag` / `registerMessageRenderer` / `registerProvider` |
| 动作类 | `sendMessage` / `sendUserMessage` / `appendEntry` / `setSessionName` / `setLabel` / `exec` / `getActiveTools` / `setActiveTools` / `getCommands` / `setModel` / `getThinkingLevel` / `setThinkingLevel` / `events` |

### 3.2 注册链路与拦截链（`runner.js` + `wrapper.js` + `agent-session.js`）

```text
factory(api)
  → api.registerTool(tool) → extension.tools.set + runtime.refreshTools()
  → AgentSession._bindExtensionCore 提供的 refreshTools → _refreshToolRegistry
  → agent.state.tools 更新（模型下一轮可见）

工具调用拦截（AgentSession._installAgentToolHooks）：
  agent.beforeToolCall → runner.emitToolCall → 扩展 tool_call 处理器
     返回 { block: true, reason }    → 拦截（可选 terminate）
     返回 { content: [...] }         → 替换输入
  agent.afterToolCall  → runner.emitToolResult → 扩展 tool_result 处理器
     返回 { content, details, isError } → 改写结果
```

工具包装（`wrapper.js`）：每个注册工具被 `wrapRegisteredTool` 包一层，注入 `runner.createContext()`（工具执行时能拿到会话上下文），并跟踪 `addedToolNames`（工具执行中动态添加的工具）。

### 3.3 两个参考实现

**`permission-gate.ts`（拦截模式）**：`pi.on("tool_call")` → 危险 bash 正则 → 无 UI 时默认 `block`（安全默认），有 UI 时问用户。这就是"预测不是权限"的扩展版——**Kernel 校验可以直接挂在这里**。

**`plan-mode/`（完整 Main Agent 参考）**：

- `registerFlag` / `registerCommand` / `registerShortcut` 入口；
- `setActiveTools` 切换模式（plan 模式禁用 edit/write，bash 白名单）——**用工具集合表达权限**；
- `before_agent_start` 注入模式上下文（customType 消息，display:false）；
- `appendEntry("plan-mode", state)` 持久化 + `session_start` 恢复 + 重扫消息重建进度；
- `turn_end` 追踪 `[DONE:n]` 进度；`agent_end` 提取计划步骤、`ctx.ui.select` 询问下一步；
- `sendMessage({customType}, { triggerTurn, deliverAs })` 控制续跑。

---

## 4. SDK 用法速览（`docs/sdk.md` + `examples/sdk/`）

```ts
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

const modelRuntime = await ModelRuntime.create();
const { session } = await createAgentSession({
  model,                    // 可选，缺省从 settings/认证恢复
  tools: ["read", "bash"],  // 内置工具名选择；自定义工具走扩展注册
  sessionManager: SessionManager.create(cwd),  // 或 inMemory()
});

session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});
await session.prompt("...");
session.dispose();
```

- `AgentSession`：prompt / steer / followUp / subscribe / abort / compact / setModel / setThinkingLevel / messages / isStreaming；
- `createAgentSessionRuntime()` + `AgentSessionRuntime`：会话替换（new/resume/fork/import）——interactive、print、RPC 三种模式共用这一层；
- 自定义工具：`examples/sdk/06-extensions.ts`（扩展注册）与 `examples/extensions/tools.ts`。

---

## 5. 阶段 B 第 2 步设计（clone-main 原型）

```text
入口：createAgentSession({
        model,                                  // clone-ai 配置的模型
        tools: [...提案型工具],                  // 无内置文件/写工具（与 RPC 版一致的安全姿态）
        sessionManager: SessionManager.create(cloneWorkspace),
      })

提案型工具（每个工具 execute 内过 Kernel 校验，可叠加 tool_call 拦截双保险）：
  propose_work_plan   → Kernel 校验 WorkOrder 图（复用 contracts.ts 校验）→ journal
  request_approval    → 审批门（risk=external/irreversible 必须 approval.granted）
  recall_memory       → Memory 召回（当前 local Memory 实现）
  get_run_status      → Run 投影查询（只读）

持久化：WorkPlan / 审批记录 = custom entries（复用 Pi session 持久化，可审计可恢复）
校验挂点：工具 execute 内（主）+ tool_call 拦截（permission-gate 模式，兜底）
```

设计要点：**Main Agent 只有提案工具，没有任何完成判定能力**——`completed`/`evidence` 由 Kernel 发出（与现有 LLM Planner 的 `create_work_plan` 校验后生效同一模式），RPC 版 adapter 的边界约束在进程内版全部保留。
