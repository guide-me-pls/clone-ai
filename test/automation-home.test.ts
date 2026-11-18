import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AUTOMATION_HOME_ENV,
  ALLOW_OWNER_HOME_ENV,
  REFRESH_ENV,
  prepareAutomationHome,
  resolveAutomationHome,
} from "../scripts/automation-home.mjs";

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "clone-automation-home-"));
  return { root, owner: join(root, "owner"), repo: join(root, "repo") };
}

test("automation defaults to a repo-local home, not the owner's", async () => {
  const { owner, repo } = await workspace();
  const resolved = resolveAutomationHome({ repoRoot: repo, purpose: "repair", ownerDirectory: owner, env: {} });
  assert.equal(resolved.dataDirectory, join(repo, ".automation", "repair"));
  assert.equal(resolved.ownerDirectory, owner);
  assert.notEqual(resolved.dataDirectory, resolved.ownerDirectory);
});

test("an automation home equal to the owner's is refused unless explicitly allowed", async () => {
  const { owner, repo } = await workspace();
  assert.throws(
    () => resolveAutomationHome({
      repoRoot: repo,
      purpose: "eval",
      ownerDirectory: owner,
      env: { [AUTOMATION_HOME_ENV]: owner },
    }),
    /Refusing to run automation in the owner's clone home/,
  );
  const allowed = resolveAutomationHome({
    repoRoot: repo,
    purpose: "eval",
    ownerDirectory: owner,
    env: { [AUTOMATION_HOME_ENV]: owner, [ALLOW_OWNER_HOME_ENV]: "1" },
  });
  assert.equal(allowed.dataDirectory, owner);
});

test("CLONE_AI_AUTOMATION_HOME wins over the repo default", async () => {
  const { root, owner, repo } = await workspace();
  const isolated = join(root, "custom-home");
  const resolved = resolveAutomationHome({
    repoRoot: repo,
    purpose: "nightly",
    ownerDirectory: owner,
    env: { [AUTOMATION_HOME_ENV]: isolated },
  });
  assert.equal(resolved.dataDirectory, isolated);
});

test("seeding copies only the small config files, keeps them private, and does not overwrite by default", async () => {
  const { owner, repo } = await workspace();
  await mkdir(owner, { recursive: true });
  await writeFile(join(owner, "config.json"), "{\"model\":\"owner\"}\n");
  await chmod(join(owner, "config.json"), 0o644);
  await writeFile(join(owner, "journal.sqlite3"), "not a journal");
  await writeFile(join(owner, "companion.token"), "secret");
  await writeFile(join(owner, "settings.json"), "{\"agents\":[]}\n");

  const home = await prepareAutomationHome({ repoRoot: repo, purpose: "repair", ownerDirectory: owner, env: {} });
  assert.deepEqual(home.seeded, ["config.json", "settings.json"]);
  assert.equal(await readFile(join(home.dataDirectory, "config.json"), "utf8"), "{\"model\":\"owner\"}\n");
  assert.equal((await stat(join(home.dataDirectory, "config.json"))).mode & 0o777, 0o600);
  await assert.rejects(readFile(join(home.dataDirectory, "journal.sqlite3")));
  await assert.rejects(readFile(join(home.dataDirectory, "companion.token")));

  await writeFile(join(home.dataDirectory, "config.json"), "{\"model\":\"automation\"}\n");
  const again = await prepareAutomationHome({ repoRoot: repo, purpose: "repair", ownerDirectory: owner, env: {} });
  assert.deepEqual(again.seeded, []);
  assert.equal(await readFile(join(home.dataDirectory, "config.json"), "utf8"), "{\"model\":\"automation\"}\n");

  const refreshed = await prepareAutomationHome({
    repoRoot: repo,
    purpose: "repair",
    ownerDirectory: owner,
    env: { [REFRESH_ENV]: "1" },
  });
  assert.deepEqual(refreshed.seeded, ["config.json", "settings.json"]);
  assert.equal(await readFile(join(home.dataDirectory, "config.json"), "utf8"), "{\"model\":\"owner\"}\n");
});

test("a purpose cannot escape the automation root", () => {
  assert.throws(
    () => resolveAutomationHome({ repoRoot: "/tmp/repo", purpose: "../escape", ownerDirectory: "/tmp/owner", env: {} }),
    /purpose/i,
  );
});
