import { join } from "node:path";

import { resolveClonePaths } from "../config/clone-home.ts";
import { AgentLoop } from "./agent-loop.ts";
import { JsonFileLoopCheckpointStore } from "./checkpoint.ts";
import { JsonlLoopJournal } from "./journal.ts";
import { OpenAIResponsesModel } from "./openai-responses-model.ts";
import { ToolRegistry, createWorkspaceTools } from "./tools.ts";

const args = process.argv.slice(2);
const resumeIndex = args.indexOf("--resume");
const resumeRunId = resumeIndex >= 0 ? args[resumeIndex + 1] : undefined;
const goal = (resumeIndex >= 0 ? [] : args).join(" ").trim()
  || "Read README.md and explain the current Clone AI runtime in five concise bullets.";
const apiKey = process.env.OPENAI_API_KEY;

if (apiKey === undefined || apiKey.trim().length === 0) {
  console.error("OPENAI_API_KEY is not set. In PowerShell, set it for this terminal first: $env:OPENAI_API_KEY = '...'");
  process.exitCode = 1;
} else if (resumeIndex >= 0 && (resumeRunId === undefined || resumeRunId.trim().length === 0)) {
  console.error("Usage: npm run loop -- --resume <run-id>");
  process.exitCode = 1;
} else {
  const workspaceRoot = process.cwd();
  // Loop state is per-project, so it belongs in the workspace runtime
  // directory rather than the owner's global home.
  // Loop 状态属于单个项目，因此放在 Workspace 运行目录，而不是所有者的全局主目录。
  const stateDirectory = resolveClonePaths({ workspacePath: workspaceRoot }).workspaceRuntimeDirectory;
  const journal = new JsonlLoopJournal(join(stateDirectory, "llm-loop.jsonl"));
  const checkpoints = new JsonFileLoopCheckpointStore(join(stateDirectory, "llm-loop-checkpoints"));
  const modelName = process.env.CLONE_AI_OPENAI_MODEL ?? "gpt-5";
  const loop = new AgentLoop({
    model: new OpenAIResponsesModel({ apiKey, model: modelName }),
    // Restart-resume needs a fresh provider adapter built from the
    // checkpointed continuation; without this factory the recovery machinery
    // is unreachable from the CLI entry point.
    // 重启恢复需要用 Checkpoint 里的 Continuation 重建 Provider Adapter；没有这个工厂，
    // 恢复机制在 CLI 入口就是不可达的。
    modelFactory: (continuation) => new OpenAIResponsesModel({ apiKey, model: modelName, continuation }),
    tools: new ToolRegistry(createWorkspaceTools(workspaceRoot)),
    journal,
    checkpoints,
  });

  const events = resumeRunId === undefined ? loop.run(goal) : loop.resume(resumeRunId);
  for await (const event of events) {
    if (event.type === "run.started") {
      console.log(`[run] ${event.runId} — if this run is interrupted, continue it with: npm run loop -- --resume ${event.runId}`);
    }
    if (event.type === "tool.requested") {
      console.log(`[tool] ${JSON.stringify(event.payload)}`);
    }
    if (event.type === "approval.requested") {
      console.log(`\nThe run is waiting for approval: ${JSON.stringify(event.payload)}`);
    }
    if (event.type === "run.completed") {
      const payload = event.payload as { answer: string };
      console.log(`\n${payload.answer}`);
      console.log(`\nTrace saved to ${join(stateDirectory, "llm-loop.jsonl")}`);
    }
    if (event.type === "run.failed") {
      console.error(`\nRun failed: ${JSON.stringify(event.payload)}`);
      process.exitCode = 1;
    }
  }
}
