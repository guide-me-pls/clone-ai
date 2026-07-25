# clone-ai

> **面向个人 AI 分身的本地优先连续性运行时。**
>
> **Agent 会更换，你的工作会继续。**

[English](README.md) · **简体中文**

> 状态：实现前架构设计。**clone-ai 是暂定工作名**，最终名称仍需完成商标、
> 域名和包注册表核查。

## 它是什么

clone-ai 是一个让个人工作能够跨 Agent、跨 Session、跨中断、跨模型升级持续存在的运行时。

它观察用户电脑上真实发生的工作，把重要活动写入追加式事件日志，将事件投影为可恢复的工作状态，
调度可替换的 AI Agent，验证其产物，并且只把经过治理的事实提升为长期记忆。

近期产品是面向开发者的 **Personal Work Runtime（个人工作运行时）**。长期方向是
**Digital Self Runtime（数字自我运行时）**：由用户拥有的连续性基础设施。它可以借助
Claude Code、Codex、Pi 以及未来独立的 Agent Runtime 工作，但不会让任何一个运行时成为用户身份或
记忆的主人。

clone-ai 不是另一个多 Agent 启动器。它的核心承诺是：

> AgentSession 可以消失，工作、证据、权限和记忆不能随之消失。

clone-ai 位于各个独立 Agent Runtime 之上：它不 Fork、嵌入或把任何一个 Runtime 当成子 Agent。
clone-ai 负责连续性和治理；被接入的 Runtime 只提供受边界约束的执行能力。

“本地优先”表示权威和规范状态保存在用户电脑上，并不表示每个 Worker 都必须离线运行。
Adapter 可以调用云端模型，但发送到设备之外的上下文必须明确、受限，并由策略控制。

## 为什么需要它

今天的 Agent 很强，但它们通常是临时的：

- 每个新 Session 都要从聊天记录和散落文件中重新拼装上下文。
- 更换 Agent 时，决策、约束和未完成工作需要人工搬运。
- Agent 可以宣称成功，却没有证明用户要求的结果真的存在。
- 长对话把临时工作状态和应该长期保留的个人记忆混在一起。
- 工具输出、外部内容和模型断言经常被赋予相同的信任等级。
- 进程崩溃后，系统可能连“下一步应该做什么”都无法可靠恢复。

缺少的不是一个更聪明的模型，而是模型之外的持久化运行时：由它掌握连续性、权限、证据和记忆。

## 设计原则

1. **连续性属于运行时。** Agent 是可替换的 Worker，不是事实来源。
2. **电脑是观察边界。** 文件、diff、命令结果、测试、本地工具状态和明确审批都可以被记录为观察事实。
3. **事件日志具有权威性。** 重要意图、决策、动作、权限、产物和验证结果都以追加式事件保存。
4. **工作状态不等于记忆。** 未完成事项和重试队列是可重建投影；长期记忆是独立且受治理的存储。
5. **声明不等于证据。** Worker 可以报告完成，但只有运行时验证后才能正式验收。
6. **上下文由编译产生，而不是整库倾倒。** 每个 Worker 只获得完成当前工作所需的最小授权信息。
7. **权威留在 Agent 之外。** 调度、预算、权限、验证和记忆提交始终由运行时决定。

## 整体架构

```text
用户
  | 意图、纠正、审批
  v
+--------------------------------------------------------------------------+
| clone-ai Runtime                                                         |
|                                                                          |
|  控制平面                                                                 |
|  调度器 | 策略与预算 | 权限闸门 | 验证器 | 记忆授权                           |
|       |                                      |                           |
|       | 工作分配 + 有界上下文                  | 决策                       |
|       v                                      v                           |
|  Context Compiler ---------------------> Agent Adapters                   |
|       ^                                  Claude Code | Codex | Pi         |
|       |                                      |                           |
|  Durable Memory                              | 声明与动作                 |
|       ^                                      v                           |
|  Memory Governance <--- Append-only Event Journal                        |
|                            |                     ^                       |
|                            v                     |                       |
|                    Work State Projections       |                       |
|                                                  |                       |
|  观察边界：文件、Git、Shell、测试、产物、本地工具                            |
+--------------------------------------------------------------------------+
```

所有重要活动都会带着来源信息进入事件日志。工作状态由日志派生；长期记忆则通过另一条受策略控制的
路径提升。Agent 只能看到当前任务对应的 `ContextPacket`，不会隐式获得整个日志或记忆库的控制权。

