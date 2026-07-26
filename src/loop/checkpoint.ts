import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { LoopCheckpointStore, LoopRunState } from "./contracts.ts";

/**
 * Checkpoints are derived caches, not the source of truth. An atomic replace
 * prevents a restart from reading a half-written JSON file; journal replay can
 * then apply anything newer than lastAppliedSequence.
 */
export class JsonFileLoopCheckpointStore implements LoopCheckpointStore {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  async save(state: LoopRunState): Promise<void> {
    await mkdir(this.#directory, { recursive: true });
    const target = this.pathFor(state.runId);
    const temporary = `${target}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2), "utf8");
    await rename(temporary, target);
  }

  async load(runId: string): Promise<LoopRunState | undefined> {
    try {
      return JSON.parse(await readFile(this.pathFor(runId), "utf8")) as LoopRunState;
    } catch (error: unknown) {
      if (isMissingFile(error)) {
        return undefined;
      }
      throw error;
    }
  }

  private pathFor(runId: string): string {
    return join(this.#directory, `${runId}.json`);
  }
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
