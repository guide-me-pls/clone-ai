import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { fileTools } from "../src/workers/native-worker-factory.ts";
import { resolveGrants } from "../src/authority/path-gateway.ts";
import { decideTool } from "../src/workers/native-agent-worker.ts";

/**
 * The file tools, tested for the failure that destroyed a file on 2026-11-11:
 * read_file returned a whole large file, the loop capped the tool result at
 * 8,000 characters, and the model wrote the prefix back as if it were the file.
 * 文件工具的测试，针对 2026-11-11 摧毁一个文件的失败：read_file 返回整个大文件，循环把工具
 * 结果截到 8,000 字符，模型把前缀当作文件本身写了回去。
 */
async function workspace(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clone-tools-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("an absolute path inside the workspace reads the file the gate allowed", async (t) => {
  const directory = await workspace(t);
  await writeFile(join(directory, "README.md"), "# Workspace readme\n\nABS_READ_OK\n", "utf8");
  const read = fileTools().find((tool) => tool.name === "read_file")!;
  // The planner names paths as absolute when the prompt gives it the workspace
  // path. The gate resolves them against the workspace; the tool must open the
  // same file instead of prefixing the workspace a second time.
  // 工作区路径进入 Prompt 后，规划器会用绝对路径。闸门按工作区解析它；工具必须打开同一个
  // 文件，而不是再拼一次工作区前缀。
  const target = join(directory, "README.md");
  const result = await read.run({ name: "read_file", input: { path: target } }, { workspace: directory });
  assert.notEqual(result.isError, true);
  assert.match(result.output, /ABS_READ_OK/);
});

test("a granted read root outside the workspace is readable through its absolute path", async (t) => {
  const directory = await workspace(t);
  const outside = await mkdtemp(join(tmpdir(), "clone-tools-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "note.md"), "OUTSIDE_READ_OK\n", "utf8");
  const target = join(outside, "note.md");
  const grants = resolveGrants([{ domain: "files", resource: outside, access: "read" }] as never, {
    workspace: directory,
  });
  assert.equal(decideTool({ risk: "read", grants, workspace: directory, path: target }).allowed, true);
  const read = fileTools().find((tool) => tool.name === "read_file")!;
  const result = await read.run({ name: "read_file", input: { path: target } }, { workspace: directory });
  assert.notEqual(result.isError, true);
  assert.match(result.output, /OUTSIDE_READ_OK/);
});

test("a long file is read in named windows with an explicit total", async (t) => {
  const directory = await workspace(t);
  const body = Array.from({ length: 1_200 }, (_, index) => `line ${index + 1}`).join("\n");
  await writeFile(join(directory, "big.txt"), body, "utf8");
  const read = fileTools().find((tool) => tool.name === "read_file")!;

  const first = await read.run({ name: "read_file", input: { path: "big.txt" } }, { workspace: directory });
  assert.match(first.output, /1200 lines total; showing 1-400; continue with offset=401/);
  assert.match(first.output, /line 1\n/);
  assert.equal(first.output.includes("line 401"), false, "the window must not include the next page");

  const second = await read.run({ name: "read_file", input: { path: "big.txt", offset: 401, limit: 400 } }, { workspace: directory });
  assert.match(second.output, /showing 401-800/);
  assert.match(second.output, /line 401/);
});

test("a window smaller than the loop's cap is what makes the read honest", async (t) => {
  const directory = await workspace(t);
  // 400 lines of 100 characters is ~40 KB; the loop keeps 8,000.
  // 400 行、每行 100 字符约 40 KB；循环只保留 8,000。
  await writeFile(join(directory, "wide.txt"), Array.from({ length: 400 }, () => "x".repeat(100)).join("\n"), "utf8");
  const read = fileTools().find((tool) => tool.name === "read_file")!;
  const result = await read.run({ name: "read_file", input: { path: "wide.txt" } }, { workspace: directory });
  assert.ok(result.output.length > 8_000, "a single window may still exceed the cap; the model is told the range");
  assert.match(result.output, /400 lines total/);
});

test("write_file refuses content that would discard most of an existing file", async (t) => {
  const directory = await workspace(t);
  const body = Array.from({ length: 500 }, (_, index) => `line ${index}`).join("\n");
  await writeFile(join(directory, "existing.ts"), body, "utf8");
  const write = fileTools().find((tool) => tool.name === "write_file")!;
  const fragment = "// __HEADER_IMPORTS__\nexport interface X { a: string }\n";

  const refused = await write.run({ name: "write_file", input: { path: "existing.ts", content: fragment } }, { workspace: directory });
  assert.equal(refused.isError, true, "a fragment must not replace the file");
  assert.match(refused.output, /would discard most of the file/);
  assert.equal(await readFile(join(directory, "existing.ts"), "utf8"), body, "the file is untouched");

  // A genuinely small replacement of a small file is still allowed. 对一个小文件做真正的小幅替换仍然允许。
  await writeFile(join(directory, "tiny.txt"), "one line", "utf8");
  const allowed = await write.run({ name: "write_file", input: { path: "tiny.txt", content: "another line" } }, { workspace: directory });
  assert.equal(allowed.isError, undefined);
});

test("the repair lane's refuse-existing mode still blocks every overwrite", async (t) => {
  const directory = await workspace(t);
  await writeFile(join(directory, "existing.ts"), "line", "utf8");
  const write = fileTools({ writeFileMode: "refuse-existing" }).find((tool) => tool.name === "write_file")!;
  const result = await write.run({ name: "write_file", input: { path: "existing.ts", content: "line" } }, { workspace: directory });
  assert.equal(result.isError, true);
  assert.match(result.output, /already exists/);
});
