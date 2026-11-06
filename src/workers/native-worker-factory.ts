/**
 * Wires the native worker to a provider from configuration, or declines.
 *
 * Configuration is explicit: without CLONE_AI_NATIVE_MODEL the factory returns
 * undefined, and no provider is guessed. That keeps the default runtime on the
 * sandboxed CLI workers until the owner opts in.
 *
 * 依据配置接入原生 Worker 的 Provider，或明确拒绝。
 *
 * 配置是显式的：没有 CLONE_AI_NATIVE_MODEL 时工厂返回 undefined，不猜任何 Provider。
 * 因此在所有者显式开启之前，默认运行时仍使用沙箱化的 CLI Worker。
 */
import { join } from "node:path";

import { NativeAgentWorker, type NativeToolSpec } from "./native-agent-worker.ts";
import { OpenAiCompatibleClient } from "./openai-compatible-client.ts";
import { enabledServers, loadMcpConfigSync, McpClient, mcpToolSpecs, MCP_CONFIG_FILE } from "./mcp-client.ts";

export interface NativeWorkerEnvironment {
  /** Model id as the endpoint names it. 端点使用的模型 id。 */
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  /**
   * Model rounds one step may spend calling tools, when the owner sets it.
   * A repair needs enough rounds to read the failing code and then write a
   * patch; the client's built-in default is deliberately small.
   * 设置了该值时，一个步骤可花费的模型轮次。修复需要足够的轮次先读失败代码再写补丁；
   * 客户端内置默认值刻意很小。
   */
  maxRounds?: number;
  /** Cap one completion's tokens, when the owner sets it. 设置了该值时，限制单次补全的 token。 */
  maxTokens?: number;
  workspace: string;
}

export function readNativeWorkerEnvironment(environment: NodeJS.ProcessEnv = process.env, workspace = process.cwd()): NativeWorkerEnvironment {
  const rounds = environment.CLONE_AI_NATIVE_MAX_ROUNDS?.trim();
  const maxRounds = rounds === undefined || rounds.length === 0 ? undefined : Number(rounds);
  const tokens = environment.CLONE_AI_NATIVE_MAX_TOKENS?.trim();
  const maxTokens = tokens === undefined || tokens.length === 0 ? undefined : Number(tokens);
  return {
    workspace,
    ...(environment.CLONE_AI_NATIVE_MODEL?.trim() ? { model: environment.CLONE_AI_NATIVE_MODEL.trim() } : {}),
    ...(environment.CLONE_AI_NATIVE_BASE_URL?.trim() ? { baseUrl: environment.CLONE_AI_NATIVE_BASE_URL.trim() } : {}),
    ...(environment.CLONE_AI_NATIVE_API_KEY?.trim() ? { apiKey: environment.CLONE_AI_NATIVE_API_KEY.trim() } : {}),
    // A malformed value is ignored rather than turned into NaN, which would
    // make the loop run zero rounds and look like a model that said nothing.
    // 非法值直接忽略而不是变成 NaN：那会让循环跑零轮，看起来像模型什么都没说。
    ...(maxRounds !== undefined && Number.isInteger(maxRounds) && maxRounds > 0 ? { maxRounds } : {}),
    ...(maxTokens !== undefined && Number.isInteger(maxTokens) && maxTokens > 0 ? { maxTokens } : {}),
  };
}

/**
 * Filesystem tools with their scope risk, rooted at the step's workspace. All
 * path checks happen in NativeAgentWorker; these functions assume the path was
 * already allowed.
 * 以步骤工作区为根、带 Scope 风险等级的文件工具。路径检查全部在 NativeAgentWorker 中完成；
 * 这些函数假定路径已被允许。
 */