### 架构分层

| 层 | 职责 |
| --- | --- |
| **Observation Boundary（观察边界）** | 捕获电脑上发生的事实：文件变化、Git 状态、命令输出、测试、产物、工具结果和用户审批。 |
| **Event Journal（事件日志）** | 按顺序保存不可变的意图、观察、决策、动作、权限、产物、验证和记忆事件。 |
| **Work State（工作状态）** | 构建可恢复的 Session、WorkItem、依赖、重试、阻塞、预算和责任历史投影。 |
| **Durable Memory（长期记忆）** | 保存经过审查的偏好、项目事实和可复用流程，并记录来源、作用域、置信度与保留策略。 |
| **Control Plane（控制平面）** | 选择 Worker、编译上下文、执行策略与预算、请求审批、验证结果并授权记忆变更。 |
| **Agent Adapters** | 把 Claude Code、Codex、Pi 和未来 Worker 统一到一个可替换的生命周期协议后面。 |

## 核心模型

| 概念 | 含义 |
| --- | --- |
| **Goal** | 可以持续较长时间，并产生多个 Session 和 WorkItem 的方向。 |
| **Session** | 一段有边界的工作过程，从用户意图开始，以完成、暂停或放弃结束。 |
| **WorkItem** | 真正的持久化连续性单元，可以跨 Session 存在，包含目标、验收标准、依赖、状态和责任历史。 |
| **AgentSession** | 某个具体 Worker 针对一个 WorkItem 的一次临时执行。 |
| **JournalEvent** | 带有 Actor、类型、作用域、载荷、因果关系、序号和时间戳的不可变事件。 |
| **Artifact** | 可以通过路径、哈希或 URI 定位的具体产物。 |
| **Evidence** | 支持或反驳某项声明的观察事实，例如 diff、测试结果、命令输出、引用或审批。 |
| **VerificationRecord** | 运行时依据明确验收标准做出的通过、失败或无法判断记录。 |
| **MemoryCandidate** | 尚未被信任、也不能被普通检索使用的候选长期事实。 |
| **MemoryItem** | 带来源、作用域、置信度、敏感级别、保留和复查信息的受治理记忆。 |
| **ContextPacket** | 为一次 Worker 分配编译出的最小授权上下文。 |
| **WorkReceipt** | 最终可检查的工作回执：改了什么、验证了什么、还剩什么以及原因。 |

最重要的边界是：

```text
Session      = 现在正在发生什么
WorkItem     = 在解决之前必须持续存在什么
Journal      = 实际发生过什么
Memory       = 哪些信息值得带入未来工作
AgentSession = 现在由谁临时协助
```

## 执行生命周期

```text
CAPTURED
  -> READY
  -> RUNNING
  -> VERIFYING
       |-> PASSED ---------> COMPLETED
       |-> RETRYABLE ------> READY
       |-> NEEDS_CHANGE ---> REPLANNING
       |-> NEEDS_HUMAN ----> WAITING_APPROVAL
       `-> UNRECOVERABLE --> FAILED
```

每次请求的流程如下：

1. 运行时开启一个 `Session`，并创建一个或多个带验收标准的 `WorkItem`。
2. 控制平面根据能力、策略、预算、权限和隔离要求选择 Worker。
3. Context Compiler 从当前工作状态、已授权记忆和相关证据生成有界的 `ContextPacket`。
4. Adapter 流式转发 Worker 活动和声明，同时运行时从电脑观察边界捕获实际效果。
5. Verifier 根据验收标准检查产物和证据。
6. 运行时决定完成、重试、重新规划、重新分配，或暂停并等待人工审批。
7. Session 可以结束，但未解决的 WorkItem 会继续存在并可在未来恢复。

`worker.completed` 只表示 Worker 已停止并报告成功，不表示 WorkItem 已经完成。

## 事件日志与状态投影

事件日志是崩溃恢复的骨架：

```ts
interface JournalEvent<T = unknown> {
  id: string;
  sequence: number;
  type: string;
  actor: ActorRef;
  scope: ScopeRef;
  payload: T;
  causationId?: string;
  correlationId: string;
  observedAt: string;
}
```

代表性的事件族包括：

```text
intent.*        work.*          agent.*
observation.*   artifact.*      verification.*
permission.*    budget.*        memory.*
```

当前状态只是投影，永远不是事实来源。clone-ai 重启后会重放日志，重建 Session、WorkItem、
队列、预算、重试和等待审批状态。Snapshot 可以加速重放，但不能替代日志。

“只能追加”并不代表每个敏感字节都必须永久保留。体积较大或敏感的内容进入受策略控制的加密
Content Store；日志只保存引用、哈希和生命周期元数据。删除操作会追加 Tombstone，并删除或
通过销毁密钥抹除被引用内容，同时只保留不含敏感正文的审计记录。

## 受治理的长期记忆

clone-ai 明确区分“真正记住”与“保存了一份聊天记录”。

### 写入路径

```text
Worker 或运行时提出 MemoryCandidate
  -> 隔离区
  -> 验证其对应的日志证据
  -> 应用作用域、敏感级别和保留策略
  -> 去重并检测冲突
  -> 提升、合并、拒绝或请求人工复查
  -> 带来源提交为 MemoryItem
