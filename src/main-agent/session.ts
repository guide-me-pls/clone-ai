/**
 * Shared factory for the clone-main session. The CLI entry and the live
 * acceptance test build the exact same governed session, so what the test
 * proves is what the entry runs.
 * clone-main 会话的共享工厂。CLI 入口与真实验收测试构建完全相同的受治理会话，
 * 测试证明的就是入口运行的。
 */
import { join } from "node:path";

import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";

import { createKernelToolsExtension } from "./tools/kernel-tools.ts";
import { compileMainAgentPrompt, MAIN_AGENT_CHARTER, MAIN_AGENT_CHARTER_VERSION } from "./prompt.ts";
import type { MainAgentPromptMaterials, RegisteredToolSnapshot } from "./prompt-snapshot.ts";
import { logJson } from "../observability/json-log.ts";
import { CloneConfigStore } from "../config/clone-config.ts";
import { isEffortLevel, type EffortLevel } from "../workers/effort.ts";
import { resolveClonePaths } from "../config/clone-home.ts";

export interface MainAgentSessionOptions {
  dataDirectory: string;
  cwd?: string;
  /** Defaults to a persistent session under <dataDirectory>/pi-sessions/main-agent. 默认持久化于 <dataDirectory>/pi-sessions/main-agent。 */
  sessionManager?: SessionManager;
  /**
   * The owner's message. When given, reviewed memories matching it are pushed
   * into the system prompt for this turn (see memory-push.ts).
   * 所有者的消息。给出时，与它匹配的已审核记忆会被推入本回合的 System Prompt（见 memory-push.ts）。
   */
  query?: string;
}

export { MAIN_AGENT_CHARTER, MAIN_AGENT_CHARTER_VERSION };

export async function createMainAgentSession(options: MainAgentSessionOptions): Promise<{
  session: AgentSession;
  /** What this session was told, for per-turn provenance. 本会话收到的输入，用于逐轮溯源。 */
  prompt: MainAgentPromptMaterials;
}> {
  const cwd = options.cwd ?? process.cwd();
  const compiledPrompt = await compileMainAgentPrompt({
    dataDirectory: options.dataDirectory,
    cwd,
    ...(options.query === undefined ? {} : { query: options.query }),
  });
  const briefingText = compiledPrompt.systemPrompt;
  const { briefing, briefingError } = compiledPrompt;

  const registeredTools: RegisteredToolSnapshot[] = [];
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    // Discovery is an ungoverned injection channel. The Main Agent loads only
    // what is explicitly passed here — the same discipline as the RPC adapter's
    // --no-extensions/--no-skills/--no-context-files flags.
    // 自动发现是不受治理的注入通道。Main Agent 只加载这里显式传入的东西——与 RPC Adapter 的
    // --no-extensions/--no-skills/--no-context-files 同一纪律。
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    extensionFactories: [(pi) => createKernelToolsExtension(pi, {
      dataDirectory: options.dataDirectory,
      onRegister: (tool) => registeredTools.push(tool),
    })],
    systemPromptOverride: () => briefingText,
  });
  await resourceLoader.reload();

  const configured = await resolveMainAgentModel(options.dataDirectory);
  const effort = await readMainAgentEffortPreference(options.dataDirectory);
  const { session } = await createAgentSession({
    resourceLoader,
    // noTools: "builtin" disables built-in tools while keeping extension tools active.
    //          （tools: [] 会把扩展工具也过滤掉；noTools: "builtin" 只禁用内置工具。）
    noTools: "builtin",
    ...(configured === undefined ? {} : { model: configured.model, modelRuntime: configured.modelRuntime }),
    // The session identity is the owner's clone home, not the current folder.
    // Pi filters recent sessions by cwd when a custom session directory is
    // given, so passing the real cwd would start a blank conversation every
    // time the owner runs clone-ai from a different directory.
    // 会话身份是所有者的 clone home，而不是当前目录。传入自定义会话目录时 Pi 会按 cwd
    // 过滤最近会话；若传真实 cwd，所有者每换一个目录跑 clone-ai 就会开一个空白对话。
    sessionManager: options.sessionManager ?? await continueOwnerConversation(options.dataDirectory),
  });
  // Effort is a per-run choice, applied after construction because the SDK fixes
  // it on the session rather than at creation. An unknown level is refused by the
  // config store, so this cast only narrows the union.
  // 强度是每次运行的选择，在构造后设置，因为 SDK 把它固定在会话上而不是创建参数里。
  // 未知档位会在配置层被拒，因此这里只是收窄联合类型。
  if (effort !== undefined) session.setThinkingLevel(effort as Parameters<typeof session.setThinkingLevel>[0]);
  if (registeredTools.length === 0) {
    // Zero tools would make the provenance hash cover an empty table while the
    // model may still have callable tools; say so rather than pretend.
    // 零工具会让溯源哈希覆盖一张空表，而模型可能仍有可调用的工具；如实说明而不是假装。
    logJson("warn", "main_agent.prompt_snapshot has no registered tools", {
      dataDirectory: options.dataDirectory,
    });
  }
  const prompt: MainAgentPromptMaterials = {
    charter: MAIN_AGENT_CHARTER,
    charterVersion: MAIN_AGENT_CHARTER_VERSION,
    ...(briefing === undefined ? {} : { briefing }),
    ...(briefingError === undefined ? {} : { briefingError }),
    systemPrompt: briefingText,
    tools: registeredTools,
    ...(session.model?.id === undefined ? {} : { modelId: session.model.id }),
    ...(session.model?.provider === undefined ? {} : { provider: session.model.provider }),
    ...(effort === undefined ? {} : { effort }),
  };
  return { session, prompt };
}

