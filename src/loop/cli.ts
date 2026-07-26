import { join } from "node:path";

import { AgentLoop } from "./agent-loop.ts";
import { JsonlLoopJournal } from "./journal.ts";
import { OpenAIResponsesModel } from "./openai-responses-model.ts";
import { ToolRegistry, createWorkspaceTools } from "./tools.ts";

const goal = process.argv.slice(2).join(" ").trim() || "Read README.md and explain the current Clone AI runtime in five concise bullets.";
const apiKey = process.env.OPENAI_API_KEY;

if (apiKey === undefined || apiKey.trim().length === 0) {
  console.error("OPENAI_API_KEY is not set. In PowerShell, set it for this terminal first: $env:OPENAI_API_KEY = '...'");
  process.exitCode = 1;
} else {
  const workspaceRoot = process.cwd();
  const journal = new JsonlLoopJournal(join(workspaceRoot, ".clone-ai", "llm-loop.jsonl"));
  const loop = new AgentLoop({
    model: new OpenAIResponsesModel({ apiKey, model: process.env.CLONE_AI_OPENAI_MODEL ?? "gpt-5" }),
    tools: new ToolRegistry(createWorkspaceTools(workspaceRoot)),
    journal,
  });

  for await (const event of loop.run(goal)) {
    if (event.type === "tool.requested") {
      console.log(`[tool] ${JSON.stringify(event.payload)}`);
    }
    if (event.type === "run.completed") {
      const payload = event.payload as { answer: string };
      console.log(`\n${payload.answer}`);
      console.log(`\nTrace saved to ${join(workspaceRoot, ".clone-ai", "llm-loop.jsonl")}`);
    }
    if (event.type === "run.failed") {
      console.error(`\nRun failed: ${JSON.stringify(event.payload)}`);
      process.exitCode = 1;
    }
  }
}
