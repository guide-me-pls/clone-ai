/**
 * Merge helpers shared by the MCP integration installers.
 *
 * Each installer writes one server into an owner-written `mcp.json` (and, where
 * it needs a standing policy, one policy into `policies.json`). The merge is
 * deliberately idempotent by id: re-running an installer must update its own
 * entry without dropping another integration or duplicating its policy.
 *
 * 各 MCP 集成安装器共用的合并函数。
 *
 * 每个安装器向所有者撰写的 `mcp.json` 写入一个服务器（需要常设策略时，再向 `policies.json`
 * 写入一条策略）。合并按 id 幂等：重跑安装器只更新自己的条目，不会丢掉其他集成，也不会
 * 重复写入自己的策略。
 */
import type { AuthorityConfig, StandingPolicy } from "../authority/standing-policy-store.ts";
import type { McpServerConfig } from "../workers/mcp-client.ts";

/** Merge a server into an mcp.json document without dropping other servers. 合并服务器，不丢其他服务器。 */
export function mergeMcpConfig(existing: unknown, server: McpServerConfig): { servers: McpServerConfig[] } {
  const source = existing && typeof existing === "object" && !Array.isArray(existing)
    ? (existing as { servers?: unknown })
    : {};
  const list = Array.isArray(source.servers)
    ? source.servers.filter((entry): entry is McpServerConfig => typeof entry === "object" && entry !== null && typeof (entry as { id?: unknown }).id === "string")
    : [];
  const next = list.filter((entry) => entry.id !== server.id);
  next.push(server);
  return { servers: next };
}

/** Merge the local policy into an authority document; idempotent by policy id. 合并策略；按 id 幂等。 */
export function mergeAuthority(existing: unknown, policy: StandingPolicy): AuthorityConfig {
  const source = existing && typeof existing === "object" && !Array.isArray(existing)
    ? (existing as Partial<AuthorityConfig>)
    : {};
  const policies = Array.isArray(source.policies)
    ? source.policies.filter((entry): entry is StandingPolicy => typeof entry === "object" && entry !== null && typeof (entry as { id?: unknown }).id === "string")
    : [];
  const kept = policies.filter((entry) => entry.id !== policy.id);
  kept.push(policy);
  return {
    version: 1,
    domains: { ...(source.domains ?? {}) },
    policies: kept,
  };
}
