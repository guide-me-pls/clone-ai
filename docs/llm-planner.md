# LLM Planner

**English** · [简体中文](llm-planner.zh-CN.md)

`Clone AI` now supports an opt-in LLM Planner. It plans only; it cannot call
worker tools, change memory, grant approval, or mark a Run as complete.

```text
Trigger + recalled memory + enabled-agent catalog
  -> LLM Planner
  -> validated WorkPlan / WorkOrders
  -> Runtime policy + capability checks
  -> worker execution
  -> evidence + verification
```

The planner must return one strict `create_work_plan` function call. Clone AI
validates the result before dispatching: IDs, risk classes, enabled agents,
capabilities, dependency references, artifact contracts, and durable receipts
for external work. Invalid output gets one correction attempt and then fails
closed.

## Enable it

The default remains the transparent local demo planner, so local demos never
make a paid API request unexpectedly.

```powershell
$env:CLONE_AI_PLANNER = "openai"
$env:OPENAI_API_KEY = "..."
$env:CLONE_AI_PLANNER_MODEL = "gpt-5"
npm run demo
```

Unset `CLONE_AI_PLANNER` to use the offline `buildDemoPlan()` fallback.

## Boundary

Memory is context, not authority. The current trigger and Runtime policy always
win over recalled memory. The LLM can propose an external action, but the
Runtime still places that step behind approval and requires receipt evidence.
