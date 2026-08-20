import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

const documentPairs = [
  ["README.md", "README.zh-CN.md"],
  ["docs/initial-runtime.md", "docs/initial-runtime.zh-CN.md"],
  ["docs/coding-cli-adapters.md", "docs/coding-cli-adapters.zh-CN.md"],
  ["docs/llm-planner.md", "docs/llm-planner.zh-CN.md"],
  ["docs/query-execution-flow.md", "docs/query-execution-flow.zh-CN.md"],
  ["docs/runtime-architecture-and-route.md", "docs/runtime-architecture-and-route.zh-CN.md"],
  ["docs/work-orders-and-pi.md", "docs/work-orders-and-pi.zh-CN.md"],
  ["docs/architecture/agent-runtime-convergence.md", "docs/architecture/agent-runtime-convergence.zh-CN.md"],
  ["benchmark/README.md", "benchmark/README.zh-CN.md"],
  ["apps/desktop/README.md", "apps/desktop/README.zh-CN.md"],
] as const;

test("reader documentation is maintained in English and Chinese pairs", async () => {
  for (const [englishPath, chinesePath] of documentPairs) {
    const [english, chinese] = await Promise.all([
      readFile(join(root, englishPath), "utf8"),
      readFile(join(root, chinesePath), "utf8"),
    ]);
    assert.match(english, /简体中文/, `${englishPath} should link to its Chinese counterpart.`);
    assert.match(chinese, /English/, `${chinesePath} should link to its English counterpart.`);
  }
});

test("explanatory source comments include both English and Chinese", async () => {
  const files = [
    ...(await sourceFiles(join(root, "src"))),
    ...(await sourceFiles(join(root, "test"))),
  ];

  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const comment of commentBlocks(source)) {
      if (!/[A-Za-z]/.test(comment)) continue;
      assert.match(comment, /[\u3400-\u9fff]/u, `${file} has an English-only explanatory comment: ${comment}`);
    }
  }
});

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|mjs)$/.test(entry.name) ? [path] : [];
  }));
  return nested.flat();
}

function commentBlocks(source: string): string[] {
  const blockComments = source.match(/\/\*\*[\s\S]*?\*\//g) ?? [];
  const lineComments = source.match(/(?:^\s*\/\/.*(?:\r?\n|$))+/gm) ?? [];
  return [...blockComments, ...lineComments];
}
