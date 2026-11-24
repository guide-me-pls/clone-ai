import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);

test("the desktop UI script parses as the browser will run it", async () => {
  // The UI contract tests read strings; a dropped parenthesis survives them.
  // node --check parses the whole file, which is the check that caught one on
  // 2026-11-24 after an otherwise-green UI test run.
  // UI 合同测试只读字符串，漏掉的括号能从中溜过；node --check 解析整个文件，
  // 2026-11-24 就是在 UI 测试全绿之后靠它抓到一处漏括号。
  await assert.doesNotReject(run(process.execPath, ["--check", join(process.cwd(), "apps", "desktop", "ui", "app.js")]));
});