/**
 * Env wins for one-off runs; otherwise `config.json` `mainAgentModel`.
 * Unset means the Pi SDK default — we do not invent a model id.
 * 一次性运行以环境变量为准；否则用 `config.json` 的 `mainAgentModel`。
 * 未设置则交给 Pi SDK 默认——我们不编造模型 id。
 */
export async function readMainAgentEffortPreference(
  dataDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<EffortLevel | undefined> {
  const fromEnv = environment.CLONE_AI_MAIN_EFFORT?.trim();
  if (isEffortLevel(fromEnv)) return fromEnv;
  const paths = resolveClonePaths({ dataDirectory });
  const config = await new CloneConfigStore(paths).get();
  return config.mainAgentEffort;
}

export async function readMainAgentModelPreference(
  dataDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const fromEnv = environment.CLONE_AI_MAIN_MODEL?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const paths = resolveClonePaths({ dataDirectory });
  const config = await new CloneConfigStore(paths).get();
  return config.mainAgentModel;
}

async function resolveMainAgentModel(dataDirectory: string): Promise<{
  model: ReturnType<ModelRuntime["getModels"]>[number];
  modelRuntime: ModelRuntime;
} | undefined> {
  const reference = await readMainAgentModelPreference(dataDirectory);
  if (reference === undefined) return undefined;
  const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
  const model = findConfiguredModel(reference, modelRuntime.getModels());
  if (model === undefined) {
    throw new Error(
      `Main Agent model "${reference}" is not in the Pi catalog. Set config.json mainAgentModel (or CLONE_AI_MAIN_MODEL) to a known provider/model id, for example anthropic/claude-sonnet-4-5.`,
    );
  }
  return { model, modelRuntime };
}

function findConfiguredModel<T extends { id: string; provider: string }>(
  reference: string,
  models: readonly T[],
): T | undefined {
  const matches = models.filter((model) => model.id === reference || `${model.provider}/${model.id}` === reference);
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Continues the owner's most recent conversation regardless of the directory
 * clone-ai was started from.
 *
 * Pi filters recent sessions by cwd whenever a custom session directory is
 * given, which is right for a per-project coding agent and wrong for a
 * personal twin: the owner's conversation is one thread, not one per folder.
 * So the newest session file is selected here and handed to the manager.
 *
 * 无论从哪个目录启动 clone-ai，都继续所有者最近的那次对话。
 *
 * 只要传入自定义会话目录，Pi 就会按 cwd 过滤最近会话——这对按项目分会话的编码 Agent
 * 是对的，对个人分身则是错的：所有者的对话是一条线索，而不是每个目录一条。因此这里自己
 * 选出最新的会话文件并交给 Manager。
 */
export async function continueOwnerConversation(dataDirectory: string): Promise<SessionManager> {
  const directory = join(dataDirectory, "pi-sessions", "main-agent");
  // Look before constructing: the manager creates its own file eagerly, which
  // would otherwise become "the newest session" and hide the real history.
  // 先看再构造：Manager 会立刻创建自己的文件，否则那个文件会变成"最新会话"并盖住真正的历史。
  const selected = await readCurrentSessionPointer(directory);
  const target = selected ?? await findLatestSessionFile(directory);
  const manager = SessionManager.continueRecent(dataDirectory, directory);
  if (target !== undefined && manager.getSessionFile() !== target) {
    manager.setSessionFile(target);
  }
  // Every entry point writes the pointer back, so the CLI and the GUI always
  // land in the same conversation no matter which one the owner used last.
  // 每个入口都会写回指针，因此无论所有者上次用的是 CLI 还是 GUI，两端都落在同一段对话上。
  const active = manager.getSessionFile();
  if (active !== undefined) await writeCurrentSessionPointer(directory, active);
  return manager;
}

const POINTER_FILE = "current-session.json";

/** The conversation both the CLI and the GUI continue. CLI 与 GUI 共同续跑的那段对话。 */
export async function readCurrentSessionPointer(directory: string): Promise<string | undefined> {
  const { readFile, stat } = await import("node:fs/promises");
  try {
    const parsed = JSON.parse(await readFile(join(directory, POINTER_FILE), "utf8")) as { sessionFile?: unknown };
    if (typeof parsed.sessionFile !== "string") return undefined;
    // A pointer to a file that never materialised (a new conversation with no
    // assistant turn yet) must not hide the real history.
    // 指向从未落盘的文件（尚无 assistant 回合的新对话）不能盖住真实历史。
    await stat(parsed.sessionFile);
    return parsed.sessionFile;
  } catch {
    return undefined;
  }
}

export async function writeCurrentSessionPointer(directory: string, sessionFile: string): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, POINTER_FILE), `${JSON.stringify({ sessionFile })}\n`, "utf8");
}