```

Worker 不能直接修改长期记忆。每一条正式记忆都必须能够回溯到支持它的事件或产物。

### 读取路径

```text
Session 意图
  + 相关 WorkItem
  + 已授权 MemoryItem
  + 最近 Evidence
  -> Context Compiler
  -> 有界 ContextPacket
  -> 被选择的 AgentSession
```

第一版故意只支持范围较窄的记忆：

- 用户偏好，
- 稳定的项目事实，
- 重复使用的工作流程。

检查、纠正、过期和删除记忆是产品能力，不是数据库维护操作。纠正会用新条目取代旧条目，
而不是重写历史；遗忘会按策略擦除记忆正文，只留下上文所述的最小审计 Tombstone。

## 信任与权威边界

| Actor 或边界 | 可以信任它做什么 | 不能信任它做什么 |
| --- | --- | --- |
| **用户** | 给出目标、纠正、审批和策略选择 | 完美回忆全部细节或持续监督 |
| **运行时** | 调度、策略执行、记账、验证决策和记忆授权 | 自动判断所有外部内容是否真实 |
| **Worker Agent** | 产生建议、动作、产物和结构化声明 | 自行宣布最终完成、自行扩权或直接提交长期记忆 |
| **观察边界** | 证明某个本地效果或输出曾被观察到 | 证明其内容在语义上一定正确 |
| **外部内容** | 作为带来源的数据 | 发号施令或修改运行时策略 |

审批事件只能证明用户授权过一个有明确范围的动作，不能证明动作本身安全或正确；运行时仍然必须
执行策略约束并验证结果。

破坏性动作、权限变更、敏感记忆提交和策略扩张需要明确人工审批。所有权限、预算和升级决策
都进入事件日志。

## Agent Adapter 边界

不同供应商的集成应保持轻薄：

```ts
interface AgentAdapter {
  readonly id: string;

  capabilities(): Promise<AgentCapabilities>;

  start(input: AgentSessionInput): AsyncIterable<AgentEvent>;

  resume(
    agentSessionId: string,
    input: AgentResumeInput,
  ): AsyncIterable<AgentEvent>;

  cancel(agentSessionId: string): Promise<void>;
}
```

Adapter 负责翻译 SDK 流、JSONL、子进程和 CLI Session，但不拥有工作状态、长期记忆、权限或
完成策略。

## 一个代表性执行

```text
$ clone-ai session start "为 API 增加限流并证明它有效"

Session ssn_01... 已开启
  WorkItem 1：检查 API 边界                  -> Codex
  WorkItem 2：比较兼容的实现策略              -> Claude Code

已观察：
  仓库快照、worktree diff、命令输出、测试结果

运行时：
  根据已接受的结论创建 WorkItem 3
  在隔离 worktree 中分配实现
  验证 diff 和要求的测试
  记录一条项目事实 MemoryCandidate

Session ssn_01... 已完成
  3 个 WorkItem | 2 种 Agent | 4 个 Artifact | 5 条 VerificationRecord
  WorkReceipt：receipts/ssn_01.json
