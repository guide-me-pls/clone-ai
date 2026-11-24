/**
 * The boundary instructions for the native worker.
 *
 * Kept separate from the model client so the worker and the client can share it
 * without an import cycle. It restates the enforcement boundary in prose; the
 * actual gate is `decideTool` in the worker.
 *
 * When the Main Agent supplied a brief, that brief is the task prompt and this
 * module adds only the execution contract: the tool list, the gate, and the
 * stop condition. Without a brief, the previous template is used unchanged.
 *
 * 原生 Worker 的边界指令。
 *
 * 与模型客户端分开，避免 Worker 与客户端形成 import 环。它用文字重申强制边界；
 * 真正的闸门是 Worker 里的 `decideTool`。
 *
 * 主 Agent 提供了简报时，简报就是任务提示词，本模块只追加执行契约：工具表、闸门与停止
 * 条件。没有简报时，沿用原来的模板。
 */
export function workerBriefOf(input: {
  workOrder?: { workerBrief?: string };
  step: { workerBrief?: string };
}): string | undefined {
  const brief = input.workOrder?.workerBrief ?? input.step.workerBrief;
  if (typeof brief !== "string") return undefined;
  const trimmed = brief.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function systemPrompt(brief: string | undefined, tools: readonly { name: string }[]): string {
  const toolList = tools.map((tool) => tool.name).join(", ") || "(none)";
  if (brief !== undefined && brief.trim().length > 0) {
    return [
      brief.trim(),
      "",
      "Execution contract (fixed by the Kernel; the brief above is the task):",
      "The Kernel, not you, decides what is allowed. Call only the tools listed below.",
      "Reads may reach any readable location on this computer except protected locations; a write is refused unless the path is inside a write root granted to this step, and the refusal is returned to you.",
      "If the brief names a project or directory, read that exact path. If it cannot be found or read, say so and stop; do not review this workspace in its place.",
      "If a required input file is missing, say so and stop; never invent its contents.",
      "If the brief requires a file to be created or changed, call a write tool and wait for its success before answering.",
      "Never answer with a summary that claims work you did not perform with a successful tool call.",
      "When the acceptance criteria are met, answer with a short summary of what you did and stop calling tools.",
      "",
      `Available tools: ${toolList}.`,
    ].join("\n");
  }
  return [
    "You are a worker inside Clone AI. The Kernel, not you, decides what is allowed.",
    "Call only the tools provided. Reads may reach any readable location on this computer except protected locations; a write is refused unless the path is inside a write root granted to this step, and the refusal is returned to you.",
    "If a required input file is missing, say so and stop; never invent its contents.",
    "If the step requires a file to be created or changed, call a write tool and wait for its success before answering.",
    "If your work order lists a required artifact with a durable locator, it is recorded only by a successful write tool inside the workspace; a text summary alone does not satisfy it.",
    "If the objective forbids writing but a required artifact needs a durable locator, report the conflict and stop; do not write against the owner's instruction.",
    "Never answer with a summary that claims work you did not perform with a successful tool call.",
    "When the acceptance criteria are met, answer with a short summary of what you did and stop calling tools.",
    "",
    `Available tools: ${toolList}.`,
  ].join("\n");
}
