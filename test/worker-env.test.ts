import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assertWorkerEnvName } from "../src/workers/worker-env.ts";
import { writeUserProviderConfigs } from "../src/config/provider-config-store.ts";

test("model credentials pass; tool credentials do not", () => {
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_DEFAULT_*", "OPENAI_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"]) {
    assert.doesNotThrow(() => assertWorkerEnvName(name), name);
  }
  for (const name of [
    "GITHUB_TOKEN", "GH_TOKEN", "AWS_SECRET_ACCESS_KEY", "AWS_ACCESS_KEY_ID",
    "GOOGLE_APPLICATION_CREDENTIALS", "STRIPE_SECRET", "DATABASE_PASSWORD", "SLACK_BOT_TOKEN", "SOME_SERVICE_API_KEY",
  ]) {
    assert.throws(() => assertWorkerEnvName(name), /may not inherit/, name);
  }
});

test("a provider declaration with a tool credential is refused before it can launch", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-env-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  await assert.rejects(
    writeUserProviderConfigs(directory, [{ id: "pi", command: "pi", env: ["GEMINI_API_KEY", "GITHUB_TOKEN"] }]),
    /may not inherit GITHUB_TOKEN/,
  );
  const written = await writeUserProviderConfigs(directory, [{ id: "pi", command: "pi", env: ["GEMINI_API_KEY", "ANTHROPIC_DEFAULT_*"] }]);
  assert.deepEqual(written[0]?.env, ["GEMINI_API_KEY", "ANTHROPIC_DEFAULT_*"]);
});