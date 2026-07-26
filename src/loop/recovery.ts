import type { LoopCheckpointStore, LoopJournal, LoopRunState } from "./contracts.ts";
import { projectLoopRun } from "./run-state.ts";

/**
 * Recovery starts from the newest materialized checkpoint, then replays only
 * later journal events. This restores the state machine; restarting a model
 * provider session is intentionally a separate next step.
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
