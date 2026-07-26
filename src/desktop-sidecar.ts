import { join } from "node:path";

import { startCompanionServer } from "./companion-server.ts";

const pkgProcess = process as NodeJS.Process & { pkg?: unknown };
async function main(): Promise<void> {
  const clientPath = pkgProcess.pkg === undefined
    ? join(process.cwd(), "apps", "desktop", "ui", "index.html")
    : join(__dirname, "..", "ui", "index.html");
  const companion = await startCompanionServer({ port: 0, clientPath });

  // The Tauri shell consumes this one machine-readable line before creating its window.
  console.log(`CLONE_AI_READY ${companion.url}`);

  const shutdown = async () => {
    await companion.close();
    process.exit(0);
  };

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
