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
