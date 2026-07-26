# clone-ai

> **面向个人数字分身的本地优先运行时。**
>
> **一个人，持续的上下文，安全的执行，可被证明的结果。**

[English](README.md) · **简体中文**

`状态：初始 Runtime 骨架` · `许可证：MIT` · `核心：TypeScript + Node.js + Python`

---

## 为什么是 clone-ai？

今天的 AI 已经很有能力，但大多缺乏连续性。每次新的对话都从 Prompt 开始；人不得不承担系统的
工作：搬运上下文、记住承诺、比较选项、协调工具、检查结果，并判断接下来什么可以安全地发生。

clone-ai 希望把这些持续性的工作放进一个由用户拥有的系统。它不是 Avatar，也不只是模仿用户说话
方式的助手；它是一个个人数字分身，在项目、规划、沟通、学习、个人事务及日常生活的数字化部分
持续承接上下文。

> **个人 AI 的价值来自持续承接人的状态，而不是模仿人的语气。**

| 一次性 AI Session | 个人数字分身 |
| --- | --- |
| 从一段 Prompt 开始 | 从用户拥有且持续演化的个人状态开始 |
| 优化一次回答 | 长期维护目标、承诺与后果 |
| 可以声称成功 | 需要产生证据并经过验证 |
| 记忆归属于供应商 | 记忆由用户治理，带来源且可以删除 |
| 等待用户命令 | 能发现机会、准备选项，并只在明确授权内行动 |

## 它能做什么

| 能力 | 含义 |
| --- | --- |
| **个人连续性** | 让目标、承诺、偏好、当前情境和经过审核的记忆在不同 Session、模型与 Provider 间保持连贯。 |
| **从 Query 到结果** | 把需求转为选项、持久任务图、受控执行、验证和可读的 WorkReceipt。 |
| **机会发现** | 发现截止时间、冲突、被忽略的目标和有价值的时间窗口；提出下一步，而不在暗中执行。 |
| **由策略治理的自主性** | 严格区分观察、推断、准备、审批、执行和验证。预测永远不是权限。 |
| **以证据交付** | 把产物、外部效果、测试、回执或审批视为证据，而不是相信 Agent 自报的置信度。 |
| **可替换的执行能力** | 使用独立 Agent Runtime、连接器和本地自动化，但不让其中任何一个拥有用户状态或授权。 |

## 它位于哪里

clone-ai 位于独立 Agent Runtime、应用和工具之上。它不 Fork、嵌入或把任何一个 Runtime 当成子
Agent。clone-ai 负责个人连续性、策略、记忆、规划和验证；被接入的 Runtime 只提供有边界的执行能力。

```text
你
  -> clone-ai：状态、规划、策略、验证
       -> Claude Code / Codex / Pi / 未来 Runtime
       -> 日历 / 文件 / 邮件 / 浏览器 / 应用 / API
       -> 本地自动化和专用 Python Worker
```

## 计划接入的执行提供方

它们都是执行集成，而不是身份、记忆或授权的来源。每个提供方都经由同一个 `RuntimeAdapter` 合约接入，
并且只会获得完成当前任务所需的上下文和能力授权。

| 提供方 | 预期职责 | 集成状态 |
| --- | --- | --- |
| **Claude Code** | 长任务实现、本地工具调用与产物生成。 | Adapter 已完成设计 |
| **Codex** | 编码、审查、仓库操作与结构化执行事件。 | Adapter 已完成设计 |
| **Pi** | 额外的交互式或专长型执行能力。 | Adapter 已完成设计 |
| **自定义 Runtime** | 用户或组织专属的 Agent、脚本与本地工具。 | 扩展合约计划中 |
| **Python Worker** | 信息提取、排序、预测、评估和本地 ML 提案。 | Worker 协议计划中 |

## 从这里开始

clone-ai 是一个架构优先的开源项目，目前已包含初始开发者 Runtime 骨架；可安装的个人数字分身产品
尚未发布。可以先克隆仓库，关注或参与设计：

