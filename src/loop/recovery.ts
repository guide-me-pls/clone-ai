import type { LoopCheckpointStore, LoopJournal, LoopRunState } from "./contracts.ts";
import { projectLoopRun } from "./run-state.ts";

/**
 * Recovery starts from the newest materialized checkpoint, then replays only
 * later journal events. This restores the state machine; restarting a model
 * provider session is intentionally a separate next step.
 *
 * 恢复从最新的物化 Checkpoint 开始，只重放之后的 Journal Event。这能恢复状态机；重新启动
 * Model Provider Session 则有意作为独立的下一步。
 */
export async function restoreLoopRun(input: {
  runId: string;
  journal: LoopJournal;
  checkpoints: LoopCheckpointStore;
}): Promise<LoopRunState> {
  const checkpoint = await input.checkpoints.load(input.runId);
  const laterEvents = (await input.journal.list(input.runId)).filter(
    (event) => event.sequence > (checkpoint?.lastAppliedSequence ?? 0),
  );
  return projectLoopRun(laterEvents, checkpoint);
}
