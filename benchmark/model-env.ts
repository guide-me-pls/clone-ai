/**
 * The model id a live benchmark or validation run talks to.
 *
 * The repository carries no default: the endpoint and its model ids belong to
 * the operator's gateway, so a run names the model through
 * `CLONE_AI_BENCH_MAIN_MODEL` (or the runtime's `CLONE_AI_NATIVE_MODEL`). A
 * missing value fails before the first request instead of sending a placeholder
 * id the gateway would reject.
 *
 * 实机基准或验证运行的模型 ID。
 *
 * 仓库不内置默认值：端点与其模型 ID 属于使用者的网关，因此运行通过
 * `CLONE_AI_BENCH_MAIN_MODEL`（或运行时的 `CLONE_AI_NATIVE_MODEL`）指定模型。缺失时在
 * 第一次请求之前就失败，而不是发送一个网关必然拒绝的占位 ID。
 */
export function requiredBenchmarkModel(environment: NodeJS.ProcessEnv = process.env): string {
  const model = (environment.CLONE_AI_BENCH_MAIN_MODEL ?? environment.CLONE_AI_NATIVE_MODEL ?? "").trim();
  if (model.length === 0) {
    throw new Error(
      "Set CLONE_AI_BENCH_MAIN_MODEL (or CLONE_AI_NATIVE_MODEL) to the model id the endpoint serves.",
    );
  }
  return model;
}