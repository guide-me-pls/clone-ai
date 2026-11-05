import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { buildInstructions, decideTool, NativeAgentWorker, type NativeModelClient, type NativeToolCall } from "../src/workers/native-agent-worker.ts";
import type { ExecutionAssignment, ExecutionEvent } from "../src/core/contracts.ts";
import { resolveGrants } from "../src/authority/path-gateway.ts";

async function workspace(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-native-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

function assignment(path: string, scopes: ExecutionAssignment["step"]["scopes"] = []): ExecutionAssignment {
  return {
    run: { id: "run-1", taskId: "task-1", status: "running", createdAt: "", updatedAt: "" },
    task: { id: "task-1", triggerId: "t", title: "t", objective: "read a file", acceptanceCriteria: [], createdAt: "" },
    step: { id: "s1", title: "s1", instructions: "Read the note.", risk: "read_only", acceptanceCriteria: ["note read"], scopes },
    executor: { agentId: "native", providerId: "native" },
    workspacePath: path,
  };
}

function fakeClient(script: (call: (name: string, input?: Record<string, unknown>) => Promise<{ output: string; isError: boolean }>) => Promise<{ summary: string }>): NativeModelClient {
  return { run: ({ execute }) => script((name, input = {}) => execute({ name, input })) };
}

test("the gate refuses paths outside the grants, network without a scope, and external effects", async (t) => {
  const directory = await workspace(t);
  const grants = { readRoots: [realpathSync(directory)], writeRoots: [realpathSync(directory)], network: false };
  const root = realpathSync(directory);
  assert.deepEqual(decideTool({ risk: "read", grants, workspace: root }), { allowed: true });
  assert.equal(decideTool({ risk: "write", grants, workspace: root, path: "notes/today.md" }).allowed, true);
  assert.equal(decideTool({ risk: "write", grants, workspace: root, path: "../escape.md" }).allowed, false);
  assert.equal(decideTool({ risk: "network", grants, workspace: directory }).allowed, false);
  assert.equal(decideTool({ risk: "external", grants, workspace: directory }).allowed, false);
  // The worker never offers a tool whose risk the step did not grant, so a
  // network tool is refused at the offering stage; the gate also refuses it.
  // Worker 从不提供步骤未授权风险等级的工具，因此网络工具在提供阶段就被排除；闸门同样会拒绝。
  assert.equal(decideTool({ risk: "network", grants: { ...grants, network: true }, workspace: directory }).allowed, true);
});

test("a refused call returns a tool error to the model instead of killing the run", async (t) => {
  const directory = await workspace(t);
  await writeFile(join(directory, "note.md"), "remember the blue template", "utf8");
  const calls: Array<{ output: string; isError: boolean }> = [];
  const worker = new NativeAgentWorker({
    id: "native",
    label: "Native",
    createClient: () => fakeClient(async (call) => {
      calls.push(await call("read_file", { path: "note.md" }));
      calls.push(await call("write_file", { path: "../escape.md" }));
      calls.push(await call("fetch_url", { url: "https://example.com" }));
      return { summary: "read the note" };
    }),
    tools: [
      { name: "read_file", description: "read", risk: "read", pathOf: (input) => String(input.path), run: async (c) => ({ output: await readFile(join(directory, String(c.input.path)), "utf8") }) },
      { name: "write_file", description: "write", risk: "write", pathOf: (input) => String(input.path), run: async () => ({ output: "written" }) },
      // Offered but not granted: the worker filters it out before the model sees it.
      // 提供但未授权：Worker 在模型看到它之前就把它过滤掉。
      { name: "fetch_url", description: "fetch", risk: "network", run: async () => ({ output: "fetched" }) },
    ],
  });

  const events: ExecutionEvent[] = [];
  for await (const event of worker.execute(assignment(directory))) events.push(event);
  assert.equal(calls[0]!.isError, false);
  // The write is refused because its path escapes; the network tool is not offered.
  // 写入因路径逃逸被拒；网络工具根本不会被提供。
  assert.equal(calls[1]!.isError, true);
  assert.match(calls[1]!.output, /outside the step's granted scopes/);
  assert.equal(calls[2]!.isError, true);
  assert.match(calls[2]!.output, /no tool named fetch_url/);
  assert.equal(events.at(-1)?.type, "completed");
});

test("a read-only step's instructions say what was refused", async (t) => {
  const directory = await workspace(t);
  const grants = resolveGrants([{ domain: "files", resource: "/", access: "read" }] as never, { workspace: directory, home: "/home/owner" });
  const text = buildInstructions(assignment(directory), grants.dropped.map((item) => `${item.scope.domain}:${item.scope.resource} (${item.reason})`));
  assert.match(text, /Read the note/);
  assert.match(text, /Acceptance criteria/);
  assert.match(text, /too broad/);
});

test("a realpath-mismatched workspace still admits paths inside it, and refuses escapes", async (t) => {
  // The workspace root itself may be behind a symlink that the grants already
  // canonicalised (/tmp -> /private/tmp on macOS). Resolving the target but not
  // the workspace used to refuse every file inside it.
  // 工作区根可能位于授权已规范化的符号链接之后（macOS 上 /tmp -> /private/tmp）。
  // 只规范化目标而不规范化工作区，会把其中每个文件都拒掉。
  const directory = await workspace(t);
  const root = realpathSync(directory);
  const grants = { readRoots: [root], writeRoots: [root], network: false };
  // The workspace is named through its uncanonicalised path here.
  // 这里用未规范化的路径指代工作区。
  assert.equal(decideTool({ risk: "write", grants, workspace: directory, path: "out/hello.txt" }).allowed, true);
  assert.equal(decideTool({ risk: "write", grants, workspace: directory, path: "../escape.md" }).allowed, false);
});
