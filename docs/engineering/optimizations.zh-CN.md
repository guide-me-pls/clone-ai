# 优化日志

[English](optimizations.md) · **简体中文**

每个优化在这里占一条，新的在前。取舍条目在变更之前写；本条目在变更落地后补全。
它的目的是让**工作本身**可审计：不仅改了什么，还包括怎么做的、花了多少、链路哪里弱。
规则见 [`AGENTS.md`](../../AGENTS.md)。

## 模板

```markdown
### YYYY-MM-DD — <标题>

- **目标 / 假设：** 期望什么变好，以及为什么相信它会变好。
- **取舍：** 链接到 `docs/architecture/trade-offs.md` 中的条目。
- **变更：** 一段说明，加上主要文件或目录。
- **Eval：** 命令、数据集或用例 id、变更前后的结果。
- **Benchmark run：** 命令、Provider/模型、数据集或任务 id、评分参数与结果文件。只要跑了
  benchmark 就必须写；仅跑确定性测试的 eval 可以省略。
- **执行链路：** 走过的步骤、使用的 Worker 或工具、耗时与成本、失败与重试。
- **优点：** 这条链路做得好的地方。
- **缺点 / 下次：** 哪里慢、贵、脆或不完整。
- **推翻条件：** 从取舍条目复制。
```

## 2026-11-05 — 自检时重建 App

