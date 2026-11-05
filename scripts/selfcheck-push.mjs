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
  if (branch !== "main") throw new Error(`selfcheck:push only runs on main, current branch is ${branch || "(detached)"}.`);
  const dirty = (await run("git", ["status", "--porcelain"], { cwd: process.cwd() })).stdout.trim();
  if (dirty.length > 0) throw new Error("selfcheck:push refuses a dirty worktree; commit or remove changes first.");

  console.log("[selfcheck] npm test");
  await command("npm", ["test"]);
  console.log("[selfcheck] npm run typecheck");
  await command("npm", ["run", "typecheck"]);
  console.log("[selfcheck] npm run gate");
  await command("npm", ["run", "gate"]);

  console.log("[selfcheck] fetching origin/main");
  await command("git", ["fetch", "origin", "main"]);
  const ahead = (await run("git", ["rev-list", "--count", "origin/main..HEAD"], { cwd: process.cwd() })).stdout.trim();
  const behind = (await run("git", ["rev-list", "--count", "HEAD..origin/main"], { cwd: process.cwd() })).stdout.trim();
  if (behind !== "0") throw new Error(`refusing to push: behind origin/main by ${behind} commit(s); rebase first.`);
  if (ahead === "0") {
    console.log("[selfcheck] nothing to push");
    return;
  }

  console.log(`[selfcheck] pushing ${ahead} commit(s) to origin/main`);
  await command("git", ["push", "origin", "main"]);
  console.log("[selfcheck] passed and pushed");
}

main().catch((error) => {
  console.error(`[selfcheck] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
