# abort ≠ 停止 / exit ≠ 完成：clone-ai 中的关键概念

你的代码实现了一个**可恢复的执行框架**。这份文档用你的代码来解释那 4 个核心问题。

---

## 前置理解：三个不同的层级

clone-ai 有三个独立的运行时：

1. **Core Runtime**（`src/core/runtime.ts`）— 管理高层级的 Run / Task / Plan
2. **Loop Runtime**（`src/loop/`）— 管理单个 Agent 的 Tool-Call 循环
3. **两者都使用** Journal + Checkpoint 来实现**可恢复性**

本文档聚焦 **Loop Runtime**，因为那是 abort/exit/stop 最容易被混淆的地方。

---

## 问题 1：abort ≠ 停止，exit ≠ 完成 — 为什么？

### 概念表

| 词汇 | 含义 | 对应的状态机状态 | 是否保留中间状态？ |
|------|------|---------|--------|
| **abort** | 放弃这次执行，记录放弃原因 | `cancelled` 或 `failed` | ✅ 保留，为了追查原因 |
| **exit** | 代码函数返回，离开当前作用域 | N/A（只是控制流） | ✅ 保留，可以被调用者检查 |
| **停止** | 立刻中断，清理一切 | 可以是任何状态 | ❌ 可能丢失信息 |
| **完成** | 工作全部做完，状态最终化，写入持久化存储 | `completed` | ✅ 从此不变 |

### 你代码中的例子

#### 1. `exit()` 的含义

在 `src/loop/run-state.ts` 的 `apply()` 方法中：

```typescript
case "run.cancelled":
  requireNonTerminal(this.#state, event.type);
  this.#state.failureReason = readString(readObject(event.payload, event.type).reason, "reason", event.type);
  this.#state.status = "cancelled";
  break;
```

这里 `apply()` 函数会 `return` —— 这就是 **exit**。
- 函数**离开了**（exit）
- 但状态**保留了**（failureReason 被记录）
- 调用者可以检查返回的 state，看看发生了什么

#### 2. `abort()` 的含义

如果你在某个地方想放弃这次运行，你会：

```typescript
// abort = "放弃这个操作，记录原因，但让后续可以分析"
await this.record({
  type: "run.cancelled",
  taskId: run.taskId,
  runId: run.id,
  payload: { reason: "User cancelled the operation" },
});
```

**abort 不等于停止** 因为：
- Journal 仍然记录了这个事件
- 下一次重启，能读出 Journal，知道"我被 abort 了"
- 下一个进程可以检查原因，决定要不要重试

#### 3. `停止` vs `完成` 的区别

**停止**（在 `src/loop/recovery.ts`）：

```typescript
// 只是从 Checkpoint 加载状态
// 如果进程还没写 Checkpoint，那就丢了
const checkpoint = await input.checkpoints.load(input.runId);
```

**完成**（在 `src/loop/run-state.ts`）：

```typescript
case "run.completed":
  requireStatus(this.#state, ["verifying"], event.type);
  if (this.#state.verification?.kind !== "passed") {
    throw new Error("A run cannot complete without passing verification.");
  }
  this.#state.finalAnswer = readString(readObject(event.payload, event.type).answer, "answer", event.type);
  this.#state.status = "completed";  // ← 从此状态不再改变
  break;
```

**区别**：
- 停止 = 进程停了，但不知道完成没
- 完成 = Event 写入 Journal，任何进程都能验证"这次工作做完了"

---

## 问题 2：Supervisor 最终必须保证什么？

### 核心承诺

> **任何情况下（包括进程崩溃、网络中断、超时等），下一个运行的进程都能：**
> 1. **准确知道已经做到哪一步**（通过 Checkpoint）
> 2. **知道接下来打算做什么**（通过 Journal）
> 3. **能够从上次的安全点继续，或者安全回滚**

### 你代码中的保证

在 `src/loop/checkpoint.ts`：

```typescript
async save(state: LoopRunState): Promise<void> {
  await mkdir(this.#directory, { recursive: true });
  const target = this.pathFor(state.runId);
  const temporary = `${target}.tmp`;
  // 先写临时文件
  await writeFile(temporary, JSON.stringify(state, null, 2), "utf8");
  // 原子替换（rename 在大多数文件系统上是原子操作）
  await rename(temporary, target);
}
```

**为什么这样做？** 
- ✅ 防止进程在写到一半时 crash，导致读到半文件
- ✅ 原子替换保证任何时刻读到的都是完整状态

在 `src/loop/recovery.ts`：

