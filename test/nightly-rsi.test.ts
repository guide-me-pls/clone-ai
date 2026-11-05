import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { protectedPathViolations, stagedPaths } from "../scripts/nightly-rsi-policy.mjs";

test("trace files are never treated as a fix", () => {
  const touched = stagedPaths("src/a.ts\n.rsi/traces/run-1.json\n");
  assert.deepEqual(touched, ["src/a.ts", ".rsi/traces/run-1.json"]);
  assert.deepEqual(protectedPathViolations(touched), [".rsi/traces/run-1.json"]);
});

test("a repair that edits the authority plane is rejected", () => {
  const violations = protectedPathViolations([
    "src/bug.ts",
    "src/authority/policy.ts",
    "src/core/contracts.ts",
    "package.json",
  ]);
  assert.deepEqual(violations, ["src/authority/policy.ts", "src/core/contracts.ts", "package.json"]);
});

test("regression tests and ordinary source are allowed", () => {
  assert.deepEqual(protectedPathViolations([
    "src/bug.ts",
    "test/regression/bug.test.ts",
  ]), []);
});

test("a repair cannot weaken an existing test or the test configuration", () => {
  assert.deepEqual(protectedPathViolations([
    "test/base.test.ts",
    "tsconfig.json",
  ]), ["test/base.test.ts", "tsconfig.json"]);
});

test("a trace path cannot slip through with leading whitespace or rename syntax", () => {
  const touched = stagedPaths(" M src/bug.ts\nR  old.ts -> src/authority/policy.ts\n");
  assert.deepEqual(protectedPathViolations(touched), ["src/authority/policy.ts"]);
});

test("a filename containing spaces cannot bypass the protected-path gate", () => {
  const touched = stagedPaths("test/base test.ts\0src/bug.ts\0");
  assert.deepEqual(protectedPathViolations(touched), ["test/base test.ts"]);
});


test("the nightly script rejects a protected edit before creating a commit", async (t) => {
  if (process.platform === "win32") return t.skip("requires a POSIX shell");
  const root = process.cwd();
  const directory = await mkdtemp(join(tmpdir(), "clone-rsi-e2e-"));
  const repo = join(directory, "repo");
  const bin = join(repo, "bin");
  const data = join(directory, "data");
  await mkdir(join(repo, "src", "authority"), { recursive: true });
  await mkdir(join(repo, "test"), { recursive: true });
  await mkdir(bin, { recursive: true });
  await mkdir(join(data, "failed-traces"), { recursive: true });
  t.after(async () => {
    if (process.env.RSI_KEEP_TEST !== "1") await rm(directory, { recursive: true, force: true });
  });

  await writeFile(join(repo, "package.json"), JSON.stringify({
    name: "rsi-e2e",
    private: true,
    type: "module",
    scripts: { test: "node --experimental-strip-types --test test/*.test.ts test/regression/*.test.ts" },
  }));
  await writeFile(join(repo, "src", "bug.ts"), "export function answer(): number { return 1; }\n");
  await writeFile(join(repo, "src", "authority", "policy.ts"), "export const protectedBoundary = 'original';\n");
  await writeFile(join(repo, "test", "base.test.ts"), "import test from 'node:test'; import assert from 'node:assert/strict'; test('base', () => assert.equal(1, 1));\n");
  await writeFile(join(bin, "claude"), `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
const prompt = process.argv.slice(2).join(" ");
if (prompt.includes("You are repairing")) {
  mkdirSync("test/regression", { recursive: true });
  writeFileSync("test/regression/bug.test.ts", "import test from 'node:test';\\nimport assert from 'node:assert/strict';\\nimport { answer } from '../../src/bug.ts';\\ntest('reproduces the bug', () => assert.equal(answer(), 2));\\n");
} else {
  writeFileSync("src/bug.ts", "export function answer(): number { return 2; }\\n");
  writeFileSync("src/authority/policy.ts", "export const protectedBoundary = 'MUTATED BY REPAIR';\\n");
}
console.log(JSON.stringify({ type: "result", subtype: "success" }));
`);
  await chmod(join(bin, "claude"), 0o755);
  await writeFile(join(bin, "npx"), "#!/bin/bash\nexit 0\n");
  await chmod(join(bin, "npx"), 0o755);
  await writeFile(join(data, "failed-traces", "trace-1.json"), JSON.stringify({ schemaVersion: 1, id: "trace-1", runId: "trace-1", title: "bug", plan: [], executions: [], evidence: [], tail: [] }));

  await command("git", ["init", "-q", "-b", "main"], repo);
  await command("git", ["config", "user.email", "lab@example.com"], repo);
  await command("git", ["config", "user.name", "Lab"], repo);
  await command("git", ["add", "."], repo);
  await command("git", ["commit", "-qm", "initial"], repo);

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    CLAUDE_BIN: join(bin, "claude"),
    CLONE_AI_DATA_DIR: data,
  };
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_OPTIONS;
  const result = await commandResult(process.execPath, [join(root, "scripts", "nightly-rsi.mjs"), "--repo", repo, "--max-traces", "1", "--keep"], repo, childEnv);
  assert.equal(result.code, 1);
  assert.match(`${result.stdout}\n${result.stderr}`, /protected paths: src\/authority\/policy\.ts/);
  const branches = await command("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads/rsi"], repo);
  for (const branch of branches.stdout.split("\n").map((line) => line.trim()).filter(Boolean)) {
    const commit = await command("git", ["rev-parse", branch], repo);
    const main = await command("git", ["rev-parse", "main"], repo);
    assert.equal(commit.stdout.trim(), main.stdout.trim(), `${branch} must not contain a rejected repair commit`);
  }
});

async function command(commandName: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  const result = await commandResult(commandName, args, cwd);
  assert.equal(result.code, 0, `${commandName} ${args.join(" ")} failed: ${result.stderr}`);
  return result;
}

function commandResult(commandName: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(commandName, args, { cwd, env, timeout: 30_000, maxBuffer: 2_000_000 }, (error, stdout, stderr) => {
      resolve({
        code: error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1,
        stdout,
        stderr,
      });
    });
  });
}
