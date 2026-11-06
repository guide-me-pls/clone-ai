# 可靠性基准

[English](README.md) · **简体中文**

这个基准测量的是 **harness 本身**，而不是模型：黑盒执行路径（编排、依赖波次、
证据、验证、恢复）在**真实 Provider CLI** 上能否稳定完成固定任务。它刻意保持
小而便宜，可以在每次升级前运行。

## 运行

真实 CLI 没有由 Clone AI 强制的系统沙箱，默认拒绝运行。如果你已理解它可能访问和修改当前用户
的文件、网络与凭据，并明确接受该风险，才使用：

```bash
npm run bench -- --unsafe-host --provider pi --tasks summarize
```

每个任务只花几美分的真实模型调用，耗时约 20-60 秒。结果以 JSON 记录在
`benchmark/results/<provider>-<时间戳>.json`，供升级前后对比。

## 原生 Provider

进程内 Worker 不需要 CLI，也能跑同一组任务：

```bash
CLONE_AI_NATIVE_MODEL=<model-id> CLONE_AI_NATIVE_BASE_URL=<openai-compatible-url> \
  npm run bench -- --provider native --tasks summarize
```

它不需要 `--unsafe-host`：每次工具调用都在运行前按步骤 Scope 校验。报告会记录精确的
`usage`（tokens 与模型调用次数）、`verification` 与 `failureReason`；CLI Provider 通常
只报告耗时与状态。

## 任务集（`benchmark/tasks.ts`）

| id | 它证明什么 |
| --- | --- |
| `summarize` | 单个只读 WorkOrder；产物证据来自工作区 diff |
| `two-step-chain` | 依赖波次：draft 在 research 验证通过后才启动 |
| `three-step-pipeline` | 两条依赖边；review 使用两个输入 |
| `code-tool` | Agent 产生两个代码产物；不证明测试由可信验证器独立执行 |
| `missing-input` | 期望失败：缺失文件应干净地归为 `no_artifact`，而不是挂死 |

## 读结果

- `passed`：run 到达 `completed` 且验证通过、预期产物真实存在时为 true。
- `expectedFailure` 任务（`missing-input`）只在失败类别为 `no_artifact` 时为绿；权限拒绝或启动失败不能冒充预期失败。
- `artifacts`：Agent 在工作区留下的全部文件（不含 `.clone-ai`）及大小。
- 运行器在任何意外失败时以非零退出码结束，可挂进 CI 或升级前检查。

## 主 Agent 对比（`npm run bench:main`）

用同一模型与每个任务独立的 clone home，把三条固定 Prompt 分别跑过 Pi 运行时与原生循环：
直接回答、读取权限、提案计划。每个任务/运行时组合重复 `--repeat N` 次（默认 5）；报告给出
中位数与 p90 耗时、中位 tokens 与通过率，并保留每一次运行。

```bash
CLONE_AI_BENCH_MAIN_MODEL=<model-id> npm run bench:main -- --repeat 5
```

原生端点来自 `CLONE_AI_NATIVE_BASE_URL`（默认 `http://127.0.0.1:3425`）。单次样本无法给
延迟排序：两次单跑中，同一个原生 plan 组合分别是 45.2s 与 11.1s。请使用中位数；
`--repeat 1` 只用于快速冒烟。

## 长对话验证（`npm run bench:long`）

写入 24 条已完成轮次并把针放在最老一轮，用 `historyChars=4000` 跑一次真实原生回合，
捕获发出的请求，并检查：摘要存在、摘要含针、最新轮次保持原文、回复含针、没有错误。
报告位于 `benchmark/results/`。

## 图片验证（`npm run bench:images`）

生成一张纯红 PNG，以 data URL 经原生主 Agent 发送，检查图片部分到达端点且模型回答红色。
报告位于 `benchmark/results/`。

## 回归门禁（`npm run gate`）

离线门禁在 CI 中随每次提交运行，零成本：它针对 `benchmark/gate/` 下的 held-out
夹具重新运行判断层，从不调用模型。

```bash
npm run gate
npm run gate -- --audit ~/clone-audit.jsonl
npm run gate -- --write-baseline
```

- **判定套件** —— `verdict-cases.json` 点名文件、证据，以及所有者会给出的判定。
  当前验证器必须复现这些判定。系统判"通过"而所有者判"失败"就是假通过，门禁失败。
- **策略套件** —— `policy-cases.json` 覆盖风险等级、自主档位、常设策略、禁区与审批。
  夹具预期应被拦截而系统却"放行"，就是一次不安全放行。
- **审计校准** —— `audit-cases.jsonl`，或用 `--audit` 传入的任何
  `clone-ai audit export` 文件，会与所有者标注对照：一致率、假通过、假失败。
  数据集哈希会被记录，held-out 记录无法悄悄变化。
- **逐用例基线** —— `benchmark/gate/baseline.json` 记录每个用例当前的行为。任何变化
  （包括改进）都会失败，直到在同一次变更中重新生成，因此判定变化会被审查而不是日后
  才发现。那份 diff 就是审查对象。

门禁衡量的是模型周围的规则，而不是模型质量。真实轨迹评估需要录制的 cassette 或沙箱化
的 Provider；那是另一套不跑在 CI 里的套件。

## 它不是什么

- 不是模型基准：通过/失败反映编排 + Provider 当天行为，模型抖动会产生抖动结果。
  要看多次运行的趋势，而不是单个数字。
- 不是 `npm test` 的替代：确定性测试套件仍是每次提交的闸门；本基准是可选的
  升级前可靠性闸门。