```typescript
export async function restoreLoopRun(input: {
  runId: string;
  journal: LoopJournal;
  checkpoints: LoopCheckpointStore;
}): Promise<LoopRunState> {
  // 1. 加载最新的 Checkpoint（已落地的、稳定的）
  const checkpoint = await input.checkpoints.load(input.runId);
  // 2. 加载所有比 Checkpoint 新的 Journal Event
  const laterEvents = (await input.journal.list(input.runId)).filter(
    (event) => event.sequence > (checkpoint?.lastAppliedSequence ?? 0),
  );
  // 3. 重放这些 Event，恢复状态机
  return projectLoopRun(laterEvents, checkpoint);
}
```

**Supervisor 保证**：
- ✅ Checkpoint 是"已确认的安全点"
- ✅ Journal 记录之后发生的所有"意图"
- ✅ 重新启动时，能自动恢复到"最近一次安全点"之后

---

## 问题 3：进程 A 死亡 → Journal 保留什么 / Checkpoint 保留什么

### 时间线

```
进程 A 的执行过程：
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│  操作 1 ──→ journal.append("tool.requested")     sequence: 1  │
│             ✅ 已写入 Journal（磁盘）                        │
│                                                              │
│  操作 1 完成 ──→ journal.append("tool.completed")  sequence: 2  │
│             ✅ 已写入 Journal（磁盘）                        │
│             ↓                                                │
│          checkpoint.save(state)                              │
│             ✅ 已写入 Checkpoint（磁盘）                      │
│          → { lastAppliedSequence: 2, ... }                   │
│                                                              │
│  操作 2 ──→ journal.append("tool.requested")     sequence: 3  │
│             ✅ 已写入 Journal（磁盘）                        │
│             Tool 执行中...                                    │
│             [CRASH] ❌ 进程 A 死亡                            │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 什么被保留

#### Journal 保留

```javascript
// 从 src/loop/journal.ts 的 JSONL 文件
{ "id": "...", "sequence": 1, "runId": "xyz", "type": "tool.requested", "payload": {...} }
{ "id": "...", "sequence": 2, "runId": "xyz", "type": "tool.completed", "payload": {...} }
{ "id": "...", "sequence": 3, "runId": "xyz", "type": "tool.requested", "payload": {...} }
// ← 进程 crash 在这里，但日志已经记录
```

**Journal 记录**：
- ✅ 操作 1, 2 的完整细节
- ✅ 操作 3 的**参数**（Model 选择执行这个 Tool 的参数）
- ✅ 操作 3 的 `operationId`（稳定 ID，用于幂等检查）
- ❌ 操作 3 的**结果**（还没完成）

#### Checkpoint 保留

```javascript
// 从 src/loop/checkpoint.ts 的 JSON 文件
{
  "runId": "xyz",
  "lastAppliedSequence": 2,      // ← 只到这里为止
  "status": "waiting_tools",      // ← 状态：等待操作 3 的结果
  "pendingToolCalls": [           // ← 操作 3 还在待办中
    {
      "id": "call-123",
      "name": "file_edit",
      "arguments": { "path": "...", "content": "..." }
    }
  ],
  "messages": [
    { "role": "user", "content": "..." },
    { "role": "tool", "callId": "call-122", "toolName": "file_read", "result": {...} }
    // ← 操作 2 的结果已记录
  ],
  "activeToolCallId": "call-123",  // ← 正在运行操作 3
  "budget": { "modelCalls": 1, "toolCalls": 2, ... }
}
```

**Checkpoint 记录**：
- ✅ Model 已收到的前 2 个操作的结果
- ✅ 第 3 个操作的参数（还没结果）
- ✅ 状态机的当前状态（`waiting_tools`）
- ❌ 第 3 个操作的执行结果（因为它还没完成）

### 核心区别

| 项目 | Journal | Checkpoint |
|------|---------|-----------|
| **用途** | 记录"发生了什么" | 记录"现在什么状态" |
| **是否完整** | 可能很长（历史完整） | 只是最近一个安全点的快照 |
| **操作 3 的参数** | ✅ 有（sequence 3） | ✅ 有（在 pendingToolCalls） |
| **操作 3 的结果** | ❌ 没有（还没执行完） | ❌ 没有（还没执行完） |
| **操作 1-2 的详情** | ✅ 全部（完整历史） | ⚠️ 只有结果（已合并到 messages） |

---

## 问题 4：进程 B 如何决定下一步？

### 恢复流程

进程 B 启动时的决策树：

```typescript
// 1. 恢复状态
const restored = await restoreLoopRun({
  runId: "xyz",
  journal: loopJournal,
  checkpoints: loopCheckpoints,
});

