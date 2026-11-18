#!/usr/bin/env node
/**
 * Point this clone at the tracked .githooks/ directory.
 *
 * Git does not version .git/hooks, so the pre-push app rebuild would otherwise
 * exist only on the machine that wrote it. core.hooksPath is a local config
 * (one line), while the hook itself is reviewed and versioned with the code.
 *
 * 让本克隆使用仓库内纳入版本管理的 .githooks/。
 *
 * Git 不跟踪 .git/hooks，若不这样做，推送前重打包的钩子只存在于写下它的机器上。
 * core.hooksPath 只是一行本地配置，钩子本身则随代码一起评审与版本化。
 */
import { execFileSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const hooks = join(root, ".githooks");

execFileSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: root, stdio: "inherit" });
for (const name of ["pre-push"]) {
  chmodSync(join(hooks, name), 0o755);
}

console.log(`Git hooks enabled: ${hooks}`);
console.log("Pushing main now rebuilds dist/Clone AI.app when bundled source changed.");
console.log("Skip one push with: CLONE_AI_SKIP_APP_BUILD=1 git push");