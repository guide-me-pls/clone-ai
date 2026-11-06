import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";


import { createJournalStore } from "../src/core/sqlite-journal.ts";
import { createKernelToolsExtension } from "../src/main-agent/tools/kernel-tools.ts";
import {
  capturePromptSnapshot,
  hashCanonical,
  recordPromptSnapshot,
  type MainAgentPromptMaterials,
} from "../src/main-agent/prompt-snapshot.ts";

async function tempDir(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-prompt-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

function materials(overrides: Partial<MainAgentPromptMaterials> = {}): MainAgentPromptMaterials {
  return {
    charter: "You are clone-main, the Main Agent of Clone AI.",
    charterVersion: 1,
    briefing: "No overdue commitments.",
    systemPrompt: "You are clone-main, the Main Agent of Clone AI.\n\nNo overdue commitments.",
    tools: [{
      name: "propose_work_plan",
      description: "Propose a work plan.",
      parameters: { type: "object", properties: { summary: { type: "string" } } },
    }],
    modelId: "test-model",
    provider: "test-provider",
    effort: "medium",
    ...overrides,
  };
}

test("canonical hashes ignore object key order and change with content", () => {
  assert.equal(
    hashCanonical({ a: 1, b: { c: 2, d: 3 } }),
    hashCanonical({ b: { d: 3, c: 2 }, a: 1 }),
  );
  assert.notEqual(hashCanonical({ a: 1 }), hashCanonical({ a: 2 }));
  assert.notEqual(hashCanonical([1, 2]), hashCanonical([2, 1]));
});

test("a snapshot is content-addressed and identical material reuses the file", async (t) => {
  const directory = await tempDir(t);
  const first = await capturePromptSnapshot(directory, materials(), new Date("2026-11-05T00:00:00.000Z"));
  const second = await capturePromptSnapshot(directory, materials(), new Date("2026-11-06T00:00:00.000Z"));

  assert.equal(first.materialHash, second.materialHash);
  assert.equal(first.locator, second.locator);
  assert.deepEqual(first.toolNames, ["propose_work_plan"]);

  const stored = JSON.parse(await readFile(join(directory, first.locator), "utf8")) as {
    systemPrompt: string;
    charter: string;
    capturedAt: string;
  };
  assert.equal(stored.systemPrompt, materials().systemPrompt);
  assert.equal(stored.charter, materials().charter);
  // First writer wins: the bytes are the same, so the capture time is kept.
  // 先写者胜出：字节完全相同，因此保留第一次的捕获时间。
  assert.equal(stored.capturedAt, "2026-11-05T00:00:00.000Z");
});

test("briefing and tool changes move different hashes", async (t) => {
  const directory = await tempDir(t);
  const base = await capturePromptSnapshot(directory, materials());
  const changedBriefing = await capturePromptSnapshot(directory, materials({
    briefing: "One commitment is overdue.",
    systemPrompt: "You are clone-main, the Main Agent of Clone AI.\n\nOne commitment is overdue.",
  }));
  assert.notEqual(base.promptHash, changedBriefing.promptHash);
  assert.notEqual(base.briefingHash, changedBriefing.briefingHash);
  assert.equal(base.charterHash, changedBriefing.charterHash);
  assert.equal(base.toolsHash, changedBriefing.toolsHash);

  const changedTools = await capturePromptSnapshot(directory, materials({
    tools: [{ name: "search_history", description: "Search.", parameters: { type: "object" } }],
  }));
  assert.notEqual(base.toolsHash, changedTools.toolsHash);
  assert.notEqual(base.materialHash, changedTools.materialHash);
});

test("recording appends one journal event that points at the stored material", async (t) => {
  const directory = await tempDir(t);
  const recorded = await recordPromptSnapshot(directory, materials(), { turnId: "turn-1" });
  assert.ok(recorded);

  const journal = createJournalStore(directory);
  try {
    const events = await journal.list();
    const snapshots = events.filter((event) => event.type === "main_agent.prompt_snapshot");
    assert.equal(snapshots.length, 1);
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(payload.turnId, "turn-1");
    assert.equal(payload.promptHash, recorded.promptHash);
    assert.equal(payload.toolsHash, recorded.toolsHash);
    assert.equal(payload.modelId, "test-model");
    assert.equal(payload.effort, "medium");
    await readFile(join(directory, String(payload.locator)));
  } finally {
    (journal as { close?: () => void }).close?.();
  }
});

test("every registered Kernel tool is visible to provenance", async (t) => {
  const directory = await tempDir(t);
  const registered: Array<{ name: string; parameters?: unknown }> = [];
  const pi = {
    registerTool(_tool: unknown) {
      // The extension registers through this method; nothing else is needed.
      // 扩展只通过这个方法注册工具，除此之外不需要别的东西。
    },
  };
  createKernelToolsExtension(pi, { dataDirectory: directory, onRegister: (tool) => registered.push(tool) });

  const names = registered.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "get_authority",
    "get_run_status",
    "get_situation",
    "propose_work_plan",
    "read_memory",
    "recall_memory",
    "record_state",
    "request_approval",
    "search_history",
  ]);
  for (const tool of registered) assert.doesNotThrow(() => hashCanonical(tool.parameters));
});

test("a snapshot that cannot be written is logged, not thrown", async (t) => {
  const directory = await tempDir(t);
  const notADirectory = join(directory, "journal.sqlite3");
  await writeFile(notADirectory, "not a directory");

  // Telemetry must not cost the owner the turn: recording fails quietly.
  // 遥测不能让所有者失去这一轮：记录失败时保持静默。
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    const recorded = await recordPromptSnapshot(notADirectory, materials());
    assert.equal(recorded, undefined);
  } finally {
    process.stderr.write = original;
  }
  assert.match(chunks.join(""), /main_agent\.prompt_snapshot failed/);
});
