import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

interface DeletedConversation {
  id: string;
  /** Runs hidden together with the conversation. 随对话一起隐藏的 Run。 */
  childRunIds: string[];
  at: string;
}

interface SessionIndex {
  deletedRunIds: string[];
  deletedConversations: DeletedConversation[];
}

/**
 * Keeps the conversation list tidy without rewriting the immutable runtime
 * journal. Deleting a session hides it from the companion UI but preserves
 * the evidence ledger for local audit and later recovery work.
 *
 * 它让会话列表保持整洁，而不改写不可变的 Runtime Journal。删除 Session 只会在 Companion UI
 * 中隐藏它，仍会保留 Evidence Ledger 用于本地审计与后续恢复。
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

  async isConversationDeleted(id: string): Promise<boolean> {
    return (await this.index()).deletedConversations.some((entry) => entry.id === id);
  }

  async deletedConversations(): Promise<DeletedConversation[]> {
    return (await this.index()).deletedConversations;
  }

  /**
   * Hide a conversation together with the runs it spawned. A task derived from
   * the chat is not a second conversation; removing the parent removes its
   * children in the same step, and the record keeps which ids went with it so a
   * restore can bring exactly those back.
   * 连同它派生出的 Run 一起隐藏对话。由对话派生出的任务不是第二个对话；移除父级时子级在
   * 同一步一起移除，并记录随之移除的 id，使恢复能精确还原这些。
   */
  async deleteConversation(id: string, childRunIds: string[], now = new Date().toISOString()): Promise<void> {
    const index = await this.index();
    if (index.deletedConversations.some((entry) => entry.id === id)) return;
    const merged = new Set([...index.deletedRunIds, ...childRunIds]);
    await this.write({
      deletedRunIds: [...merged],
      deletedConversations: [...index.deletedConversations, { id, childRunIds: [...childRunIds], at: now }],
    });
  }

  /** Restore a conversation and the runs that were hidden with it. 恢复对话以及随它隐藏的 Run。 */
  async restoreConversation(id: string): Promise<void> {
    const index = await this.index();
    const entry = index.deletedConversations.find((item) => item.id === id);
    if (entry === undefined) return;
    const freed = new Set(entry.childRunIds);
    await this.write({
      deletedRunIds: index.deletedRunIds.filter((runId) => !freed.has(runId)),
      deletedConversations: index.deletedConversations.filter((item) => item.id !== id),
    });
  }

  async delete(runId: string): Promise<void> {
    const index = await this.index();
    if (index.deletedRunIds.includes(runId)) {
      return;
    }
    await this.write({ deletedRunIds: [...index.deletedRunIds, runId], deletedConversations: index.deletedConversations });
  }

  /** Bring a deleted session back to the conversation list. 把已删除的会话恢复到会话列表。 */
  async restore(runId: string): Promise<void> {
    const index = await this.index();
    if (!index.deletedRunIds.includes(runId)) return;
    await this.write({ deletedRunIds: index.deletedRunIds.filter((id) => id !== runId), deletedConversations: index.deletedConversations });
  }

  private async index(): Promise<SessionIndex> {
    try {
      const source = await readFile(this.#path, "utf8");
      const parsed = JSON.parse(source) as Partial<SessionIndex>;
      return {
        deletedRunIds: Array.isArray(parsed.deletedRunIds) ? parsed.deletedRunIds.filter((id): id is string => typeof id === "string") : [],
        deletedConversations: Array.isArray(parsed.deletedConversations)
          ? parsed.deletedConversations.flatMap((entry) => {
              if (typeof entry !== "object" || entry === null) return [];
              const value = entry as Partial<DeletedConversation>;
              if (typeof value.id !== "string" || typeof value.at !== "string") return [];
              const children = Array.isArray(value.childRunIds) ? value.childRunIds.filter((runId): runId is string => typeof runId === "string") : [];
              return [{ id: value.id, childRunIds: children, at: value.at }];
            })
          : [],
      };
    } catch (error: unknown) {
      if (isMissingFile(error)) {
        return { deletedRunIds: [], deletedConversations: [] };
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
