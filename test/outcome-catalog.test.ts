import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  BUILT_IN_CATALOG,
  classifyFailure,
  corroborateFailures,
  loadOutcomeCatalog,
  OUTCOMES_DIRECTORY,
  FAILURES_FILE,
  type FailureReport,
} from "../src/core/failure-analysis.ts";

async function catalogDirectory(t: TestContext, contents?: string): Promise<string> {
  const dataDirectory = await mkdtemp(join(tmpdir(), "clone-ai-outcomes-"));
  t.after(async () => rm(dataDirectory, { recursive: true, force: true }));
  if (contents !== undefined) {
    await mkdir(join(dataDirectory, OUTCOMES_DIRECTORY), { recursive: true });
    await writeFile(join(dataDirectory, OUTCOMES_DIRECTORY, FAILURES_FILE), contents, "utf8");
  }
  return dataDirectory;
}

test("without a catalog file the built-in minimum is used", async (t) => {
  const catalog = await loadOutcomeCatalog(await catalogDirectory(t));

  assert.equal(catalog.source, "builtin");
  assert.equal(classifyFailure("unauthorized: no api key", "nonzero_exit", catalog).category, "missing_credential");
});

test("the owner can teach the system a failure the code never knew about", async (t) => {
  // The point of externalizing this: which errors an agent emits changes with
  // every release, and the owner sees them before any code could.
  // 外置这份目录的意义：Agent 会报什么错随每次发版而变，而所有者比任何代码都先看到。
  const dataDirectory = await catalogDirectory(t, JSON.stringify({
    patterns: [
      {
        category: "sandbox_denied",
        match: "sandbox (policy )?(refused|denied)",
        guidance: "The agent's own sandbox blocked the action. Grant the workspace path in its config.",
      },
    ],
    fallbackCategory: "unknown",
    inconclusiveCategories: ["unknown", "nonzero_exit"],
  }));

  const catalog = await loadOutcomeCatalog(dataDirectory);
  assert.equal(catalog.source, "file");
  const classified = classifyFailure("fatal: sandbox policy refused write to /work", "nonzero_exit", catalog);
  assert.equal(classified.category, "sandbox_denied");
  assert.match(classified.guidance ?? "", /Grant the workspace path/);

  // A category the owner did not declare no longer matches.
  // 所有者未声明的类别不再会被匹配到。
  assert.equal(classifyFailure("unauthorized: no api key", "nonzero_exit", catalog).category, "nonzero_exit");
});

test("owner-defined categories participate in cross-agent corroboration", async (t) => {
  const dataDirectory = await catalogDirectory(t, JSON.stringify({
    patterns: [{ category: "sandbox_denied", match: "sandbox", guidance: "Check the agent's sandbox settings." }],
    fallbackCategory: "unknown",
    inconclusiveCategories: ["unknown"],
  }));
  const catalog = await loadOutcomeCatalog(dataDirectory);

  const report = (providerId: string, text: string): FailureReport => ({
    providerId,
    agentId: "worker",
    category: classifyFailure(text, "nonzero_exit", catalog).category,
    signature: text,
    detail: text,
    ...(classifyFailure(text, "nonzero_exit", catalog).guidance === undefined
      ? {}
      : { guidance: classifyFailure(text, "nonzero_exit", catalog).guidance }),
  });

  const verdict = corroborateFailures(
    [report("claude-code", "sandbox refused"), report("codex-cli", "sandbox blocked the path")],
    catalog,
  );
  assert.equal(verdict.corroborated, true);
  assert.equal(verdict.category, "sandbox_denied");
  // The owner's own guidance travels with the verdict.
  // 所有者自撰的建议随判定结果一起传递。
  assert.match(verdict.guidance ?? "", /sandbox settings/);
});

test("a malformed catalog fails loudly instead of degrading silently", async (t) => {
  const notJson = await catalogDirectory(t, "{ this is not json");
  await assert.rejects(loadOutcomeCatalog(notJson), /not valid JSON/);

  const badPattern = await catalogDirectory(t, JSON.stringify({ patterns: [{ category: "x", match: "([unclosed" }] }));
  await assert.rejects(loadOutcomeCatalog(badPattern), /invalid "match" expression/);

  const noCategory = await catalogDirectory(t, JSON.stringify({ patterns: [{ match: "boom" }] }));
  await assert.rejects(loadOutcomeCatalog(noCategory), /needs a non-empty "category"/);
});

test("the catalog explains failures but cannot declare success", async (t) => {
  // The boundary that keeps evidence trustworthy: an owner may reshape how a
  // failure is described, never whether work counts as done. Completion stays
  // the Kernel's judgement from the workspace.
  // 让证据保持可信的边界：所有者可以重塑失败如何被描述，但绝不能决定工作是否算完成。
  // 完成判定始终是 Kernel 依据 Workspace 做出的。
  const dataDirectory = await catalogDirectory(t, JSON.stringify({
    patterns: [{ category: "actually_fine", match: ".*", guidance: "Nothing to see here." }],
    fallbackCategory: "actually_fine",
  }));
  const catalog = await loadOutcomeCatalog(dataDirectory);

  const surface = Object.keys(catalog);
  assert.deepEqual(surface.sort(), ["fallbackCategory", "inconclusiveCategories", "patterns", "source"]);
  // No key in the schema can mark a run complete or produce evidence.
  // Schema 里没有任何键可以标记运行完成或产生证据。
  assert.equal(surface.some((key) => /success|complete|artifact|evidence/i.test(key)), false);
});

test("the built-in catalog stays minimal on purpose", () => {
  // Four patterns is a floor, not a taxonomy: the owner's file is the real one.
  // 四条模式只是下限而非完整分类：所有者的文件才是真正的目录。
  assert.ok(BUILT_IN_CATALOG.patterns.length <= 6);
  assert.equal(BUILT_IN_CATALOG.source, "builtin");
});