- **目标 / 假设：** 所有者启动的 App 必须包含刚刚通过测试、即将推送的源码版本。
- **取舍：** [自检后重建本地 App](../architecture/trade-offs.zh-CN.md#2026-11-05--自检后重建本地-macos-app)。
- **变更：** `scripts/selfcheck-push.mjs` 在测试、类型检查和 gate 通过后，用
  `--replace` 构建 macOS App。
- **Eval：** 下一次自检必须生成最新的 `dist/Clone AI.app`，启动验收必须看到新 UI；
  测试、类型检查和 gate 结果由脚本记录。
- **执行链路：** 陈旧 App 让已完成的源码修复看起来不存在，因此加入此步骤。
- **优点：** 启动的 App 不会再悄悄落后于已验证源码。
- **缺点 / 下次：** macOS 自检变慢。
- **推翻条件：** 当热更新运行时取代打包 App 时移除此步骤。

## 2026-11-05 — 所有 Agent 调用共享审计

- **目标 / 假设：** 即使接入 Agent 使用隔离 `CLONE_HOME`，每次 Main Agent 调用也要
  出现在所有者审计中。
- **取舍：** [在 CLONE_HOME 之外审计调用](../architecture/trade-offs.zh-CN.md#2026-11-05--所有-agent-调用在-clone_home-之外审计)。
- **变更：** `src/audit/invocation-ledger.ts` 将调用者、请求、可见回复、错误、模型、
  强度、Workspace、会话文件、Run id 与耗时写入
  `~/.clone/audit/invocations.jsonl`。CLI、桌面 companion、WhatsApp 与独立 Main
  Agent 入口共用同一账本。审计页新增 **Agent 调用** 页签，CLI 新增
  `clone-ai invocations`。
- **Eval：** `test/invocation-ledger.test.ts` 与 companion API 测试覆盖隔离主目录、
  脱敏、失败回合、中断开始和详情输出。使用临时 `CLONE_HOME` 的真实回合出现在默认
  账本中，调用者 `codex`、模型 `360/deepseek/deepseek-v4.1-flash`、强度 `high`、
  回复 `OK`（invocation `7cb576ee`）。完整套件 568 项、565 通过、3 跳过、0 失败；
  `npm run gate` 通过。
- **执行链路：** 自修复运行暴露临时主目录导致审计不可见后，在当前工作区实现并验证。
  同时保留验证器文件期望的回归覆盖。
- **优点：** 所有者现在能看到谁调用了 Clone AI、问什么、回复什么、产生哪个 Run，
  不再依赖调用方的数据目录。
- **缺点 / 下次：** 账本是第二个明文存储；保留期与加密策略尚未可配置。
- **推翻条件：** 如果明文 JSONL 不再满足威胁模型，迁移到加密的、所有者作用域审计存储。

## 2026-11-05 — 记住夜间修复已消费的轨迹

- **目标 / 假设：** 成功修复后不再重复处理未改变的轨迹；同一 runId 的文件内容
  改变后仍可修复。
- **取舍：** [runId 和文件指纹](../architecture/trade-offs.zh-CN.md#2026-11-05--按-runid-和文件指纹消费已修复轨迹)。
- **变更：** `scripts/nightly-rsi-state.mjs` 用原子替换保存指纹与结果信息；
  `scripts/nightly-rsi.mjs` 筛选批次并仅在成功结果后记录。配套声明、
  `test/nightly-rsi-state.test.ts`、`docs/nightly-rsi.md` 和双语 CHANGELOG
  说明并覆盖该契约。
- **Eval：** 变更前代码检查显示没有消费状态；运行 `node --experimental-strip-types
  --test test/nightly-rsi-state.test.ts` 因新模块不存在而失败，因此没有旧行为的实测
  基线。变更后同一命令的 6 个确定性测试通过；`node --check
  scripts/nightly-rsi-state.mjs`、`node --check scripts/nightly-rsi.mjs` 与
  `npm run typecheck` 均通过。
- **执行链路：** Main Agent 使用 DeepSeek V4.1 Flash、`high` 强度提出单步计划，
  `draft-maker`/`codex-cli` 实现状态模块、接线、测试和文档。Runtime 随后把该步骤
  判为失败，因为文件验证器把 `fs.rename`、`os.tmpdir`、`consumed-traces.json` 等
  引号内标识符误当成工作区必须存在的文件。监工独立运行目标测试和 typecheck，均通过；
  这个假失败作为独立验证器缺陷继续修复。耗时约 3.5 分钟；使用了实时模型调用，费用未测量。
- **优点：** 结果判定与脚本共用；离线覆盖损坏状态、替换失败清理和内容改变后的重试。
- **缺点 / 下次：** 本任务没有端到端运行修复或 dry run，完整的模型依赖行为仍属假设；
  `npm test` 和 `npm run gate` 明确不在允许的命令范围内。
- **推翻条件：** 需要跨机器持久共享账本，或文件字节变化但有效证据不变导致反复修复时，
  替换这一文件方案。

## 2026-11-05 — 保守恢复规划阶段孤儿

- **目标 / 假设：** 关闭已放弃的规划 Run，同时不回收新建、已领取或已有计划的工作。
  15 分钟宽限期未经测量，不能证明没有租约的规划者已经停止。
- **取舍：** [规划孤儿宽限期](../architecture/trade-offs.zh-CN.md#2026-11-05--规划孤儿只在保守宽限期后恢复)。
- **变更：** `src/core/runtime.ts` 检查时间与领取；Journal 契约及 SQLite 实现增加
  条件围栏写入，拒绝并发 Run 变化。`test/claim-fencing.test.ts` 覆盖生命周期、阈值、
  领取竞争、并发计划和不支持条件写入的存储。
- **Eval：** 实现前，针对性孤儿恢复用例为红。实现后 `node --experimental-strip-types
  --test test/claim-fencing.test.ts` 的 15 项全部通过，`npm run typecheck` 和
  `npm run gate` 通过。关闭实时模型测试后，完整套件通过 545 项、跳过 3 项、0 失败。
  第一次全量运行仅因一个遗留 WhatsApp 桥进程占用 4318 端口而失败；清理后套件干净。
- **执行链路：** Main Agent 使用用户授权的 Magpie DeepSeek V4.1 Flash、`high` 强度
  提出计划，`claude-code` 调研，`codex-cli` 实现并记录。自执行耗时约 17 分钟。它的
  验证步骤错误地启用了实时测试并运行全量套件而挂起；监工取消该 Run、保留已完成的修改，
  再独立运行针对性测试和完整确定性套件。模型费用未测量。
- **优点：** 修复前复现失败；事务保护快照之后到达的计划；测试无需真实模型。
- **缺点 / 下次：** 超时不能确认规划者是否存活，全量测试也未能在本环境通过。应使用
  规划者租约和时长测量，并在测试前隔离工作区和端口。
- **推翻条件：** 如果正常无领取规划超过 15 分钟，应在启用恢复前改用可靠的规划者租约，
  或根据实测时长调整阈值。

## 2026-11-05 — 提示词溯源与离线回归门禁

- **目标 / 假设：** 让主 Agent 的一轮回答可以归因到它真正读到的提示词，并让 harness
  的判断层在没有真实模型的情况下可做回归测试。
- **取舍：** [提示词溯源](../architecture/trade-offs.zh-CN.md#2026-11-05--提示词溯源--内容寻址文件--一条-journal-事件)、
  [回归门禁](../architecture/trade-offs.zh-CN.md#2026-11-05--回归门禁离线逐用例只衡量行为)。
- **变更：** 每轮追加 `main_agent.prompt_snapshot` 事件，携带 charter、简报、工具表哈希
  以及模型与强度；完整材料按内容寻址存于 `prompt-snapshots/`；新增列表接口；
  `npm run gate` 包含 11 个判定用例、14 个策略用例、5 条审计记录、逐用例基线与 CI 步骤。
- **Eval：** `npm run gate` —— PASS（一致率 100%，假通过 0）；`npm test` —— 451 个测试，
  448 通过，3 跳过；`npm run typecheck` —— 通过。门禁出现之前没有行为评估；本次生成的
  基线就是之后每次优化的“变更前”。
- **执行链路：** 在一个会话内实现，随后验证三次（功能提交、门禁提交、合并后）。创建 PR
  被权限分类器拦截两次，最终由所有者手动创建；合入 base 时只有一个 `CHANGELOG.md`
  冲突，按两边都保留解决。没有模型调用，也没有 Provider 耗时；CI 每个任务约 40 秒。
- **优点：** 门禁零成本、确定性、每次提交都跑；逐用例基线把之后任何判定变化变成可审查的
  diff。提示词溯源不需要新存储——Journal 加内容寻址文件本来就是正确的形状。
- **缺点 / 下次：** 第一条基线编码的是当前行为，只能检测变化，不能证明正确。提示词快照
  接入真实 Pi 会话这一点，由工具注册测试和类型检查覆盖，没有端到端会话测试（本会话中
  运行它被拦截）。分支与 PR 流程带来两次权限拦截和一次冲突；现在的长期规则是直接合入
  `main` 并说明合并内容。
- **推翻条件：** 见上面两条取舍条目。

## 2026-11-04 — 带可撤销配置动作的 AI 自我评审

- **目标 / 假设：** 把审计摘要变成一个小而安全的改进回路——发现项加上所有者可应用、可撤销的
  配置动作——而不把代码、提示词或策略的权限交给模型。
- **取舍：** [自我评审只改配置](../architecture/trade-offs.zh-CN.md#2026-11-04--自我评审只改配置不改规则)。
- **变更：** `src/audit/self-review.ts`、`src/audit/apply-review.ts`、审计页的评审界面，以及
  `recommendation.applied` Journal 事件。
- **Eval：** `test/self-review.test.ts` 4 个用例，覆盖动作校验、模型不可用时的"只给事实"降级，
  以及 worker 强度与主 Agent 强度的应用/撤销。集成验证：`npm test` 540 个测试 / 537 通过 /
  3 跳过，`npm run typecheck` 通过。
- **执行链路：** 在 `dreamy-ritchie-b0f526` worktree 中实现。本条目记录的是交付状态与集成验证；
  原会话的内部步骤在这里不可得。集成期间没有模型调用。
- **优点：** 接口刻意很窄；每次应用先写旧值，因此所有者总能撤销，Journal 也能回答谁在哪次
  评审下改了什么。
- **缺点 / 下次：** 评审修不了代码或提示词缺陷，只能调模型与强度。原执行链路当时没有被记录
  ——这正是本日志要补上的缺口。
- **推翻条件：** 见取舍条目。

## 2026-11-05 — 失败轨迹、带闸门的夜间修复与 Worker 凭据边界

- **目标 / 假设：** 给修复回路诚实的材料——脱敏的失败文档，包含隐性失败——以及一个不能合并、
  不能碰规则的流程，同时把工具凭据移出 Worker 环境。
- **取舍：** [草稿 PR 闸门](../architecture/trade-offs.zh-CN.md#2026-11-04--失败轨迹与修复只在有闸门的草稿-pr-通道运行)、
  [Worker 凭据](../architecture/trade-offs.zh-CN.md#2026-11-05--worker-只继承模型凭据不继承工具凭据)。
- **变更：** `src/audit/failed-traces.ts`、`src/workers/worker-env.ts`、`scripts/nightly-rsi.mjs`、
  launchd 示例，以及 `traces` CLI 命令。
- **Eval：** 四个测试文件共 16 个用例：失败轨迹 3、夜间闸门 7、自我评审 4、Worker 环境 2。
  集成验证：`npm test` 540 个测试 / 537 通过 / 3 跳过；`npm run typecheck` 与
  `npm run gate` 通过。
- **执行链路：** 在 `dreamy-ritchie-b0f526` worktree 中实现；本条目记录交付状态与集成验证。
  夜间任务本身在集成期间没有端到端运行——它需要真实失败轨迹与无头模型——因此那条路径标记为
  **假设**。
- **优点：** 五道闸门各自对应一种已知失效模式；轨迹在模型读到之前已脱敏；凭据拒绝发生在
  进程启动之前。
- **缺点 / 下次：** 端到端修复没有在 CI 中执行（成本与模型依赖），且它产出草稿 PR，这是对
  日常直接合 main 规则的有意例外。原执行链路未被记录。
- **推翻条件：** 见上面两条取舍条目。

## 2026-11-05 — 所有主 Agent 入口的回合级审计

- **目标 / 假设：** 无论从 CLI、`npm run main`、companion/server 还是 WhatsApp 发起，
  主 Agent 回合都应从 Journal 可审计——包括输入、回复、工具调用、模型/强度、用量与状态。
- **取舍：** [每个回合都是一条 Journal 记录](../architecture/trade-offs.zh-CN.md#2026-11-05--每个主-agent-回合都是一条-journal-记录而不是旁路文件)。
- **变更：** 新增 `src/main-agent/turn-audit.ts`（共享 begin/observe/finish 与台账）、
  `src/audit/turn-audit.ts`（投影）、两种 Journal 事件类型、`clone-ai audit turns`、
  `GET /api/audit/turns`、审计页标签、用量记录的 `turnId`、CLI 用量记录，以及自评审用量。
- **Eval：** `test/main-agent-turn-audit.test.ts` 4 个用例，覆盖脱敏、工具事件、失败回合、
  中断幂等与新的在前加载。全量：544 个测试 / 541 通过 / 3 跳过；`npm run typecheck` 与
  `npm run gate` 通过；审计 UI 通过 `node --check`。
- **执行链路：** 通过阅读每个入口与审计投影定位缺口；先写取舍；用一个共享模块接入四个
  入口；随后补测试与全量验证。直接落在 `main`，没有分支或 PR。本次触及
  `src/core/contracts.ts` 与多个模块，而夜间修复通道的受保护路径闸门禁止这些路径，
  因此在所有者直接指示下于本会话实现——该通道仍是可复现 bug 的默认路径。
- **优点：** 同一段代码在所有入口写回合，台账与 Journal 不会漂移；工具调用与用量终于可
  归因到回合；脱敏与截断限制了 Journal 体积。
- **缺点 / 下次：** 黑盒 CLI Worker 的内部工具调用仍不可见（结构性边界）；原生 Worker 的
  模型用量当时未被记录（由下面的原生 Provider 条目取代）；`scripts/run-pi-task.mjs` 与
  `nightly-rsi` 仍在 Journal 之外；回合事件尚未并入单 Run 轨迹视图。
- **推翻条件：** 见取舍条目。

## 2026-11-05 — 原生 Worker 成为一等 Provider，并记录精确用量

- **目标 / 假设：** 让所有者像选择任何 CLI 一样按 Agent 选择进程内 Worker，并让它的模型用量
  精确、可归因，使 CLI 与原生 Worker 的对比有数据而不是印象。
- **取舍：** [原生 Provider](../architecture/trade-offs.zh-CN.md#2026-11-05--原生-worker-成为可选-provider并记录精确用量)。
- **变更：** `native` 注册进 Provider 目录，带 Agent 身份与角色能力；原生 Adapter 报告用量；
  OpenAI 兼容客户端解析两种 usage 形状；Runtime 以带 runId/stepId 的 `usage.recorded` 记入
  Journal；审计为每次执行展示精确用量；审计 UI 在网关估算旁显示它。
- **Eval：** `test/native-client.test.ts`（两种 usage 形状、没有 usage 时只计数不定价、
  Provider 身份与角色）、`test/native-agent-worker.test.ts`（completed 事件携带用量）、
  `test/audit.test.ts`（Runtime 记录用量且审计投影出来）。全量：549 个测试 / 546 通过 /
  3 跳过；`npm run typecheck` 与 `npm run gate` 通过。
- **执行链路：** 先写取舍；按 Provider、客户端、Worker、Runtime、审计、UI 的顺序实现；
  每层补测试；最后跑全量与门禁。该项真实对比后来已运行——见下面的 benchmark 条目。
- **优点：** 原生 Worker 可按 Agent 选择与识别；精确 token 可归因到单个步骤；不返回 usage 的
  Provider 只被计数、不被定价，而不是看起来免费。
- **缺点 / 下次：** 没有真实端点测试；原生 Worker 仍只有文件工具；默认 Agent 仍指向 CLI；
  未配置两个环境变量时选择 `native` 会在构建 Registry 时以清晰错误失败。
- **推翻条件：** 见取舍条目。

## 2026-11-05 — 原生 vs Claude：可靠性任务集 benchmark

- **目标 / 假设：** 测量进程内 Worker 是否能在同一组固定任务上完成得像 Claude Code CLI
  一样，并拿到精确用量、找出差异。
- **取舍：** [原生 Provider](../architecture/trade-offs.zh-CN.md#2026-11-05--原生-worker-成为可选-provider并记录精确用量)。
- **变更：** `benchmark/run.ts` 接受 `--provider native`（无需 `--unsafe-host`），记录
  验证结果、失败原因与精确用量，并把基准工作区交给验证器。缺少工作区是一个真实的 harness
  bug：所有相对产物都被当成不存在，第一次运行连 summarize 都失败
  （`native-2026-11-05T07-23-30-609Z.json` 保留了证据）。
- **Benchmark 运行 — 原生：** 命令
  `CLONE_AI_NATIVE_MODEL=360/moonshotai/kimi-k3.1-pro CLONE_AI_NATIVE_BASE_URL=http://127.0.0.1:3425 npm run bench -- --provider native --tasks summarize,two-step-chain,three-step-pipeline,code-tool,missing-input`；
  Provider/模型：`native`，经本地 Magpie，模型 `360/moonshotai/kimi-k3.1-pro`；数据集：
  `benchmark/tasks.ts` 的 5 个任务；参数：原生 `maxRounds` 12、WorkOrder 预算 12 次模型
  调用 / 20 次工具调用、每任务时长取自 `tasks.ts`；环境：macOS、Magpie
  `127.0.0.1:3425`、无 API Key；结果文件
  `benchmark/results/native-2026-11-05T07-36-54-051Z.json`。**4/5**：
  summarize 15.9s / 2,112 tokens；two-step-chain 55.1s / 5,022；
  three-step-pipeline 131.1s / 10,973；code-tool 45.6s / 4,891；
  missing-input 20.5s / 2,002——**完成并伪造了 `out/summary.md`**，预期失败没有发生。
  合计 25,000 tokens。
- **Benchmark 运行 — Claude：** 命令
  `npm run bench -- --unsafe-host --provider claude --tasks summarize,two-step-chain,three-step-pipeline,code-tool,missing-input`；
  Provider/模型：`claude` 及其配置的默认模型；同一数据集与参数；结果文件
  `benchmark/results/claude-2026-11-05T07-48-06-889Z.json`。**4/5**：
  summarize 15.7s；two-step-chain 30.6s；three-step-pipeline 82.2s；code-tool 60.8s；
  missing-input 58.6s——**在验证阶段失败**（`out/summary.md` 不存在），但 benchmark 的
  预期失败要求执行阶段的 `no_artifact`，因此被计为意外失败。CLI 不向运行器报告 token。
- **Benchmark 运行 — Pi：** 命令
  `npm run bench -- --unsafe-host --provider pi --tasks summarize`；结果文件
  `benchmark/results/pi-2026-11-05T07-41-52-338Z.json`；最简单的任务在 180s WorkOrder
  超时。是真实的可靠性数据点，不是模型对比。
- **数字说明：** 四个可解任务两边都通过。原生在 code-tool 更快（45.6s vs 60.8s），在两个
  链式任务更慢（55.1s vs 30.6s；131.1s vs 82.2s）。原生报告精确用量（合计约 25k tokens）；
  CLI 不报告。missing-input 两边都不符合预期，原因相反：原生伪造产物，Claude 在验证阶段
  干净失败。
- **发现 / 下一步：** 加固原生 Prompt，使必需输入缺失时停止而不是编造；决定验证阶段缺失
  产物是否应计入 `no_artifact`（本质上是同一件事）。在两者决定前，原生 Worker 在可解任务上
  与 Claude 持平，但在 missing-input 的诚实性上更弱。（已在下面的条目中修复。）
- **推翻条件：** 见取舍条目。

## 2026-11-05 — 命名输入缺失时原生 Worker 失败

- **目标 / 假设：** 当 WorkOrder 或步骤指令点名的文件缺失时，阻止原生 Worker 编造内容；
  benchmark 显示它会完成并伪造产物。
- **取舍：** [缺失输入](../architecture/trade-offs.zh-CN.md#2026-11-05--命名输入缺失时原生-worker-失败而不是允许编造)。
- **变更：** 读取 WorkOrder 目标或步骤指令点名的路径失败时，回合以 `no_artifact` /
  `native-missing-input` 结束；Prompt 要求模型不要编造缺失输入；失败 Adapter 的用量也会
  记入 Journal。
- **Eval：** `test/native-agent-worker.test.ts`——命名输入缺失以正确类别与签名失败、未被
  指令点名的失败读取仍可恢复、失败用量被携带。Benchmark：原生套件 5/5
  （`native-2026-11-05T08-07-23-864Z.json`）；最终代码重跑 `missing-input` 为预期失败，
  携带 1,397 tokens（`native-2026-11-05T08-10-22-910Z.json`）。全量：552 个测试 / 549 通过
  / 3 跳过；typecheck、gate 与双语文档通过。
- **执行链路：** 由 benchmark 发现；先写取舍；加守卫与 Prompt；补测试；重跑 benchmark；
  最后补失败用量，避免失败运行静默。
- **优点：** 声明为必需的输入缺失后不再接受编造；失败运行也会报告 token。
- **缺点 / 下次：** 指令中点名的合法可选路径缺失也会失败；benchmark 中 Claude 的
  `missing-input` 仍被计为意外失败，因为它在验证阶段而非执行阶段失败。`no_artifact` 的
  口径需要另行决定。
- **推翻条件：** 见取舍条目。

## 2026-11-05 — 开关后的原生主 Agent 循环

- **目标 / 假设：** 在不改变行为的前提下，把 Pi 从主 Agent 的关键路径上移除：用进程内
  OpenAI 兼容循环运行相同的 Prompt、工具与审计。
- **取舍：** [原生主 Agent](../architecture/trade-offs.zh-CN.md#2026-11-05--原生主-agent-循环放在开关后而不是一次性切换)。
- **变更：** `src/main-agent/prompt.ts`（不依赖 SDK 的 Prompt 编译）、
  `src/main-agent/native-runtime.ts`（chat 循环、工具执行、台账对话记录、台账版
  `search_history`）、kernel-tools 的 `kernelToolDefinitions`，以及
  `run-main-query`、CLI、`npm run main` 的开关分支。Pi 仍是默认。
- **Eval：** `test/native-main-agent.test.ts` 3 个用例：脚本化工具调用 + 最终回答
  （回复、工具消息，以及 turn/tool/usage/snapshot Journal 事件）、从台账加载历史轮次、
  显式开关与端点处理。全量：576 个测试 / 573 通过 / 3 跳过；typecheck、gate 与双语
  文档通过。
- **实机冒烟：** `CLONE_AI_MAIN_RUNTIME=native
  CLONE_AI_NATIVE_MODEL=360/moonshotai/kimi-k3.1-pro
  CLONE_AI_NATIVE_BASE_URL=http://127.0.0.1:3425 clone-ai "请只回复：native 主 Agent 已就绪"`
  返回了该回复；`clone-ai audit turns` 显示完成的回合与 3,393 tokens；
  `clone-ai invocations` 显示 caller `claude-code:<session>`、surface `cli`。
- **优点：** 原生路径写入相同的审计与用量记录；工具表从 Pi 扩展捕获，两个运行时不会
  各自漂移；共享调用账本能识别调用者。
- **缺点 / 下次：** 当时非流式、无压缩；两者接下来已补齐（见下）。当时也拒绝图片，现已支持；
  `search_history` 检索回合台账而非 Pi 会话文件；原生回合不能作为 Pi 会话续跑。
- **推翻条件：** 见取舍条目。

## 2026-11-05 — 原生 vs Pi 主 Agent 对比

- **目标 / 假设：** 在改变任何默认之前，检查原生循环能否在相同的 Main Agent 任务上匹敌
  Pi——直接回答、读取权限、提案计划。
- **取舍：** [原生主 Agent](../architecture/trade-offs.zh-CN.md#2026-11-05--原生主-agent-循环放在开关后而不是一次性切换)。
- **变更：** 新增 `benchmark/main-agent.ts` 与 `npm run bench:main`：三条固定 Prompt、
  每个任务独立的 clone home、两个运行时相同的模型与端点，报告耗时、tokens、工具调用、
  产生的 Run、回合状态与预期是否成立。
- **Benchmark 运行 — 失败尝试：** 命令
  `CLONE_AI_BENCH_MAIN_MODEL=360/google/gemini-4-argon npm run bench:main`；两个运行时
  的所有任务都因 Magpie 上游返回 400（could not connect to stream）而失败。问题在端点，
  不在 harness（`main-agent-2026-11-05T09-01-57-162Z.json`）。
- **Benchmark 运行 — 有效：** 命令
  `CLONE_AI_BENCH_MAIN_MODEL=360/anthropic/claude-sonnet-5-5 npm run bench:main`；
  模型：`360/anthropic/claude-sonnet-5-5`，经 Magpie `http://127.0.0.1:3425`；任务：
  direct-answer、authority-read、plan-proposal；每个运行时每任务一次；隔离 clone home；
  结果文件 `benchmark/results/main-agent-2026-11-05T09-06-13-005Z.json`。**两边均 3/3**：
  - direct-answer：Pi 3.3s / 3,865 tokens，原生 5.9s / 3,795；无工具、无 Run。
  - authority-read：Pi 7.6s / 8,197，原生 9.5s / 7,958；两边各调用一次
    `get_authority`；无 Run。
  - plan-proposal：Pi 12.1s / 9,452，原生 9.5s / 9,407；两边各调用一次
    `propose_work_plan`，各产生一个 Run。
- **数字说明：** 任务结果、工具选择与 Run 创建都相同。tokens 几乎一致（Pi 21,514；原生
  21,160，约少 1.6%）。总耗时 Pi 略快（23.0s vs 24.9s），但 plan-proposal 上原生更快
  （9.5s vs 12.1s）。每格只跑一次；把它当作一致性检查，而不是统计基准。
- **发现 / 下一步：** 在这些任务上原生循环行为可比。它仍缺流式与压缩，下一次对比应加入
  长对话与多轮工具任务——那才是最可能出现差异的地方。
- **推翻条件：** 见取舍条目。

## 2026-11-05 — 原生主 Agent 流式输出并压缩

- **目标 / 假设：** 在改变默认之前补齐两个缺口：token 到达即输出，以及长对话不再悄悄
  丢失早期细节。
- **取舍：** [流式与压缩](../architecture/trade-offs.zh-CN.md#2026-11-05--原生主-agent-流式输出并做确定性压缩)。
- **变更：** 原生运行时使用 SSE（`stream: true`、`stream_options.include_usage`），转发
  内容增量、按 index 组装工具调用增量并解析最后的 usage 块。`buildHistory` 在
  `historyChars`（默认 12,000）的三分之二内保留最新轮次原文，其余替换为一段有界的
  确定性摘要；全文仍在回合台账中。
- **Eval：** `test/native-main-agent.test.ts` 直接驱动 SSE：增量逐个到达、工具调用片段
  正确组装、流式下 usage 不丢、20 轮对话压缩成摘要加最新一轮。全量：579 个测试 /
  576 通过 / 3 跳过；typecheck、gate 与双语文档通过。
- **Benchmark：** `CLONE_AI_BENCH_MAIN_MODEL=360/anthropic/claude-sonnet-5-5 npm run bench:main`
  → 两边 3/3；direct 2.5s / 3,795 vs 2.5s / 3,864；authority 7.8s / 8,013 vs
  9.2s / 8,141；plan 14.2s / 9,138 vs 11.2s / 8,929；工具选择与 Run 创建相同；
  结果文件 `benchmark/results/main-agent-2026-11-05T09-26-57-563Z.json`。与流式之前的
  运行相比，行为无变化，usage 没有丢失。
- **实机验证：** 摘要已在下面的长对话运行中发给真实端点，五项检查全部通过。先前的假设
  已解决。
- **优点 / 缺点：** 流式消除了界面冻结感；确定性压缩便宜、可审计，但不如模型撰写的摘要
  保真；长对话质量已在下面的种子对话上验证。
- **推翻条件：** 见取舍条目。

## 2026-11-05 — 原生压缩的长对话验证

- **目标 / 假设：** 对真实端点验证确定性摘要被接受、最新轮次保持原文，以及最早轮次里的
  事实能在压缩后保留到足以让模型回答。
- **取舍：** [流式与压缩](../architecture/trade-offs.zh-CN.md#2026-11-05--原生主-agent-流式输出并做确定性压缩)。
- **Benchmark 运行：** 命令
  `CLONE_AI_BENCH_MAIN_MODEL=360/anthropic/claude-sonnet-5-5 npm run bench:long`；
  模型 `360/anthropic/claude-sonnet-5-5`，经 Magpie `http://127.0.0.1:3425`；
  24 条已完成的种子轮次（针在最老一轮）、`historyChars` 4,000、一次真实回合；结果文件
  `benchmark/results/native-main-long-context-2026-11-05T09-43-52-438Z.json`。
- **结果：** 9 条消息（4 条 user）、2,121 字符的确定性摘要；端点接受；最新轮次保持原文；
  回复恰好是 `BLUE-FALCON`；7,842 tokens、1 次模型调用；五项检查全为真。
- **证明了什么 / 没证明什么：** 多个 system 消息在实践中被接受，放在旧轮次开头的事实能
  在摘要中保留。它没有证明埋在旧轮次后部的事实能保留：摘要把每条旧轮次截到 160 字符、
  整体截到 2,000 字符。这仍是确定性压缩的已知弱点。
- **推翻条件：** 见取舍条目。

## 2026-11-05 — 原生主 Agent 接受图片

- **目标 / 假设：** 补齐 Pi 与原生主 Agent 之间最后一项能力差距：图片附件。
- **取舍：** [图片附件](../architecture/trade-offs.zh-CN.md#2026-11-05--原生主-agent-接受图片附件)。
- **变更：** 有图片时，原生 user 消息改为 OpenAI 风格 content parts（`text` 加
  `image_url` data URL）；`run-main-query` 不再拒绝附件，而是传给原生运行时。图片是
  逐回合的，不写入回合台账。
- **Eval：** `test/native-main-agent.test.ts` 断言捕获请求中的图片部分与 data URL。
  实机验证：发送 64×64 纯红 PNG，回复 `Red.`；图片部分存在、无错误、3,806 tokens、
  1 次模型调用；结果 `benchmark/results/native-main-images-2026-11-05T10-01-47-161Z.json`。
- **优点 / 缺点：** 原生开关不再移除一项能力；base64 会放大请求，本版本不做缩放，之后
  无法从台账恢复图片。
- **推翻条件：** 见取舍条目。

## 2026-11-05 — 配置了端点的原生主 Agent 成为默认

- **目标 / 假设：** 让已验证的原生循环成为默认，同时不破坏没有 OpenAI 兼容端点的安装。
- **取舍：** [默认运行时](../architecture/trade-offs.zh-CN.md#2026-11-05--配置了端点的原生主-agent-成为默认)。
- **变更：** 用 `readMainAgentRuntime` 取代布尔开关。未设置 → 存在
  `CLONE_AI_NATIVE_MODEL` 与 `CLONE_AI_NATIVE_BASE_URL` 时用原生，否则用 Pi；
  `pi`/`legacy` 强制 Pi；`native` 强制原生，端点缺失时清晰失败；未知值抛错。对比
  benchmark 的 Pi 列显式固定 `CLONE_AI_MAIN_RUNTIME=pi`。
- **Eval：** `test/native-main-agent.test.ts` 的运行时选择矩阵（未设置且有/无端点、
  显式 pi、显式 native、未知值）；全量 580 个测试 / 577 通过 / 3 跳过；typecheck、
  gate 与双语文档通过。不设开关的实机冒烟：
  `CLONE_AI_NATIVE_MODEL=360/anthropic/claude-sonnet-5-5 CLONE_AI_NATIVE_BASE_URL=http://127.0.0.1:3425 clone-ai "请只回复：默认运行时已生效"`
  → 精确回复；`clone-ai audit turns --json --limit 1` 显示 `provider: "native"`。
- **优点 / 缺点：** 配置了端点的部署现在默认使用已验证的原生循环；没有端点的安装继续
  使用 Pi。未设置的情况依赖环境，因此当前运行时在回合记录（`provider`）里可见，而不是
  靠一个隐含的开关。
- **推翻条件：** 见取舍条目。

## 2026-11-05 — direct / research / draft / review 默认使用原生 Worker

- **目标 / 假设：** 默认使用已验证的进程内 Worker，但不强加给 external 角色，也不覆盖
  所有者已保存的选择。
- **取舍：** [Worker 默认](../architecture/trade-offs.zh-CN.md#2026-11-05--配置了端点的原生-worker-成为可承担角色的默认)。
- **变更：** 设置 `CLONE_AI_NATIVE_MODEL` 与 `CLONE_AI_NATIVE_BASE_URL` 时，
  `defaultWorkerProfiles(environment)` 与 `WorkerSettingsStore` 的 `normalize` 让除
  `external` 外的角色默认使用 `native`；已保存的 Provider id 仍然优先，未知或与角色不
  兼容的保存值仍回退到默认。
- **Eval：** `test/worker-defaults.test.ts`——有/无端点时的角色矩阵、缺失设置文件、已保存
  的 `pi` 选择被保留。全量：582 个测试 / 579 通过 / 3 跳过；typecheck、gate 与双语文档
  通过。设置端点后手工检查输出：direct/research/draft/review 为 `native`，external 为
  `codex-cli`。
- **优点 / 缺点：** 配置了端点的部署不再取决于恰好装了哪个 CLI；`external` 仍走受治理的
  CLI 路径。原生 Worker 只有文件工具，因此日后需要网络或外部动作的角色必须更换 Provider。
- **推翻条件：** 见取舍条目。

## 2026-11-05 — 默认切换后的重跑

- **目标 / 假设：** 确认默认切换没有破坏真实链路（路由、工具、审计），并用新默认重新测量。
- **取舍：** [Worker 默认](../architecture/trade-offs.zh-CN.md#2026-11-05--配置了端点的原生-worker-成为可承担角色的默认)
  与[主 Agent 默认](../architecture/trade-offs.zh-CN.md#2026-11-05--配置了端点的原生主-agent-成为默认)。
- **Benchmark 运行 — Worker 套件：** 命令
  `CLONE_AI_NATIVE_MODEL=360/moonshotai/kimi-k3.1-pro CLONE_AI_NATIVE_BASE_URL=http://127.0.0.1:3425 npm run bench -- --provider native --tasks summarize,two-step-chain,three-step-pipeline,code-tool,missing-input`；
  模型 `360/moonshotai/kimi-k3.1-pro` 经 Magpie；结果
  `benchmark/results/native-2026-11-05T11-09-55-300Z.json`。**5/5**：summarize
  12.4s / 2,252 tok / 3 次调用；two-step-chain 38.7s / 5,146 / 6；three-step
  pipeline 111.2s / 12,420 / 11；code-tool 46.5s / 4,922 / 5；missing-input
  19.1s / 1,673 / 2，为预期失败。
- **Benchmark 运行 — 主 Agent，两轮：** 命令
  `CLONE_AI_BENCH_MAIN_MODEL=360/anthropic/claude-sonnet-5-5 npm run bench:main`；
  结果文件 `main-agent-2026-11-05T11-05-57-652Z.json` 与
  `main-agent-2026-11-05T11-12-52-700Z.json`。**两轮中两个运行时都是 3/3。**
- **是波动，不是回退：** 两轮对"谁更快"给出了相反结论，这才是关键发现。第一轮：direct
  Pi 3.0s vs 原生 2.2s；authority 15.9s vs 11.7s；plan 6.6s vs 45.2s（原生一次离群）。
  第二轮：direct 2.9s vs 1.2s；authority 5.9s vs 8.4s；plan 10.4s vs 11.1s（这一轮 Pi
  在提案前先调用了 `get_authority`，其 plan tokens 升到 13,174）。tokens 保持接近
  （direct 上原生 3,795–3,796 vs Pi 3,864）。
- **这次运行改变了什么：** 代码没有变化。它确认默认值端到端可用——工具被调用、每个计划
  任务恰好创建一个 Run、每个回合都完成——并说明每格只跑一次无法对延迟排序。
- **下一步：** 要比较延迟，每格跑 N 次并报告中位数；当前脚本刻意只跑一次，并已说明。
- **推翻条件：** 见两条取舍条目。

## 2026-11-06 — 重复运行并取中位数的对比

- **目标 / 假设：** 让 Pi 与原生对比能够给延迟排序——两次单跑结论相反，且原生 plan 一格
  曾出现 45.2s。
- **取舍：** [重复取中位数](../architecture/trade-offs.zh-CN.md#2026-11-06--主-agent-对比每格重复多次并报告中位数)。
- **变更：** `benchmark/main-agent.ts` 每格跑 `--repeat N` 次（默认 5），报告中位数与
  p90 耗时、中位 tokens 与通过率，并保留每个样本；`benchmark/stats.ts` 提供中位数与
  最近秩百分位；抛错的格子记录为失败样本，而不是中断整份报告。
- **Eval：** `test/benchmark-stats.test.ts` 覆盖奇/偶/空中位数与最近秩百分位。重复运行：
  `CLONE_AI_BENCH_MAIN_MODEL=360/deepseek/deepseek-v4.1-flash npm run bench:main -- --repeat 3`；
  模型 `360/deepseek/deepseek-v4.1-flash` 经 Magpie `http://127.0.0.1:3425`；每格 3 个
  样本；结果文件 `benchmark/results/main-agent-2026-11-06T01-41-51-266Z.json`。
- **结果（中位 / p90 / 中位 tokens）：** direct Pi 1.2s / 1.3s / 2,620 vs 原生 1.5s /
  1.7s / 2,560；authority Pi 4.5s / 6.2s / 5,721 vs 原生 4.4s / 5.6s / 5,449；
  plan Pi 11.5s / 15.8s / 14,145 vs 原生 12.2s / 19.9s / 12,994。两个运行时均 9/9。
- **说明：** 三个样本下结论已经稳定。延迟接近——原生在 authority 略快，Pi 在 direct 与
  plan 略快；原生总体少约 6.6% tokens（中位和 21,003 vs 22,486）。每个格子都满足预期。
- **模型说明：** 之前的 Sonnet 5.5 id 在此环境的 Pi 目录中已不存在；第一次重复运行在任何
  模型调用前就失败，已记录为发现。DeepSeek v4.1 Flash 同时存在于两个目录且支持工具调用。
- **下一步：** 默认 5 个样本；本次为了控制运行窗口用了 3。需要 p90 时用 `--repeat 5`。
- **推翻条件：** 见取舍条目。

## 2026-11-06 — 五次样本确认

- **目标 / 假设：** 用默认的 5 个样本替换三次样本的结论，让 p90 成为真实的尾部指标，
  而不是接近最大值。
- **取舍：** [重复取中位数](../architecture/trade-offs.zh-CN.md#2026-11-06--主-agent-对比每格重复多次并报告中位数)。
- **Benchmark 运行：** `CLONE_AI_BENCH_MAIN_MODEL=360/deepseek/deepseek-v4.1-flash npm run bench:main -- --repeat 5`；
  模型 `360/deepseek/deepseek-v4.1-flash` 经 Magpie `http://127.0.0.1:3425`；每格 5 个
  样本；结果 `benchmark/results/main-agent-2026-11-06T02-07-58-472Z.json`。
- **结果（中位 / p90 / 中位 tokens）：** direct Pi 1.4s / 1.9s / 2,621 vs 原生 1.1s /
  2.1s / 2,563；authority Pi 4.8s / 5.5s / 5,583 vs 原生 4.7s / 5.4s / 5,488；
  plan Pi 13.8s / 26.9s / 10,877 vs 原生 11.4s / 15.8s / 9,922。两个运行时均 15/15。
- **与三次样本相比的变化：** 原生在每个格的中位延迟上都更快（合计 17.2s vs 20.0s），
  plan 的尾部明显更好（p90 15.8s vs 26.9s）。原生少约 5.8% tokens。plan 格的工具调用
  次数仍有波动（Pi 1–3 次，原生 2–4 次），这是模型行为，不是运行时差异。
- **限制：** 一个模型、一台机器、一个小时内、共享网关。把结论当作稳定的本地对比，
  而不是普适排名。
- **推翻条件：** 见取舍条目。

## 2026-11-06 — 从主 Agent 移除 Pi SDK（两步中的第一步）

- **目标 / 假设：** 按移除取舍的決定，让主 Agent 的循环、上下文组装与工具面都属于我们，
  没有 SDK、没有回退。
- **取舍：** [只保留自己的 Agent](../architecture/trade-offs.zh-CN.md#2026-11-06--只保留自己的-agent去掉-pi-sdk-与黑盒-cli)。
- **变更：** 删除 `session.ts`（Pi 会话工厂）；把 `run-main-query`、`clone-main` 与 CLI
  对话路径改到原生运行时；把不依赖 SDK 的指针与旧会话列举移入 `conversation-store.ts`；
  把模型/强度偏好移入 `model-preferences.ts`；把自评审的 Pi 会话替换为对已配置端点的普通
  completion；把 Pi 模型目录替换为网关自己的列表；从 Kernel 工具宿主中移除 Pi 类型；
  回合台账现在同时供 `search_history` 与对话视图使用；移除
  `@earendil-works/pi-coding-agent` 依赖与仅 Pi 的 live 测试。
- **Eval：** 全量 578 个测试 / 578 通过；typecheck、gate 与双语文档通过。被删除的 live
  测试依赖 Pi，SDK 移除后无法运行；其确定性等价测试仍在。
- **执行链路：** 先写取舍；再改运行时；然后自评审与目录；最后测试。每一步由编译器引导。
  两个使用 Pi `SessionManager` 的测试种子改写为台账回合。
- **优点 / 缺点：** 主 Agent 不再依赖 SDK，每个输入、工具调用与用量记录都是我们自己的。
  端点现在是必需的；设置页的模型选择器列出网关模型，且只配置基础地址时使用所选 id。
- **未完成（第二步）：** 黑盒 CLI Worker（Claude Code、Codex、Pi CLI、opencode）、它们的
  Provider 目录、安装命令与 `install_agent` 工具仍在。移除它们是同一取舍的下一阶段；
  在有受治理的连接器之前，外部动作将没有 Provider。
- **推翻条件：** 见取舍条目。
