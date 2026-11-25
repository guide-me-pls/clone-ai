import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { AgentModelRequest, AgentModelResponse } from "../../src/agent/loop.ts";
import type { ExecutionAssignment, ExecutionEvent } from "../../src/core/contracts.ts";
import { NativeAgentWorker, type NativeModelClient } from "../../src/workers/native-agent-worker.ts";

// A live step whose policy is 全部放行 for the files domain must receive `/` as
// a write root even though it declared no `files` write scope. The worker used
// to strip `files` from `unrestrictedDomains`, so `resolveGrants` returned an
// empty `writeRoots` and every write — including the one the step was allowed to
// make — was refused with "outside the step's granted write roots". Protected
// locations must still be refused.
// 文件域「全部放行」的活步骤即使没有声明 `files` 写 Scope，也必须拿到 `/` 作为写入根。
// Worker 曾把 `files` 从 `unrestrictedDomains` 中剔除，于是 `resolveGrants` 返回空的
// `writeRoots`，每次写入都被拒为 "outside the step's granted write roots"。
// 受保护位置仍必须被拒绝。

const OUTSIDE_PATH = join(tmpdir(), `clone-allow-all-repair-${process.pid}.txt`);
const PROTECTED_PATH = join(homedir(), ".ssh", "clone-repair-probe");

async function workspace(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clone-allow-all-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

function scriptedClient(responses: AgentModelResponse[], requests: AgentModelRequest[]): NativeModelClient {
  let index = 0;
  return {
    async complete(request) {
      requests.push(request);
      const next = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return next ?? { content: "done", toolCalls: [] };
    },
  };
}

function assignment(path: string): ExecutionAssignment {
  return {
    run: { id: "run-allow-all", taskId: "task-allow-all", status: "running", createdAt: "", updatedAt: "" },
    task: { id: "task-allow-all", triggerId: "t", title: "verify captures", objective: "write verify/probe.png", acceptanceCriteria: [], createdAt: "" },
    step: {
      id: "browser-verify",
      title: "browser verify",
      instructions: "Write verify/probe.png and capture screenshots.",
      risk: "reversible_write",
      acceptanceCriteria: ["verify/probe.png exists"],
      scopes: [],
    },
    executor: { agentId: "native", providerId: "native" },
    workspacePath: path,
    // 全部放行 for the files domain, and no declared files scope.
    unrestrictedDomains: ["files"],
  };
}

test("a live allow-all step may write outside the workspace but never to a protected location", async (t) => {
  const directory = await workspace(t);
  const requests: AgentModelRequest[] = [];
  const worker = new NativeAgentWorker({
    id: "native",
    label: "Native",
    createClient: () => scriptedClient([
      {
        content: null,
        toolCalls: [{ id: "outside", name: "write_file", arguments: JSON.stringify({ path: OUTSIDE_PATH }) }],
      },
      {
        content: null,
        toolCalls: [{ id: "protected", name: "write_file", arguments: JSON.stringify({ path: PROTECTED_PATH }) }],
      },
      { content: "writes attempted", toolCalls: [] },
    ], requests),
    tools: [
      {
        name: "write_file",
        description: "write a file",
        risk: "write",
        pathOf: (input) => String(input.path),
        run: async () => ({ output: "written" }),
      },
    ],
  });

  const events: ExecutionEvent[] = [];
  for await (const event of worker.execute(assignment(directory))) events.push(event);

  const results = (requests.at(-1)?.messages ?? [])
    .filter((message) => message.role === "tool")
    .map((message) => String(message.content));
  assert.equal(results.length, 2, "both write calls must reach the gate and come back as tool results");

  const [outside, protectedLocation] = results;
  assert.doesNotMatch(outside!, /outside the step's granted write roots/,
    "an allow-all live step must get / as a write root, so a write outside the workspace is allowed");
  assert.match(protectedLocation!, /protected location/,
    "a protected location such as ~/.ssh stays refused even under allow-all");
});