export function fileTools(): NativeToolSpec[] {
  const resolveInWorkspace = (workspace: string, path: string): string => join(workspace, path);
  return [
    {
      name: "read_file",
      description: "Read a UTF-8 text file inside the step workspace.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      risk: "read",
      pathOf: (input) => String(input.path ?? ""),
      run: async (call, { workspace }) => {
        const text = await (await import("node:fs/promises")).readFile(resolveInWorkspace(workspace, String(call.input.path)), "utf8")
          .catch((error: Error) => `Error: ${error.message}`);
        return { output: text, ...(text.startsWith("Error:") ? { isError: true } : {}) };
      },
    },
    {
      name: "list_directory",
      description: "List entries of a directory inside the step workspace.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      risk: "read",
      pathOf: (input) => String(input.path ?? "."),
      run: async (call, { workspace }) => {
        // A missing directory is an answer ("this folder is empty"), not a failure
        // that aborts the model's whole turn.
        // 目录不存在是一个答案（"这个文件夹是空的"），而不是让模型整轮中断的失败。
        const entries = await (await import("node:fs/promises")).readdir(resolveInWorkspace(workspace, String(call.input.path ?? ".")), { withFileTypes: true })
          .catch(() => []);
        return { output: entries.length === 0 ? "(empty)" : entries.map((entry) => `${entry.isDirectory() ? "dir " : "file"} ${entry.name}`).join("\n") };
      },
    },
    {
      name: "write_file",
      description: "Write a UTF-8 text file inside the step workspace, creating directories as needed.",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
      risk: "write",
      pathOf: (input) => String(input.path ?? ""),
      run: async (call, { workspace }) => {
        const { mkdir, writeFile } = await import("node:fs/promises");
        const { dirname } = await import("node:path");
        const target = resolveInWorkspace(workspace, String(call.input.path));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, String(call.input.content ?? ""), "utf8");
        return { output: `Wrote ${String(call.input.path)}.` };
      },
    },
    {
      name: "edit_file",
      description: "Replace one exact occurrence of old_text with new_text in a UTF-8 file inside the step workspace. Prefer this over write_file for a small change to an existing file.",
      parameters: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] },
      risk: "write",
      pathOf: (input) => String(input.path ?? ""),
      run: async (call, { workspace }) => {
        const { readFile, writeFile } = await import("node:fs/promises");
        const target = resolveInWorkspace(workspace, String(call.input.path));
        const oldText = String(call.input.old_text ?? "");
        const newText = String(call.input.new_text ?? "");
        if (oldText.length === 0) return { output: "Error: old_text must not be empty.", isError: true };
        let source: string;
        try {
          source = await readFile(target, "utf8");
        } catch (error: unknown) {
          return { output: `Error: ${(error as Error).message}`, isError: true };
        }
        const first = source.indexOf(oldText);
        if (first < 0) {
          return { output: "Error: old_text is not present in the file; read it and retry with an exact excerpt.", isError: true };
        }
        if (source.indexOf(oldText, first + 1) >= 0) {
          return { output: "Error: old_text occurs more than once; include more surrounding text.", isError: true };
        }
        const next = source.slice(0, first) + newText + source.slice(first + oldText.length);
        // A one-line fix must not replace the file with a fragment. The guard is
        // deliberately blunt: an edit that removes most of the file is a
        // rewrite mistake, not an edit.
        // 只改一行的修复不得把文件替换成片段。这个保护刻意粗暴：删掉文件大部分内容的"编辑"是
        // 重写失误，不是编辑。
        if (next.length * 10 < source.length) {
          return {
            output: `Error: the edit would shrink the file from ${source.length} to ${next.length} characters; that looks like a fragment, not an edit.`,
            isError: true,
          };
        }
        await writeFile(target, next, "utf8");
        return { output: `Edited ${String(call.input.path)} (${oldText.length} -> ${newText.length} characters).` };
      },
    },
  ];
}

/**
 * Built-in tools plus the MCP tools the owner enabled.
 *
 * MCP is opt-in twice: a server must be `enabled` in `mcp.json`, and each tool
 * it exposes must be declared there with a risk. A server whose config is
 * malformed is reported and skipped; it never fails a worker that only needs
 * its built-in tools.
 * 内建工具，加上所有者已开启的 MCP 工具。
 *
 * MCP 需要两级开启：服务器必须在 `mcp.json` 中 `enabled`，且它暴露的每个工具都必须在其中声明
 * 风险。配置损坏的服务器会被报告并跳过；它绝不会让只需要内建工具的 Worker 失败。
 */
export function workerTools(options: {
  dataDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
} = {}): NativeToolSpec[] {
  const builtIn = fileTools();
  if (options.dataDirectory === undefined) return builtIn;
  const loaded = loadMcpConfigSync(join(options.dataDirectory, MCP_CONFIG_FILE));
  for (const error of loaded.errors) options.log?.(`[mcp] ${error}`);
  const servers = enabledServers(loaded);
  if (servers.length === 0) return builtIn;
  const client = new McpClient({ servers, ...(options.environment === undefined ? {} : { environment: options.environment }) });
  const mcp = servers.flatMap((server) => mcpToolSpecs(server, client));
  if (mcp.length === 0) return builtIn;
  // The client owns the child processes. Hanging its close on the specs means the
  // worker releases them when the step ends, without telling the model that a
  // "close the servers" tool exists — that would only be an invitation to
  // shut its own tools off mid-step.
  // 客户端持有子进程。把它的关闭挂在 spec 上，Worker 就在步骤结束时释放它们，而无需告诉模型存在
  // 一个"关闭服务器"的工具——那只会诱使它在步骤中途关掉自己的工具。
  const close = (): Promise<void> => client.close();
  return [...builtIn, ...mcp.map((spec) => ({ ...spec, close }))];
}

/** A native worker when configured, otherwise undefined. 已配置时返回原生 Worker，否则 undefined。 */
export function createConfiguredNativeWorker(
  environment: NodeJS.ProcessEnv = process.env,
  workspace = process.cwd(),
  options: {
    id?: string;
    label?: string;
    workCapabilities?: readonly string[];
    /** Clone home; its mcp.json supplies the enabled MCP servers. Clone home；其 mcp.json 提供已开启的 MCP 服务器。 */
    dataDirectory?: string;
    /** Pre-resolved tool list; when given, MCP is not loaded here. 已解析的工具表；给出时不再在此加载 MCP。 */
    tools?: readonly NativeToolSpec[];
  } = {},
): NativeAgentWorker | undefined {
  const config = readNativeWorkerEnvironment(environment, workspace);
  if (config.model === undefined || config.baseUrl === undefined) return undefined;
  return new NativeAgentWorker({
    id: options.id ?? "native",
    label: options.label ?? "Native worker (OpenAI-compatible)",
    providerId: "native",
    ...(options.workCapabilities === undefined ? {} : { workCapabilities: options.workCapabilities }),
    tools: options.tools ?? fileTools(),
    createClient: () => new OpenAiCompatibleClient({
      baseUrl: config.baseUrl!,
      model: config.model!,
      ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
      ...(config.maxRounds === undefined ? {} : { maxRounds: config.maxRounds }),
      ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
      timeoutMs: Number(environment.CLONE_AI_NATIVE_TIMEOUT_MS ?? 120_000),
    }),
  });
}
