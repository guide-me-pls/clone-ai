/**
 * Relevant reviewed memories, pushed into the Main Agent's context instead of
 * waiting to be pulled.
 *
 * The planning and dispatch paths already recall memory for every worker; the
 * conversation path did not, so the owner could tell the twin something once,
 * approve it as a memory, and still be answered as if it had never been said
 * unless the model happened to call recall_memory. Pull-only memory is why the
 * conversation felt like a chat window with a search box.
 *
 * The push obeys the same boundary as dispatch: summaries only, bounded size,
 * secrets withheld, instruction-shaped text stripped, and a memory.recalled
 * event so the improvement loop can attribute outcomes to the memories that
 * were actually present.
 *
 * 把相关的已审核记忆推入 Main Agent 的上下文，而不是等它来拉。
 *
 * 规划与派发路径本就为每个 Worker 召回记忆；对话路径没有，于是所有者只说过一次、也审核
 * 通过了的记忆，在对话中仍可能像从未存在——除非模型恰好调用了 recall_memory。只拉不推，
 * 正是对话像"带搜索框的聊天窗口"的原因。
 *
 * 推送遵守与派发相同的边界：只给摘要、有长度上限、secret 不外露、剥掉指令化措辞，并写入
 * memory.recalled 事件，使改进环路能把结局归因到真正在场的那批记忆。
 */
import type { JournalStore } from "../core/journal.ts";
import { GovernedMemorySource } from "../memory/md-memory-store.ts";
import { buildMemoryContextFromCandidates } from "./memory-context-builder.ts";

/** Journal run id used for conversation turns that are not task runs. 非任务 Run 的对话回合使用的 Journal run id。 */
export const MAIN_AGENT_RUN_ID = "main-agent";

export interface MemoryPush {
  text: string;
  memoryIds: string[];
}

export async function pushRelevantMemories(input: {
  dataDirectory: string;
  query: string;
  journal: JournalStore;
  maxResults?: number;
}): Promise<MemoryPush | undefined> {
  const query = input.query.trim();
  if (query.length === 0) return undefined;
  const source = new GovernedMemorySource(input.dataDirectory, input.maxResults ?? 6);
  const recalled = await source.recall(query, MAIN_AGENT_RUN_ID);
  const context = buildMemoryContextFromCandidates(
    // Carry the metadata the builder uses: without `type` every memory fell
    // into the same class, so a preference and a task outcome competed for one
    // share; without `createdAt` the supersedes ordering could not tell which
    // statement came later.
    // 带上构建器会用到的元数据：没有 `type` 时所有记忆落入同一类别，偏好与任务结果争抢同一份
    // 额度；没有 `createdAt` 时"后者取代前者"的排序无法判断哪句更晚。
    recalled.map((item) => ({
      id: item.memory.id,
      summary: item.memory.summary,
      score: item.score,
      type: item.memory.type,
      status: item.memory.status,
      createdAt: item.memory.createdAt,
      sensitivity: item.memory.sensitivity,
    })),
  );
  if (context === undefined) return undefined;
  await input.journal.append({
    type: "memory.recalled",
    runId: MAIN_AGENT_RUN_ID,
    payload: {
      query,
      scope: { path: "main-agent-push" },
      memories: recalled
        .filter((item) => context.sourceMemoryIds.includes(item.memory.id))
        // The audit record carries the same classification the model saw, so a
        // later review can tell why a memory was injected.
        // 审计记录携带模型看到的同一分类，使事后审查能说明某条记忆为何被注入。
        .map((item) => ({
          id: item.memory.id,
          summary: item.memory.summary,
          score: item.score,
          matchedTerms: item.matchedTerms,
          type: item.memory.type,
          createdAt: item.memory.createdAt,
          sensitivity: item.memory.sensitivity,
        })),
    },
  });
  return { text: context.summary, memoryIds: [...context.sourceMemoryIds] };
}