/** Conversations on disk, newest first. 磁盘上的对话，新的在前。 */
export async function listOwnerConversations(dataDirectory: string): Promise<Array<{ path: string; mtimeMs: number; messages: number; preview: string }>> {
  const directory = join(dataDirectory, "pi-sessions", "main-agent");
  const { readdir, stat, readFile } = await import("node:fs/promises");
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const rows = await Promise.all(names.map(async (name) => {
    const path = join(directory, name);
    const info = await stat(path);
    const source = await readFile(path, "utf8").catch(() => "");
    const lines = source.split("\n").filter((line) => line.trim().length > 0);
    const messages = lines.filter((line) => line.includes('"type":"message"')).length;
    let preview = "";
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
        if (parsed.type !== "message" || parsed.message?.role !== "user") continue;
        const content = parsed.message.content;
        preview = typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.map((part) => (typeof part === "object" && part !== null && "text" in part ? String((part as { text: unknown }).text) : "")).join(" ")
            : "";
        if (preview.trim().length > 0) break;
      } catch {
        continue;
      }
    }
    return { path, mtimeMs: info.mtimeMs, messages, preview: preview.replace(/\s+/g, " ").slice(0, 60) };
  }));
  return rows.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

async function findLatestSessionFile(directory: string): Promise<string | undefined> {
  const { readdir, stat } = await import("node:fs/promises");
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return undefined;
  }
  let latest: { path: string; mtimeMs: number } | undefined;
  for (const name of names) {
    const path = join(directory, name);
    const info = await stat(path).catch(() => undefined);
    if (info === undefined) continue;
    if (latest === undefined || info.mtimeMs > latest.mtimeMs) latest = { path, mtimeMs: info.mtimeMs };
  }
  return latest?.path;
}
