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
  // A general worker accepts every local kind of work. What it may actually do
  // in one step is still decided by that step's risk, scopes and the tool gate;
  // this list is the routing vocabulary, not a permission.
  // 通用 Worker 接受所有本地工作。它在某一步实际能做什么，仍由该步骤的风险、Scope 与
  // 工具闸门决定；这份清单是路由词汇，不是权限。
  if (role === "general") {
    return ["direct_response", "research", "review", "drafting", "filesystem_read", "filesystem_write"];
  }
  if (role === "research") return ["research", "filesystem_read"];
  if (role === "draft") return ["drafting", "filesystem_read", "filesystem_write"];
  if (role === "review") return ["review"];
  if (role === "external") return ["external_action"];
  return ["direct_response"];
}