```bash
git clone https://github.com/guide-me-pls/clone-ai.git
cd clone-ai
```

接下来可阅读[架构](#架构)、[路线图](#路线图)、计划中的[命令行体验](#命令行体验计划)，以及
[初始 Runtime 骨架](docs/initial-runtime.zh-CN.md)。运行开发者预览：

```bash
npm install --ignore-scripts
npm test
npm run typecheck
npm run demo
```

第一条独立的“真实模型与 Tool”学习闭环见[最小 LLM 闭环](docs/minimal-llm-loop.md)。它会跑通
模型 → Function Tool → Tool 结果 → 模型的循环；唯一的文件写入 Tool 故意保持为 Mock。

目前的演示使用确定性的子 Agent Adapter，而不是已接入的模型 Provider：调研和草稿工作单可并行执行，审查工作单会等待前置 Evidence；外部动作仍会在精确审批前暂停，恢复后不会重复已完成的子工作。

产品客户端的方向是可安装的桌面数字分身，不是托管网页。`npm run companion:debug` 只会打开本地的桌面伴随预览，让开发者检查 daemon 边界；它既不是最终发布的桌面壳，也不是对外产品入口。详见[初始 Runtime](docs/initial-runtime.zh-CN.md#桌面端方向)。

## 安全承诺

这些承诺会在接入任何模型或连接器之前约束实现：

1. **人始终是主体。** 分身是有边界的代理，不能成为用户身份、金钱、关系或决策的独立主人。
2. **预测不是权限。** 信号和过去的行为可以支持建议或草稿，但永远不能直接获得执行重大动作的权限。
3. **Runtime 承担连续性。** 模型、CLI 和 Adapter 可以替换；用户治理的状态、策略、记忆和证据不能委托给它们。
4. **证据优先于断言。** Worker 可以提出完成声明，只有满足验收标准的可观察结果才能真正关闭工作。
5. **用户可以检查和撤销。** 重要动作必须展示理由、策略依据、证据、不确定性，以及可纠正或回滚的路径。

## 设计原则

1. **广泛观察，谨慎推断，只在获得授权后行动。** 信号不是指令，预测不是权限。
2. **状态要比 Session 和 Agent 更长寿。** 连续性的事实来源是 Runtime，而不是模型或 Adapter。
3. **工作、生活状态与记忆并不相同。** 当前承诺不是稳定信念，稳定信念也不是原始历史。
4. **最小但足够的上下文。** Worker 只得到有作用域的 ContextPacket，而不是一个人完整历史的无限副本。
5. **每个重要动作都可解释。** 用户应能看到为什么被建议、哪条策略允许、发生了什么，以及如何纠正。
6. **本地优先代表本地权威。** 可以使用托管模型，但离开设备的上下文必须明确、最小化并受策略控制。

## 架构

### 系统全景

```text
                                  用户
                    目标 · 纠正 · 审批 · 授权
                                   |
                                   v
 +---------------------------------------------------------------------+
 |                         clone-ai Runtime                            |
 |                                                                     |
 |  Personal State Plane                                               |
 |  Self Model · Life/Work Graph · Commitments · Policies · Memory    |
 |                                   |                                 |
 |  Cognitive & Planning Plane                                         |
 |  Signal Interpreter · Opportunity Engine · Scenario Planner        |
 |  Context Compiler · Task Graph Builder                              |
 |                                   |                                 |
 |  Governance Plane                                                    |
 |  Authority Gate · Budget · Privacy · Risk · Approval · Verification|
 |                                   |                                 |
 |  Execution Plane                                                    |
 |  Skills · Connectors · Agent Runtime Adapters · Local Automations  |
 |                                   |                                 |
 |  Observation Boundary                                               |
 |  Files · Calendar · Tasks · Mail · Browser · Apps · APIs · Devices |
 |                                   |                                 |
 |  Append-only Personal Journal -> State Projections -> Evidence     |
 +---------------------------------------------------------------------+
```

### 四个平面

| 平面 | 它拥有的职责 |
| --- | --- |
| **Personal State（个人状态）** | 用户可控的偏好、目标、承诺、关系、资源、当前情境和长期记忆模型。 |
| **Cognitive & Planning（认知与规划）** | 解释信号、发现机会、建模约束、比较选项、构建任务图，并编译有界上下文。 |
| **Governance（治理）** | 权限、隐私、数据驻留、审批规则、预算、风险分类、验证、审计和撤销。 |
| **Execution & Evidence（执行与证据）** | Skills、Agent Runtime、应用连接器、本地自动化、产物、观察效果与 WorkReceipt。 |

治理不是套在执行平面外的一层壳；它约束每一次读取、推断、建议和写入。

## 个人状态：分身的持久中心

个人状态平面必须分清事实、偏好、计划和不确定性。

| 概念 | 含义 |
| --- | --- |
| **SelfModel** | 用户编写或确认的偏好、价值观、工作习惯、长期规则和明确边界。 |
| **Goal** | 一个长期想达成的结果，例如发布产品、改善健康，或保护学习时间。 |
| **Commitment** | 承诺、截止日期、约会、周期责任或依赖关系，它们会形成义务。 |
| **Situation** | 对当前的有时间边界的视图：项目位置、可用时间、活跃约束、阻塞和相关信号。 |
| **WorkItem** | 可以跨 Session、Agent 和日期存在的持久工作单元。 |
| **PlanOption** | 一条建议路径，包含预期价值、成本、风险、假设、置信度和取舍。 |
| **Policy** | 规定分身可读取、推断、准备、执行、披露、保留或遗忘什么的规则。 |
| **MemoryItem** | 带来源、作用域、置信度、敏感级别和保留元数据的已审查事实、偏好、流程或决策。 |
| **Artifact** | 可检查的具体输出：补丁、文档、邮件草稿、预约、表格、计划、报告或外部记录。 |
| **Evidence** | 支持或反驳某项声明的观察事实：diff、测试、回执、响应、审批或引用。 |

这让 Runtime 对“未来”有了可用定义：不是预测唯一命运，而是把承诺、选择、截止时间、机会与约束
显式建模并进行推演。

## 从 Query 到结果

用户可以发起一个直接需求：

```text
“为下周准备最好的发布计划，并完成我已经批准的工作。”
```

Runtime 会把它处理成受控闭环：

```text
Query
  -> 提取意图与约束
  -> 读取当前情境、目标、承诺和已授权记忆
  -> 生成一个或多个 PlanOption
  -> 选择计划，或要求用户在计划中做选择
  -> 构建带验收标准和权限要求的任务图
  -> 分配 Skills、应用和 Agent Runtime
  -> 观察产物与外部效果
  -> 验证、交付 WorkReceipt，并更新状态
```

最终交付不只是文字。它可以是代码修改、日程计划、消息草稿、调研报告、预约请求、填写完成的表单、
已经执行的工作流，或“现在不应执行”的清晰解释。

## 主动性：预测机会，不预测权限

分身应该能发现有价值的下一步，例如临近截止日期、准备不足的会议、周期账单、被忽略的长期目标，
或适合高价值任务的一段空闲时间。

但它必须把这些变成 **OpportunityCard（机会卡）**，而不是隐藏动作：

```text
OpportunityCard
  why now             36 小时后有客户会议
  observed basis      日历事件 + 未完成提案 + 历史会议记录
  proposed result     准备 briefing、议程与跟进草稿
  expected value      high
  confidence          medium
  risk                low
  required authority  可自动准备；发送前仍需审批
```

规划引擎会权衡目标、承诺、偏好、时间、成本、风险和不确定性。它应展示当前最好的**选项**及其取舍，
而不是声称知道用户客观上“最好的生活”。

## 自主性阶梯

自主性是按领域、动作和情境配置的策略选择。

| 等级 | 分身行为 | 示例 |
| --- | --- | --- |
| **0 — Observe** | 只捕获和整理。 | 索引文件、对齐任务、发现截止日期。 |
| **1 — Suggest** | 解释机会并给出选项。 | 建议周计划、提示冲突。 |
| **2 — Prepare** | 创建可逆草稿和预览。 | 起草邮件、创建分支、准备预约请求。 |
| **3 — Execute by standing authority** | 执行用户明确预授权、有边界且可逆的动作。 | 归档文件、创建已批准任务、跑测试、更新私有笔记。 |
| **4 — Confirm before commitment** | 对会带来重要外部变化的动作暂停并请求确认。 | 发消息、购买、提交表单、发布、删除或修改访问权限。 |

预测的意图最多只能把工作从 Observe 推进到 Suggest 或 Prepare。没有匹配的 Policy 与当前权限检查，
它绝不能进入 Execute。

## 日志、状态与记忆

### 当前本地桌面端实现

桌面客户端已经提供一个可检查的 Memory Center。带证据的候选会同步到本地治理层；所有者可以手动添加、编辑、归档记忆，关闭召回，或设置每个新任务最多可召回的条数。新任务在规划前会对使用中的记忆做本地词法检索，把命中项作为有边界的上下文交给计划和 Agent，并把命中的词与记忆写入该任务的审计轨迹。

这不是向量索引或知识图谱；当前版本不会假装拥有这些能力。语义检索、冲突合并和关系图谱会作为后续升级，而不是未经验证的宣传。

Personal Journal 记录 Runtime 观察到和决定过什么。它是持久恢复的骨架，而不是原始监控档案。

```text
JournalEvent
  intent | observation | inference | plan | policy | approval
  action | artifact | verification | memory-candidate | memory-commit

Append-only Personal Journal
  -> Current State Projections
  -> Evidence Index
  -> Memory Candidates
  -> 受治理地提升为 Durable Memory
```

| 存储 | 用途 | 可变性 |
| --- | --- | --- |
| **Journal** | 有序的来源与生命周期事件。 | 只能追加。 |
| **State Projections** | 目标、承诺、任务和权限的可重建当前视图。 | 派生。 |
| **Durable Memory** | 值得带入未来决策的精选信息。 | 受治理、可纠正、可过期、可删除。 |
| **Content Store** | 敏感或大体积内容的加密正文。 | 受保留策略和密码擦除控制。 |

Agent 可以提出 MemoryCandidate，但只有 Runtime 在完成证据、策略、作用域、冲突和保留检查之后才能
提升它。纠正会以新条目覆盖旧判断；遗忘会移除或通过销毁密钥抹除敏感正文，同时留下最小且不含敏感
正文的审计 Tombstone。

## 信任、隐私与安全

个人生活数据要求更高的系统边界。clone-ai 必须明确：

- 导入的邮件、网页、文档和消息都是**数据**，不是指令。
- 日历事件或过去习惯不能授权花钱、联系某人或披露信息。
- 金钱、健康、法律、关系、权限控制、删除、发布和外部承诺等高影响领域，默认需要确认。
- 每个 Connector 都有有作用域的能力授权、可见数据边界和撤销路径。
- 用户可以检查、纠正、导出和删除自己的数据与长期记忆。
- WorkReceipt 记录计划、授权、动作、证据、验证结果、剩余不确定性，以及适用时的回滚路径。

## Runtime Adapter 与 Skills

Agent Runtime 是执行提供者，不是产品大脑或事实来源。

```ts
interface RuntimeAdapter {
  readonly id: string;

  capabilities(): Promise<RuntimeCapabilities>;

  start(input: ExecutionAssignment): AsyncIterable<RuntimeEvent>;

  resume(
    runtimeSessionId: string,
    input: ResumeAssignment,
  ): AsyncIterable<RuntimeEvent>;

  cancel(runtimeSessionId: string): Promise<void>;
}
```

Runtime 可通过这个边界接入 Claude Code、Codex、Pi 和未来独立的 Runtime。**Skill** 是版本化、受策略
作用域约束的能力，例如调研、编写代码、规划旅行、总结对话、准备购买或对齐任务清单。Skill 需要声明
自己的输入、输出、所需权限、风险级别和验证方法。

## 实现架构

### TypeScript、Node.js 和 Python 足够吗？

足够。前几个产品阶段只需要这三种技术：

| 技术 | 角色 | 边界 |
| --- | --- | --- |
| **TypeScript（strict）** | 统一领域协议、策略、Schema、CLI、Connector、Adapter、状态投影和测试。 | Runtime 拥有的状态与决策的事实语言。 |
| **Node.js LTS** | 本地 Daemon、进程监管、流式 I/O、CLI、调度、Connector 执行和 Agent Runtime Adapter。 | 始终运行的本地控制平面。 |
| **Python** | 可选的智能 Worker：本地 ML、多模态提取、OCR、预测、排序、评估和实验性检索。 | 返回版本化建议与证据，不能直接拥有个人状态或权限。 |

Daemon 使用当前 Node.js LTS。写本文档时 Node.js 24 是当前 LTS 线。Python 使用 3.13+，每一个
Worker 拥有独立且锁定版本的虚拟环境；在依赖兼容时再使用 Python 3.14。

Python 应放在一个小而版本化的本地协议之后：第一版使用标准输入输出上的 NDJSON 就足够。Node 控制平面
发送有界请求，接收 `WorkerProposal`，进行校验、写入日志，再决定是否采用。这样 Python 实验不会变成
另一个不受治理的控制平面。

第一版不要引入 Go、Rust、分布式队列或 Kubernetes。只有在测量证明确实需要更强隔离、原生设备集成或
性能关键组件时，再增加新的系统语言。

### 建议的工程结构

```text
apps/
|-- cli/                         query、inspect、approve、trace、resume
|-- daemon/                      本地生命周期与调度进程
`-- desktop/                     已安装本地客户端、托盘、审批与活动追踪

packages/
|-- contracts/                   版本化领域类型与 Schema
|-- journal/                     追加事件、重放、Snapshot
|-- content-store/               加密内容、保留与删除
|-- twin-state/                  self、goals、commitments、situations
|-- memory/                      候选、召回、复查、审计
|-- planning/                    opportunities、options、task graphs
|-- context/                     有作用域的 ContextPacket 编译器
|-- policy/                      authority、privacy、risk、approval、budget
|-- execution/                   调度、重试、WorkReceipt
|-- verification/                证据与验收检查
|-- connectors/                  calendar、mail、files、browser、APIs
|-- adapters/
|   |-- claude-code/
|   |-- codex/
|   `-- pi/
|-- observability/               Trace、审计、指标
`-- testkit/                     Fake Connector、Runtime、故障

workers/python/
|-- extraction/                  结构化与多模态提取
|-- ranking/                     机会与选项排序
|-- forecasting/                 时间与工作量预测
`-- evaluation/                  重放与决策质量评估
```

### 本地存储与进程模型

- **SQLite WAL** 保存 Journal、状态投影、策略元数据和队列。
- **加密的本地 Content Store** 保存敏感内容与大型产物。
- **OS Keychain 集成** 保护本地加密密钥和 Connector 凭证。
- **Node 子进程** 监管 CLI Agent 与 Python Worker，提供明确的超时、取消和结构化事件流。
- **Zod** 在所有不可信的 Adapter、Connector 和 Worker 输入边界做运行时校验。
- **Drizzle** 提供类型化持久化；**Pino** 与 **OpenTelemetry** 提供可追踪运行；**Vitest** 提供确定性的
  重放与策略测试。

## 路线图

| 阶段 | 重点 | 状态 |
| --- | --- | --- |
| **现在** | 可信本地状态，以及从 Query 到可验证交付 | 架构与设计 |
| **下一步** | 个人规划与主动准备 | 计划中 |
| **以后** | 有边界的委托自主性，以及跨领域生活支持 | 研究中 |

### Phase 0 — 可信的个人状态

构建本地 Journal、`SelfModel`、目标、承诺、WorkItem、Policy、Evidence、记忆复查和可检查时间线。
不自动执行外部写入。

**证明：** 重启 Daemon、更换 Agent Runtime 后，仍能准确恢复哪些事情被计划、尝试、验证、阻塞或等待审批。

### Phase 1 — Query 到已验证交付

从开发者与知识工作切入。一个 Query 能产出调研、代码、文档、计划、任务更新和带证据结果。分身接入
本地文件、Git、日历与一个范围很窄的任务来源。

**证明：** 用户可以提出一个非平凡结果，中断过程，更换 Agent，再回到无需人工重建上下文的已验证
WorkReceipt。

### Phase 2 — 个人规划与主动准备

接入日历、任务、邮件、周期责任和用户自行选择的生活信号。生成 OpportunityCard、情景计划、每日简报
和可逆的预先准备。

**证明：** 用户愿意接受主动准备，因为它的时机、理由和范围足够有用且可理解。

### Phase 3 — 有边界的委托自主性

对窄范围可逆动作启用常设授权。增加 Policy 模板、每个 Skill 的额度、回滚，并持续评估误报、过期记忆
与验证失败。

**证明：** 重复性动作可以安全发生，同时不降低用户对分身的知情、暂停和纠正能力。

### Phase 4 — 跨领域个人数字分身

从工作与规划扩展到经过谨慎选择的生活领域。系统会依据用户持续演化的目标和约束推演未来选项，但对敏感
动作保持审批闸门。

**证明：** 分身扩大用户可见的选择和执行能力，而不是悄悄缩小用户的自主性。

## 第一版

第一版不应该试图自动化一个人的全部生活，而应先建立一个窄但有意义的信任闭环：

1. 捕获用户 Query，以及用户选择的本地项目和日历上下文。
2. 创建持久计划与明确 WorkItem。
3. 使用 Agent Runtime 调研、实现、测试和生成产物。
4. 验证结果，并展示带证据的 WorkReceipt。
5. 只为下一次任务保留经过复查的偏好、项目事实和流程。

暂缓语音克隆、头像、社交模拟、金融执行、健康决策、关系自动化、宽泛邮件访问和无边界的主动行为。

## 命令行体验（计划）

```bash
clone-ai init
clone-ai connect calendar
clone-ai ask "为下周准备最好的计划"
clone-ai today
clone-ai opportunity list
clone-ai plan show <plan-id>
clone-ai approve <approval-id>
clone-ai trace <session-or-work-id>
clone-ai memory inspect
clone-ai memory forget <memory-id>
```

最重要的命令不是 `run`，而是能够检查：分身为什么认为某事重要、它被允许做什么，以及什么证据证明了
结果。

## 不可破坏的约束

1. 人是权威，分身是有边界的代理人。
2. 观察、推断、权限、动作和验证必须是不同的事件类型。
3. 预测永远不是权限。
4. 个人状态、当前工作、长期记忆和原始历史必须保持分离。
5. 没有任何 Agent Runtime 能直接标记工作完成或提交长期记忆。
6. 每个重要动作都有策略决策、证据路径和撤销方式。
7. 外部内容只是数据，永远不是 Runtime 的权威。
8. 用户可以检查、纠正、导出和删除个人状态与记忆。
9. 接入的 Runtime 可以替换；clone-ai 的个人状态与治理不能被替换掉。

---

> **clone-ai 不是模仿人的 AI；它是帮助人长期看见、决策并安全完成更多事情的个人数字分身。**
