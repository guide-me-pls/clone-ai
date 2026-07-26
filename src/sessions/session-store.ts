import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

interface SessionIndex {
  deletedRunIds: string[];
}

/**
 * Keeps the conversation list tidy without rewriting the immutable runtime
 * journal. Deleting a session hides it from the companion UI but preserves
 * the evidence ledger for local audit and later recovery work.
 */
export class SessionStore {
  readonly #path: string;
  #writes: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  async isDeleted(runId: string): Promise<boolean> {
    return (await this.index()).deletedRunIds.includes(runId);
  }

  async deletedRunIds(): Promise<Set<string>> {
    return new Set((await this.index()).deletedRunIds);
  }

  async delete(runId: string): Promise<void> {
    const index = await this.index();
    if (index.deletedRunIds.includes(runId)) {
      return;
    }
    await this.write({ deletedRunIds: [...index.deletedRunIds, runId] });
  }

  private async index(): Promise<SessionIndex> {
    try {
      const source = await readFile(this.#path, "utf8");
      const parsed = JSON.parse(source) as Partial<SessionIndex>;
      return { deletedRunIds: Array.isArray(parsed.deletedRunIds) ? parsed.deletedRunIds.filter((id): id is string => typeof id === "string") : [] };
    } catch (error: unknown) {
      if (isMissingFile(error)) {
        return { deletedRunIds: [] };
      }
      throw error;
    }
  }

  private async write(index: SessionIndex): Promise<void> {
    const write = this.#writes.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true });
      await writeFile(this.#path, `${JSON.stringify(index, null, 2)}\n`, "utf8");
    });
    this.#writes = write.then(() => undefined, () => undefined);
    await write;
  }
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
