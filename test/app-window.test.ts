import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { appProfileDirectory, appWindowArgs, findAppEngine } from "../src/cli/app-window.ts";

test("the app window opens chrome-less, sized, and on its own profile", () => {
  const args = appWindowArgs({ url: "http://127.0.0.1:4317", profileDirectory: "C:/profile", width: 1000, height: 700 });

  assert.ok(args.includes("--app=http://127.0.0.1:4317"), "app mode removes the address bar and tabs");
  assert.ok(args.includes("--user-data-dir=C:/profile"), "a dedicated profile keeps the owner's browser session out of it");
  assert.ok(args.includes("--window-size=1000,700"));
  assert.ok(args.some((arg) => arg.startsWith("--disable-features=")));
});

test("engine discovery picks the first installed candidate and reports none when absent", async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-engine-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const installed = join(directory, "browser.exe");
  await writeFile(installed, "", "utf8");

  assert.equal(findAppEngine([join(directory, "missing.exe"), installed]), installed);
  assert.equal(findAppEngine([join(directory, "missing.exe")]), undefined);
});

test("the app profile lives inside the clone home", () => {
  assert.equal(appProfileDirectory("/home/.clone"), join("/home/.clone", "app-window"));
});
