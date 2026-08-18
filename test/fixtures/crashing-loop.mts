// Runs a real AgentLoop against a temp directory and dies without cleanup the
// moment the model turn is journaled — the closest scriptable stand-in for a
// power loss. The parent test restarts from the same journal and checkpoints.
// 在临时目录上运行真实 AgentLoop，并在模型回合刚写入 Journal 的瞬间不做任何清理直接死掉——
// 这是最接近断电的可脚本化替身。父测试用同一份 Journal 与 Checkpoint 重启。
import { join } from "node:path";

import { AgentLoop } from "../../src/loop/agent-loop.ts";
import { JsonFileLoopCheckpointStore } from "../../src/loop/checkpoint.ts";
import { JsonlLoopJournal } from "../../src/loop/journal.ts";
import { ToolRegistry, createWorkspaceTools } from "../../src/loop/tools.ts";
import type { LoopModel, ModelTurn } from "../../src/loop/contracts.ts";

const directory = process.argv[2];
const runId = process.argv[3];
if (directory === undefined || runId === undefined) {
  console.error("Usage: crashing-loop.mts <directory> <run-id>");
  process.exit(2);
}

const model: LoopModel = {
  async respond(): Promise<ModelTurn> {
    return {
      kind: "tool_calls",
      calls: [{ id: "crash-read", name: "read_file", arguments: { path: "journal.jsonl" } }],
    };
  },
};

const loop = new AgentLoop({
  model,
  tools: new ToolRegistry(createWorkspaceTools(directory)),
  journal: new JsonlLoopJournal(join(directory, "journal.jsonl")),
  checkpoints: new JsonFileLoopCheckpointStore(join(directory, "checkpoints")),
});

for await (const event of loop.run("Survive a crash between planning and execution.", runId)) {
  if (event.type === "model.completed") {
    process.exit(137);
  }
}
