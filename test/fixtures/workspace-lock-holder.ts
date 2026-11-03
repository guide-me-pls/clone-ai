import { writeFile } from "node:fs/promises";

import { workspaceExecutionLock } from "../../src/core/workspace-lock.ts";

const [workspace, marker] = process.argv.slice(2);
if (workspace === undefined || marker === undefined) throw new Error("Expected workspace and marker paths.");

await workspaceExecutionLock.run(workspace, async () => {
  await writeFile(marker, `${process.pid}\n`, "utf8");
  await new Promise((resolve) => setTimeout(resolve, 30_000));
});
