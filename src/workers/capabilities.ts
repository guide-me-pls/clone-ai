import type { AgentRole } from "../config/worker-settings.ts";

/**
 * Domain capabilities are the routing vocabulary shared by the planner and the
 * dispatcher. They describe what work an executor may accept, not which OS or
 * network tools it receives.
 *
 * 领域能力是 Planner 与 Dispatcher 共用的路由词汇。它描述执行器可以接受
 * 什么工作，而不是它拥有了哪些操作系统或网络工具。
 */
export function workCapabilitiesForRole(role: AgentRole): string[] {
  if (role === "research") return ["research", "filesystem_read"];
  if (role === "draft") return ["drafting", "filesystem_read", "filesystem_write"];
  if (role === "review") return ["review"];
  if (role === "external") return ["external_action"];
  return ["direct_response"];
}
