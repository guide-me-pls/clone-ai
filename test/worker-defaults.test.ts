import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { defaultWorkerProfiles, WorkerSettingsStore } from "../src/config/worker-settings.ts";
import { builtInProviders } from "../src/workers/provider-catalog.ts";

const NATIVE_ENV = {
  CLONE_AI_NATIVE_MODEL: "360/anthropic/claude-sonnet-5-5",
  CLONE_AI_NATIVE_BASE_URL: "http://127.0.0.1:3425",
};
