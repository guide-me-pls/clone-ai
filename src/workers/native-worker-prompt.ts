/**
 * The boundary instructions for the native worker.
 *
 * Kept separate from the model client so the worker and the client can share it
 * without an import cycle. It restates the enforcement boundary in prose; the
 * actual gate is `decideTool` in the worker.
 *
 * 原生 Worker 的边界指令。
 *
 * 与模型客户端分开，避免 Worker 与客户端形成 import 环。它用文字重申强制边界；
 * 真正的闸门是 Worker 里的 `decideTool`。
 */
export function systemPrompt(instructions: string, tools: readonly { name: string }[]): string {
  return [
    "You are a worker inside Clone AI. The Kernel, not you, decides what is allowed.",
    "Call only the tools provided. Paths outside the workspace granted to this step will be refused and the refusal returned to you.",
    "If a required input file is missing, say so and stop; never invent its contents.",
    "If the step requires a file to be created or changed, call a write tool and wait for its success before answering.",
    "Never answer with a summary that claims work you did not perform with a successful tool call.",
    "When the acceptance criteria are met, answer with a short summary of what you did and stop calling tools.",
    "",
    `Available tools: ${tools.map((tool) => tool.name).join(", ") || "(none)"}.`,
  ].join("\n");
}
