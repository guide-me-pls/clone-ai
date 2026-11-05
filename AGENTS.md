# AGENTS.md — rules for changing Clone AI

These rules bind every agent — human or model — that optimizes this repository.
"Optimization" means a change intended to improve behavior: prompts, tools,
routing, memory, policy, verification, performance, or the harness around them.
A documentation-only or mechanical fix is not an optimization, but it still
follows the normal test and changelog rules.

## 1. Write the trade-off before the change

Before implementing an optimization, add an entry to
[`docs/architecture/trade-offs.md`](docs/architecture/trade-offs.md) (and its
[zh-CN](docs/architecture/trade-offs.zh-CN.md) pair) with:

- what is being decided, and the alternative(s) rejected;
- the evidence that justifies it (measurement, failing test, incident, or a
  clearly marked assumption);
- the condition under which a later reader should reverse it.

If you cannot state the reversal condition, the change is not understood well
enough to make.

**Why:** an optimization whose reason lives only in a chat or a commit message
becomes folklore; the next agent either preserves it blindly or deletes it
blindly.

## 2. Every optimization carries an eval

An optimization must ship with an eval that distinguishes before from after:

- deterministic judgment changes → a case in [`benchmark/gate/`](benchmark/gate/);
- provider or orchestration changes → a task in [`benchmark/`](benchmark/);
- contracts and wiring → a test in `test/`.

Record the command and the before/after result in the optimization log. If the
eval cannot be run (cost, environment), say so and mark the change "assumed" in
the trade-off entry; do not call it an improvement.

**Why:** without an eval, "optimization" is a hypothesis. The regression gate
already treats any behavior change as reviewable; this rule makes that
expectation explicit before the fact.

## 3. Record the execution chain and its pros and cons

For each optimization, add an entry to
[`docs/engineering/optimizations.md`](docs/engineering/optimizations.md) with:

- the goal and hypothesis;
- the trade-off entry it references;
- the change and the files or areas touched;
- the eval command and its before/after result;
- the execution chain: steps taken, workers or tools used, duration and cost,
  failures and retries;
- what worked, what did not, and what you would do differently;
- the reversal condition.

The log is the audit trail for the *work*, not just the code: a later reader
must be able to see why the chain was chosen and where it was weak.

**Why:** the journal and the run trace explain what the runtime did; they do not
explain what the optimization process did, what it cost, or which shortcuts it
took.

## Checklist

- [ ] Trade-off entry written before implementation.
- [ ] Eval added or updated; before/after recorded.
- [ ] Optimization log entry completed after the change.
- [ ] `npm test`, `npm run typecheck`, `npm run gate` pass.
- [ ] CHANGELOG updated (bilingual).

---

# AGENTS.md — 修改 Clone AI 的规则

这些规则约束每一个优化本仓库的 Agent——无论人还是模型。“优化”指意图改进行为的
变更：提示词、工具、路由、记忆、策略、验证、性能，或围绕它们的 harness。纯文档或
机械性修复不算优化，但仍遵循常规的测试与 CHANGELOG 规则。

## 1. 变更之前先写取舍

实现优化之前，在 [`docs/architecture/trade-offs.md`](docs/architecture/trade-offs.md)
（及其[中文版](docs/architecture/trade-offs.zh-CN.md)）追加一条，写明：

- 决定了什么，以及被否决的备选方案；
- 支撑它的证据（实测、失败测试、事故，或明确标注的假设）；
- 后来者在什么条件下应当推翻它。

如果写不出推翻条件，说明这个变更还没有被理解到可以动手的程度。

**为什么：** 只存在于聊天或提交信息里的理由会变成口口相传的传说；下一个 Agent
要么盲目保留，要么盲目删除。

## 2. 每个优化都必须有 eval

优化必须附带一个能区分“变更前”与“变更后”的 eval：

- 确定性的判断规则变化 → [`benchmark/gate/`](benchmark/gate/) 中的一个用例；
- Provider 或编排变化 → [`benchmark/`](benchmark/) 中的一个任务；
- 契约与接线 → `test/` 中的一个测试。

在优化日志里记录命令与前后结果。如果 eval 无法运行（成本、环境），如实说明，并在
取舍条目里标为“假设”——不要称它为改进。

**为什么：** 没有 eval 的“优化”只是假设。回归门禁已经把任何行为变化视为需要审查；
这条规则把那项预期提前到动手之前。

## 3. 记录执行链路及其优劣

每个优化都在 [`docs/engineering/optimizations.md`](docs/engineering/optimizations.md)
追加一条，写明：

- 目标与假设；
- 引用的取舍条目；
- 变更内容与涉及的目录或文件；
- eval 命令及其前后结果；
- 执行链路：走过的步骤、使用的 Worker 或工具、耗时与成本、失败与重试；
- 哪些做得好、哪些不好、下次会怎么做；
- 推翻条件。

这份日志是**工作本身**的审计轨迹，而不只是代码的：后来者必须能看到链路为何这样选、
薄弱点在哪里。

**为什么：** Journal 与运行轨迹解释运行时做了什么，却解释不了优化过程做了什么、
花了多少、走了哪些捷径。

## 检查清单

- [ ] 实现之前已写取舍条目。
- [ ] 已新增或更新 eval，并记录前后结果。
- [ ] 变更完成后已补全优化日志。
- [ ] `npm test`、`npm run typecheck`、`npm run gate` 通过。
- [ ] CHANGELOG 已更新（双语）。
