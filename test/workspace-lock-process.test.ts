import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${message}`);
}

test("a killed lock owner releases the workspace to only one competing process", { timeout: 15_000 }, async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "clone-ai-process-lock-"));
  const children: ChildProcess[] = [];
  const exits = new Map<ChildProcess, Promise<void>>();
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.allSettled([...exits.values()]);
    await rm(workspace, { recursive: true, force: true });
  });
  const start = (marker: string): ChildProcess => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "test/fixtures/workspace-lock-holder.ts", workspace, marker], { cwd: process.cwd(), stdio: "ignore" });
    children.push(child);
    exits.set(child, new Promise((resolve) => child.once("exit", () => resolve())));
    return child;
  };
  const first = start(join(workspace, "first"));
  await waitFor(() => existsSync(join(workspace, "first")), "first process to acquire the lock");
  const left = start(join(workspace, "left"));
  const right = start(join(workspace, "right"));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(existsSync(join(workspace, "left")) || existsSync(join(workspace, "right")), false);
  first.kill("SIGKILL");
  await exits.get(first);
  await waitFor(() => existsSync(join(workspace, "left")) || existsSync(join(workspace, "right")), "one successor to acquire the lock");
  await new Promise((resolve) => setTimeout(resolve, 200));
  const leftWon = existsSync(join(workspace, "left"));
  assert.notEqual(leftWon, existsSync(join(workspace, "right")));
  const winner = leftWon ? left : right;
  const loser = leftWon ? right : left;
  winner.kill("SIGKILL");
  await exits.get(winner);
  await waitFor(() => existsSync(join(workspace, leftWon ? "right" : "left")), "the other successor to acquire the released lock");
  loser.kill("SIGKILL");
  await exits.get(loser);
});
