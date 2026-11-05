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
