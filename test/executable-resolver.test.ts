import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  augmentedExecutablePath,
  resolveExecutable,
} from "../src/workers/executable-resolver.ts";
import { WorkerRegistry } from "../src/workers/worker-registry.ts";

test("Finder-sized PATH falls back to owner-local executable directories", {
  skip: process.platform === "win32",
}, async (t) => {
  const home = await mkdtemp(join(tmpdir(), "clone-executable-home-"));
  t.after(async () => rm(home, { recursive: true, force: true }));
  const localBin = join(home, ".local", "bin");
  const executable = join(localBin, "finder-agent");
  await mkdir(localBin, { recursive: true });
  await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(executable, 0o700);

  const resolution = resolveExecutable("finder-agent", {
    environment: { PATH: "/usr/bin:/bin", HOME: home },
    homeDirectory: home,
  });

  assert.equal(resolution.resolvedPath, executable);
  assert.equal(resolution.source, "known-directory");
  assert.match(augmentedExecutablePath({
    environment: { PATH: "/usr/bin:/bin", HOME: home },
    homeDirectory: home,
  }), /\.local\/bin/);
});

test("PATH keeps precedence over fallback executable directories", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "clone-executable-precedence-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const pathBin = join(root, "path-bin");
  const home = join(root, "home");
  const localBin = join(home, ".local", "bin");
  await mkdir(pathBin, { recursive: true });
  await mkdir(localBin, { recursive: true });
  for (const executable of [join(pathBin, "finder-agent"), join(localBin, "finder-agent")]) {
    await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(executable, 0o700);
  }

  const resolution = resolveExecutable("finder-agent", {
    environment: { PATH: pathBin, HOME: home },
    homeDirectory: home,
  });

  assert.equal(resolution.resolvedPath, join(pathBin, "finder-agent"));
  assert.equal(resolution.source, "path");
});

test("provider status exposes the exact executable that will run", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "clone-provider-resolution-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const executable = join(root, "resolved-provider");
  await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(executable, 0o700);
  await writeFile(join(root, "providers.json"), JSON.stringify({
    providers: [{ id: "resolved-provider", command: executable }],
  }), "utf8");

  const status = (await new WorkerRegistry(root).list()).find((provider) => provider.id === "resolved-provider");
  assert.equal(status?.installed, true);
  assert.equal(status?.resolvedPath, executable);
  assert.equal(status?.resolutionSource, "absolute");
});
