import { join } from "node:path";

import { approveDemoWorkflow, startDemoWorkflow } from "./demo-workflow.ts";

const dataDirectory = process.env.CLONE_AI_DATA_DIR ?? join(process.cwd(), ".clone-ai");
const firstAttempt = await startDemoWorkflow(
  dataDirectory,
  "Prepare a weekly launch plan and draft the customer follow-up.",
);
console.log(`First attempt: ${firstAttempt.status}`);
console.log(`Child agents completed before approval: ${firstAttempt.subagentsCompleted}`);

if (firstAttempt.status === "waiting_approval") {
  const secondAttempt = await approveDemoWorkflow(dataDirectory, firstAttempt.runId);
  console.log(`Second attempt: ${secondAttempt.status}`);
  console.log(`Child agents retained after resume: ${secondAttempt.subagentsCompleted}`);
  console.log(`Memory candidates proposed asynchronously: ${secondAttempt.memoryCandidatesProposed}`);
}

console.log(`Journal: ${join(dataDirectory, "journal.jsonl")}`);
