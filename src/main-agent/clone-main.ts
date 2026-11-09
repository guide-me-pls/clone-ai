/**
 * CLI entry for Clone AI's built-in Main Agent.
 *
 * There is no Pi SDK, external Agent process, or provider-selected reasoning
 * loop here: the same native runtime used by the desktop owns the turn.
 *
 * Clone AI 内置 Main Agent 的 CLI 入口。
 *
 * 这里没有 Pi SDK、外部 Agent 进程或按 Provider 选择的推理循环：桌面端使用的同一个
 * 原生运行时拥有本回合。
 */
import { defaultLegacyDirectory, migrateLegacyCloneHome, prepareCloneHome, resolveClonePaths } from "../config/clone-home.ts";
import { runNativeMainAgentTurn } from "./native-runtime.ts";

const query = process.argv.slice(2).join(" ").trim();
if (query.length === 0) {
  console.error('Usage: npm run main -- "<query>"');
  process.exit(1);
}

const paths = resolveClonePaths();
await prepareCloneHome(paths);
await migrateLegacyCloneHome({
  legacyDirectory: defaultLegacyDirectory(paths.workspacePath),
  targetDirectory: paths.dataDirectory,
});

const result = await runNativeMainAgentTurn({
  dataDirectory: paths.dataDirectory,
  text: query,
  source: "main-cli",
  onDelta: (delta) => process.stdout.write(delta),
});
process.stdout.write("\n");
if (result.error !== undefined) {
  console.error(result.error);
  process.exit(1);
}
