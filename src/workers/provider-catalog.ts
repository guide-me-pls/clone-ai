/**
 * The only execution provider: the in-process native worker.
 *
 * Black-box CLI recipes are gone. A sub-agent behind a CLI cannot show the
 * Kernel its tool calls, its credentials or its real boundaries, so the
 * harness no longer offers one. Adding another provider means writing a
 * `ProviderDefinition` that keeps the same guarantees (per-call visibility,
 * Kernel-gated execution), not adding a command line.
 *
 * 唯一的执行 Provider：进程内的原生 Worker。
 *
 * 黑盒 CLI 配方已移除。藏在 CLI 后面的子 Agent 无法向 Kernel 展示它的工具调用、
 * 凭据或真实边界，因此 harness 不再提供这种路径。新增 Provider 意味着编写一份保持
 * 同等保证（逐次可见、由 Kernel 放行）的 `ProviderDefinition`，而不是增加一条命令行。
 */
import { createConfiguredNativeWorker } from "./native-worker-factory.ts";
import { ProviderRegistry, type ProviderDefinition } from "./provider-registry.ts";

export function nativeProviderDefinition(): ProviderDefinition {
  return {
    id: "native",
    label: "Native worker (OpenAI-compatible)",
    supportedRoles: ["direct", "research", "draft", "review"],
    roleRestrictionReason: "The native worker cannot perform external side effects; use a governed action connector.",
    createAdapter: ({ agentId, workCapabilities, workspacePath }) => {
      const worker = createConfiguredNativeWorker(process.env, workspacePath ?? process.cwd(), { id: agentId, workCapabilities });
      if (worker === undefined) {
        throw new Error("The native worker needs CLONE_AI_NATIVE_MODEL and CLONE_AI_NATIVE_BASE_URL.");
      }
      return worker;
    },
  };
}

export function createBuiltInProviderRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register(nativeProviderDefinition());
  return registry;
}

/**
 * Kept as the single entry point so callers do not depend on the shape of the
 * catalog. There are no user-declared CLI providers any more; the argument is
 * ignored deliberately.
 * 保留为唯一入口，使调用方不依赖目录的形状。已不存在用户声明的 CLI Provider；
 * 参数被刻意忽略。
 */
export async function loadProviderRegistry(_dataDirectory?: string): Promise<ProviderRegistry> {
  return createBuiltInProviderRegistry();
}

export const builtInProviders = createBuiltInProviderRegistry();