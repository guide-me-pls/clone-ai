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

export interface NativeWorkerEnvironment {
  /** Model id as the endpoint names it. 端点使用的模型 id。 */
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  workspace: string;
}

export function readNativeWorkerEnvironment(environment: NodeJS.ProcessEnv = process.env, workspace = process.cwd()): NativeWorkerEnvironment {
  return {
    workspace,
    ...(environment.CLONE_AI_NATIVE_MODEL?.trim() ? { model: environment.CLONE_AI_NATIVE_MODEL.trim() } : {}),
    ...(environment.CLONE_AI_NATIVE_BASE_URL?.trim() ? { baseUrl: environment.CLONE_AI_NATIVE_BASE_URL.trim() } : {}),
    ...(environment.CLONE_AI_NATIVE_API_KEY?.trim() ? { apiKey: environment.CLONE_AI_NATIVE_API_KEY.trim() } : {}),
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
  ];
}

/** A native worker when configured, otherwise undefined. 已配置时返回原生 Worker，否则 undefined。 */
export function createConfiguredNativeWorker(
  environment: NodeJS.ProcessEnv = process.env,
  workspace = process.cwd(),
  options: { id?: string; label?: string; workCapabilities?: readonly string[] } = {},
): NativeAgentWorker | undefined {
  const config = readNativeWorkerEnvironment(environment, workspace);
  if (config.model === undefined || config.baseUrl === undefined) return undefined;
  return new NativeAgentWorker({
    id: options.id ?? "native",
    label: options.label ?? "Native worker (OpenAI-compatible)",
    providerId: "native",
    ...(options.workCapabilities === undefined ? {} : { workCapabilities: options.workCapabilities }),
    tools: fileTools(),
    createClient: () => new OpenAiCompatibleClient({
      baseUrl: config.baseUrl!,
      model: config.model!,
      ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
      timeoutMs: Number(environment.CLONE_AI_NATIVE_TIMEOUT_MS ?? 120_000),
    }),
  });
}
