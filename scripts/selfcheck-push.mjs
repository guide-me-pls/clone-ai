#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const env = {
  ...process.env,
  CLONE_AI_MAIN_LIVE: "0",
  CLONE_AI_PI_LIVE: "0",
  CLONE_AI_MEMORY_MINING: "0",
  CLONE_AI_MEMORY_MINING_UNRESTRICTED: "0",
};

async function command(name, args) {
  const result = await run(name, args, { cwd: process.cwd(), env, maxBuffer: 20_000_000 });
  if (result.stdout.trim().length > 0) process.stdout.write(result.stdout);
  if (result.stderr.trim().length > 0) process.stderr.write(result.stderr);
}

async function main() {
  const branch = (await run("git", ["branch", "--show-current"], { cwd: process.cwd() })).stdout.trim();
  const expectedBranch = process.env.SELFCHECK_BRANCH?.trim() || "main";
  const pushRef = process.env.SELFCHECK_PUSH_REF?.trim() || "main";
  if (branch !== expectedBranch) {
    throw new Error(`selfcheck:push expected branch ${expectedBranch}, current branch is ${branch || "(detached)"}.`);
  }
  const dirty = (await run("git", ["status", "--porcelain"], { cwd: process.cwd() })).stdout.trim();
  if (dirty.length > 0) throw new Error("selfcheck:push refuses a dirty worktree; commit or remove changes first.");

  console.log("[selfcheck] npm test");
  await command("npm", ["test"]);
  console.log("[selfcheck] npm run typecheck");
  await command("npm", ["run", "typecheck"]);
  console.log("[selfcheck] npm run gate");
  await command("npm", ["run", "gate"]);

  if (process.platform === "darwin") {
    // The desktop app is a packaged sidecar plus UI; source edits do not hot
    // reload. Replace the bundle only after every deterministic gate passes.
    // 桌面 App 是打包后的 sidecar 与 UI；源码修改不会热更新。只有全部确定性门禁
    // 通过后才替换 App 包。
    console.log("[selfcheck] rebuilding and replacing the macOS app");
    await command("npm", ["run", "desktop:mac:build", "--", "--replace"]);
  }

  console.log(`[selfcheck] fetching origin/${pushRef}`);
  await command("git", ["fetch", "origin", pushRef]);
  const ahead = (await run("git", ["rev-list", "--count", `origin/${pushRef}..HEAD`], { cwd: process.cwd() })).stdout.trim();
  const behind = (await run("git", ["rev-list", "--count", `HEAD..origin/${pushRef}`], { cwd: process.cwd() })).stdout.trim();
  if (behind !== "0") throw new Error(`refusing to push: behind origin/${pushRef} by ${behind} commit(s); rebase first.`);
  if (ahead === "0") {
    console.log("[selfcheck] nothing to push");
    return;
  }

  console.log(`[selfcheck] pushing ${ahead} commit(s) to origin/${pushRef}`);
  await command("git", ["push", "origin", `HEAD:${pushRef}`]);
  console.log("[selfcheck] passed and pushed");
}

main().catch((error) => {
  console.error(`[selfcheck] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
