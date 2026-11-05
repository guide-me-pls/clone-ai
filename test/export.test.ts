import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { describeExport, exportOwnerData } from "../src/config/export.ts";

async function temp(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-export-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("an export copies memories and the journal, skips sessions, and writes a manifest", async (t) => {
  const source = await temp(t);
  const destination = await temp(t);
  await mkdir(join(source, "memory"), { recursive: true });
  await mkdir(join(source, "pi-sessions", "main-agent"), { recursive: true });
  await writeFile(join(source, "memory", "mem-1.md"), "# memory\n", "utf8");
  await writeFile(join(source, "journal.sqlite3"), "sqlite", "utf8");
  await writeFile(join(source, "journal.sqlite3-wal"), "wal", "utf8");
  await writeFile(join(source, "pi-sessions", "main-agent", "s.jsonl"), "{}\n", "utf8");

  const manifest = await exportOwnerData({ dataDirectory: source, destination });
  assert.deepEqual(manifest.files.map((file) => file.path).sort(), ["journal.sqlite3", "memory/mem-1.md"]);
  assert.match(manifest.notice, /not encrypted/);
  const written = JSON.parse(await readFile(join(destination, "manifest.json"), "utf8")) as { files: unknown[] };
  assert.equal(written.files.length, 2);
  assert.equal(await readFile(join(destination, "memory", "mem-1.md"), "utf8"), "# memory\n");
  assert.match(describeExport(manifest, destination), /Exported 2 files/);
});

test("includeSessions opts the conversation cache back in", async (t) => {
  const source = await temp(t);
  const destination = await temp(t);
  await mkdir(join(source, "pi-sessions"), { recursive: true });
  await writeFile(join(source, "pi-sessions", "s.jsonl"), "{}\n", "utf8");
  const manifest = await exportOwnerData({ dataDirectory: source, destination, includeSessions: true });
  assert.deepEqual(manifest.files.map((file) => file.path), ["pi-sessions/s.jsonl"]);
});