// 2. 检查恢复后的状态
const state = restored;
// state = {
//   status: "waiting_tools",
//   lastAppliedSequence: 2,
//   pendingToolCalls: [{ id: "call-123", name: "file_edit", ... }],
//   activeToolCallId: "call-123",
//   ... 
// }

// 3. 决策：接下来做什么？
if (state.status === "waiting_tools") {
  // 情况 A：有待执行的 Tool
  const operationId = state.activeToolCallId;
  
  // A-1: 检查这个 Tool 是否已经真的执行过了
  const reconciliation = await toolDefinition.reconcile?.({
    runId: state.runId,
    call: state.pendingToolCalls[0],
    operationId,  // 幂等关键：同一个操作 ID
  });
  
  if (reconciliation?.status === "completed") {
    // A-2: Tool 已经做过了，只是没写入 Journal
    // → 补齐 Journal
    const result = reconciliation.result;
    await journal.append({
      type: "tool.completed",
      payload: { callId, toolName, result },
    });
    // → 继续循环
  } else if (reconciliation?.status === "not_started") {
    // A-3: Tool 还没做过，从头做
    const result = await toolDefinition.execute(...);
    await journal.append({
      type: "tool.completed",
      payload: { callId, toolName, result },
    });
  } else if (reconciliation?.status === "unknown") {
    // A-4: 不知道是什么状态，无法安全恢复
    // → 报错或放弃
    throw new Error("Cannot safely recover tool state");
  }
} else if (state.status === "waiting_model") {
  // 情况 B：等 Model 响应
  // → 继续调用 Model（使用 ModelContinuation 恢复 Provider 状态）
  const model = modelFactory(state.modelContinuation);
  const response = await model.respond({
    instructions: state.instructions,
    messages: state.messages,
    tools: toolSchemas,
  });
} else if (state.status === "completed") {
  // 情况 C：已经完成
  // → 什么都不做
  return state.finalAnswer;
}
```

### 你代码中的实现

在 `src/loop/run-state.ts` 中，`apply()` 方法就是**状态机的心脏**：

```typescript
apply(event: LoopEvent): LoopRunState {
  // 检查 Event 是否已经应用过（幂等性）
  if (event.sequence <= this.#state.lastAppliedSequence) {
    return this.snapshot();  // ← 已应用过，直接返回
  }

  // 根据当前状态 + 新 Event，转移到下一个状态
  switch (event.type) {
    case "tool.completed": {
      requireStatus(this.#state, ["running_tool"], event.type);
      // ... 更新状态 ...
      this.#state.status = this.#state.pendingToolCalls.length === 0 
        ? "waiting_model" 
        : "waiting_tools";
      break;
    }
    case "run.cancelled": {
      requireNonTerminal(this.#state, event.type);
      this.#state.status = "cancelled";
      break;
    }
  }

  // 更新"最后应用的序列号"，防止重复应用
  this.#state.lastAppliedSequence = event.sequence;
  return this.snapshot();
}
```

### 进程 B 的决策表

进程 B 读到 `restored` 状态后：

| 恢复状态 | 进程 B 决策 | 理由 |
|----------|-----------|------|
| `status === "waiting_model"` | 继续调用 Model | 用 modelContinuation 恢复 Provider 状态 |
| `status === "running_tool"` | 调用 reconcile | 查这个 Tool 是否已经真的做过了 |
| `status === "waiting_tools"` | reconcile 后再做 Tool | 有待办的 Tool |
| `status === "waiting_approval"` | 等待用户批准 | 下一步需要授权 |
| `status === "verifying"` | 继续验证 | 重新运行 Verifier |
| `status === "completed"` | 返回 finalAnswer | 工作全部做完 |
| `status === "failed"` | 抛出错误 | 无法继续 |
| `status === "cancelled"` | 抛出错误 | 被人为取消 |

---

## 关键变量解释：那些你看不懂的名字

### 在 `LoopRunState` 中

从 `src/loop/contracts.ts`：

```typescript
export interface LoopRunState {
  runId: string;                          // ← 这次运行的唯一 ID
  status: LoopRunStatus;                  // ← 状态机当前状态
  turn: number;                           // ← Model 和 Tool 互动了多少轮
  messages: LoopMessage[];                // ← 发送给 Model 的完整消息历史
  pendingToolCalls: ToolCall[];           // ← 还没执行的 Tool
  approvedToolCallIds: string[];          // ← 已获批的 Tool ID（用于权限控制）
  budget: {
    modelCalls: number;                   // ← Model 被调用了几次
    toolCalls: number;                    // ← Tool 被执行了几次
    verificationRetries: number;          // ← 验证失败重试的次数
    limits: {
      maxModelCalls?: number;
      maxToolCalls?: number;
      maxVerificationRetries?: number;
      maxDurationMs?: number;
    };
  };
  lastAppliedSequence: number;            // ← 最后应用的 Journal Event 序列号（防重复）
  activeToolCallId?: string;              // ← 正在运行的 Tool ID
  activeToolOperationId?: string;         // ← 正在运行的 Tool 的幂等 ID
  finalAnswer?: string;                   // ← 最终答案（完成时才有）
  failureReason?: string;                 // ← 失败原因
  verification?: VerificationOutcome;     // ← 验证结果
  modelContinuation?: ModelContinuation;  // ← Provider 状态快照（用于恢复 Provider 会话）
}
```

### 核心概念

**`lastAppliedSequence` = 防重复的钥匙**

```typescript
// 在 LoopRunProjector.apply() 中
if (event.sequence <= this.#state.lastAppliedSequence) {
  return this.snapshot();  // ← 已经应用过，不再重复
}
```

为什么需要？
- 进程 B 启动时，可能读到了 Event sequence 1, 2, 3
- 但 Checkpoint 已经包含 Event 1, 2 了
- 所以 `lastAppliedSequence = 2`
- 只应用 Event 3

**`operationId` = 幂等性的基础**

```typescript
// 在 Tool 执行中
const execution: ToolExecution = {
  runId,
  call,
  operationId: "uuid-stable-across-restart",  // ← 关键
};

// 进程 crash 并重启后
const reconciliation = await tool.reconcile?.({ operationId });
// 用这个稳定 ID 查询：这个操作真的做过吗？
if (reconciliation?.status === "completed") {
  // 是的，做过了，拿结果
}
```

**`modelContinuation` = Provider 恢复的钥匙**

```typescript
// 在 src/loop/run-state.ts 的 setModelContinuation()
setModelContinuation(continuation: ModelContinuation | undefined): void {
  this.#state.modelContinuation = continuation;
}

// 进程 B 启动时
const model = modelFactory(restored.modelContinuation);
// 用这个状态快照，恢复与 Provider（比如 OpenAI）的会话
```

---

## 总结：概念之间的关系

```
┌─ Journal ─────────────────────────────────────────┐
│ 仅追加，记录"发生过什么"                           │
│ seq: 1, 2, 3, 4, 5, ...                            │
│ [tool.requested, tool.completed, ...]             │
└─────────────────────────────────────────────────────┘
                      ↓ 重放
                   apply(event)
                      ↓
┌─ Checkpoint ───────────────────────────────────────┐
│ 由 runState 定期保存的快照                         │
│ lastAppliedSequence: 2                             │
│ status: waiting_tools                              │
│ messages, pendingToolCalls, ...                    │
└─────────────────────────────────────────────────────┘
                      ↓ 进程 crash
                   进程 B 启动
                      ↓
         ┌─ 恢复状态 ─────────────┐
         │ Load Checkpoint        │
         │ + Replay Events 3-5    │
         │ = 完整状态             │
         └────────────────────────┘
                      ↓
         ┌─ 决策 ───────────────────┐
         │ 如果 status = running_tool│
         │   → reconcile(operationId)│
         │ 如果 status = waiting_model│
         │   → 继续调 Model          │
         └────────────────────────────┘
```

---

## 最后的关键区别表

| 概念 | 含义 | 是否保留中间状态 | 是否可恢复 | 示例 |
|------|------|--------|---------|--------|
| **abort** | 标记为已放弃 | ✅ 保留（Journal） | ✅ 能读出原因 | `run.cancelled` |
| **exit** | 函数返回 | ✅ 保留（调用者检查） | ✅ 调用者能看到返回值 | `apply()` return |
| **停止** | 进程中止 | ⚠️ 取决于是否写过 Checkpoint | ⚠️ 取决于持久化程度 | 进程被 kill -9 |
| **完成** | 工作全部做完 | ✅ 保留（状态不变） | ✅ 完全可恢复，且不再改变 | `status === "completed"` |
| **Supervisor 承诺** | 任何情况都能恢复 | ✅ 全部保留 | ✅ 最强保证 | `restoreLoopRun()` |

