# LLM Planner

`Clone AI` 现在支持显式开启的 LLM Planner。它只负责规划，不能调用 Worker
工具、修改 Memory、授予审批，或自行把 Run 标记为完成。

```text
Trigger + 已召回的 Memory + 已启用 Agent 目录
  -> LLM Planner
  -> 已校验的 WorkPlan / WorkOrder
  -> Runtime 的策略与能力校验
  -> Worker 执行
  -> Evidence + Verification
```

Planner 必须返回一次严格的 `create_work_plan` Function Call。Clone AI 会在
派发前校验：ID、风险等级、已启用 Agent、能力、依赖引用、产物合同，以及外部
动作所需的持久回执。输出不合法时会获得一次纠正机会；再次失败则安全失败。

## 启用方式

默认仍使用透明的本地 Demo Planner，因此本地 Demo 不会意外产生付费 API 调用。

```powershell
$env:CLONE_AI_PLANNER = "openai"
$env:OPENAI_API_KEY = "..."
$env:CLONE_AI_PLANNER_MODEL = "gpt-5"
npm run demo
```

取消设置 `CLONE_AI_PLANNER` 后，会使用离线的 `buildDemoPlan()` 回退策略。

## 边界

Memory 是上下文，不是授权。当前 Trigger 和 Runtime Policy 始终高于被召回的
Memory。LLM 可以提出外部动作，但 Runtime 仍会让该步骤等待审批，并要求回执
证据。
