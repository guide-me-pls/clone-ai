import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("the live benchmark refuses unisolated execution without explicit consent", async () => {
  const benchmark = fileURLToPath(new URL("../benchmark/run.ts", import.meta.url));
  const result = await new Promise<{ code: number; output: string }>((resolve) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", benchmark, "--provider", "claude-code", "--tasks", "missing-input"]);
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
  assert.equal(result.code, 2);
  assert.match(result.output, /--unsafe-host/);
});