```

如果 Worker 在中途退出，部分产物和失败事件仍然可见。运行时可以恢复同一个 AgentSession、
更换 Worker、重新规划、请求审批，或带着可检查的原因停止。

## v0.1

### 包含

- 单用户、单电脑、本地优先运行。
- SQLite WAL 事件日志与可重建状态投影。
- `Session`、`WorkItem`、`AgentSession`、`Artifact`、`Evidence` 和 `WorkReceipt`。
- Claude Code、Codex 和 Pi Adapter。
- 面向编码任务的 Git worktree 隔离。
- 文件变化、命令、测试和引用的验证钩子。
- 面向偏好、项目事实和流程的窄范围受治理记忆。
- 超时、取消、重试、等待审批和崩溃恢复。
- 查看工作、Trace、证据、记忆和恢复状态的 CLI。

### 暂不包含

- 向量优先或完全自动的记忆摄取。
- 多设备同步。
- 分布式队列或多节点执行。
- 无边界 Swarm 和 Agent 社交系统。
- 预设 Agent 市场。
- 完整 Web 控制台。
- 在没有明确授权范围时自行行动的“数字克隆”。

v0.1 只需要证明一件事：

> 启动一项非平凡工作，中途打断，更换 Agent，稍后恢复，检查证据，并且无需人工重建任务，
> 仍然得到经过验证的结果。

## 建议的 TypeScript 工程结构

```text
packages/
|-- contracts/              共享领域类型与 Schema
|-- journal/                追加式事件、Snapshot、重放
|-- content-store/          加密内容、保留策略、删除
|-- work-state/             Session 与 WorkItem 投影
|-- memory/                 候选记忆、治理、召回、审计
|-- context/                有作用域的 ContextPacket 编译器
|-- runtime/                调度器与生命周期协调
|-- policy/                 权限、预算、升级规则
|-- verifier/               产物与证据验证
|-- adapters/
|   |-- claude-code/
|   |-- codex/
|   `-- pi/
|-- cli/                    本地命令行界面
`-- testkit/                Fake Agent、Fixture、故障注入
```

建议的技术基础：

- **TypeScript strict + Node.js 22+**：统一协议、子进程和流式事件。
- **pnpm workspace**：清晰划分各个包的边界。
- **SQLite WAL + Drizzle**：本地、可检查、无需额外运维的持久化。
- **Zod**：在 Adapter 和存储边界进行运行时校验。
- **Pino + OpenTelemetry**：关联 Session、Worker 和工具的日志与 Trace。
- **Vitest**：测试事件重放、Fake Agent、崩溃和策略。
- **Git worktree**：隔离编码任务；真正需要时再增加容器。

## CLI 方向

```bash
clone-ai init
clone-ai agent add codex
clone-ai agent add claude-code
clone-ai session start "调研并实现这个需求"
clone-ai work list
clone-ai trace <session-id>
clone-ai resume <work-item-id>
clone-ai memory inspect
clone-ai memory audit
clone-ai memory forget <memory-id>
```

一个 Trace 必须能够回答：用户要求了什么、运行时做了什么决定、哪个 Worker 执行、电脑上发生了
什么变化、捕获了哪些证据、验证了什么、什么需要审批，以及工作为什么处于当前状态。

## 不可破坏的系统约束

1. 事件日志只能追加。
2. 工作状态可由日志重建。
3. 工作状态与长期记忆保持分离。
4. 每条长期记忆都有来源。
5. Worker 不能自行把工作标记为完成。
6. 完成必须同时具备验收标准和验证证据。
7. 权限、预算、策略决策和升级必须写入日志。
8. 外部内容只是数据，永远不是运行时权威。
9. Adapter 可以替换，运行时权威不能下放。
10. 用户可以检查、纠正、导出和删除长期记忆。

## 关于名称

`Knotwork` 描述了早期“把多个 Agent 编织在一起”的想法，但它把重点放在 Adapter 之间的连接，
而不是产品真正持久的价值；同时，它也已经与现有软件和 AI 相关名称发生冲突。

现在采用 `clone-ai` 作为仓库和项目名，它直接表达长期方向：用户拥有的个人 AI 分身，
而不是一组随时失效的聊天记录。**Clone AI** 是描述性很强、且已有活跃产品在使用的短语，
因此应把 `clone-ai` 视作项目名和工作品牌，而非已完成清权的商业商标。在付费公开发布前，
仍应完成正式的商标、域名和包注册表核查；如有需要，再引入更具辨识度的商业产品品牌。

---

> **clone-ai 让个人 AI 分身带着证据、权限和记忆持续推进工作。**
