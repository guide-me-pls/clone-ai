/**
 * clone-main entry: the persistent Main Agent on the in-process native loop.
 *
 * The agent carries the conversation, proposes work plans, requests approval
 * status, recalls memory, and inspects runs - all through proposal-only tools
 * whose other end is the Kernel. It has no built-in file, shell, or write
 * tools. There is no SDK behind it: the loop, context assembly and tool surface
 * are ours, and every turn is recorded in the turn ledger.
 *
 * 常驻主 Agent 的入口，运行在进程内的原生循环上。
 *
 * 该 Agent 负责对话、提案工作计划、查询审批状态、召回记忆与查看 Run——全部经由
 * 提案型工具，工具的另一端是 Kernel。它没有任何内置文件/Shell/写入工具。它背后没有
 * SDK：循环、上下文组装与工具面都是我们自己的，每个回合都记入回合台账。
 *
 * Run: npm run main -- "<query>"
 */
import { defaultLegacyDirectory, migrateLegacyCloneHome, prepareCloneHome, resolveClonePaths } from "../config/clone-home.ts";
import { runNativeMainAgentTurn } from "./native-runtime.ts";

const query = process.argv.slice(2).join(" ").trim();
if (query.length === 0) {
  console.error('Usage: npm run main -- "<query>"');
  process.exit(1);
}

// The CLI resolves the owner's home exactly as the daemon does, so running a
// query from a terminal and from the desktop reach the same state.
// CLI 与 Daemon 用完全相同的方式解析所有者主目录，因此从终端和桌面发起的查询
// 到达同一份状态。
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