# 可靠性基准

[English](README.md) · **简体中文**

这个基准测量的是 **harness 本身**，而不是模型：黑盒执行路径（编排、依赖波次、
证据、验证、恢复）在**真实 Provider CLI** 上能否稳定完成固定任务。它刻意保持
小而便宜，可以在每次升级前运行。

## 运行

```bash
npm run bench                          # 全部任务，默认 pi
npm run bench -- --provider pi         # 显式指定 Provider
npm run bench -- --tasks summarize     # 只跑单个任务
npm run bench -- --tasks two-step-chain,three-step-pipeline
```

每个任务只花几美分的真实模型调用，耗时约 20-60 秒。结果以 JSON 记录在
`benchmark/results/<provider>-<时间戳>.json`，供升级前后对比。

## 任务集（`benchmark/tasks.ts`）

| id | 它证明什么 |
| --- | --- |
| `summarize` | 单个只读 WorkOrder；产物证据来自工作区 diff |
| `two-step-chain` | 依赖波次：draft 在 research 验证通过后才启动 |
| `three-step-pipeline` | 两条依赖边；review 使用两个输入 |
| `code-tool` | Agent 使用自己的 Shell；两个产物；真实测试执行 |
| `missing-input` | 期望失败：缺失文件应干净地归为 `no_artifact`，而不是挂死 |

## 读结果

- `passed`：run 到达 `completed` 且验证通过、预期产物真实存在时为 true。
- `expectedFailure` 任务（`missing-input`）以**失败**为绿：不能失败的基准没有价值。
- `artifacts`：Agent 在工作区留下的全部文件（不含 `.clone-ai`）及大小。
- 运行器在任何意外失败时以非零退出码结束，可挂进 CI 或升级前检查。

## 它不是什么

- 不是模型基准：通过/失败反映编排 + Provider 当天行为，模型抖动会产生抖动结果。
  要看多次运行的趋势，而不是单个数字。
- 不是 `npm test` 的替代：确定性测试套件仍是每次提交的闸门；本基准是可选的
  升级前可靠性闸门。
