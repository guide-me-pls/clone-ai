import type { WorkerProfile } from "../config/worker-settings.ts";
import { workCapabilitiesForRole } from "../workers/capabilities.ts";
import type { TaskIntentKind, WorkerDescriptor } from "./dispatch-contracts.ts";

/**
 * Describes the workers the router may choose between.
 *
 * Installation state comes from the registry rather than from settings,
 * because "configured" and "actually runnable" are different facts and only
 * the second one can honour a request. A profile that names an uninstalled
 * command must reach the router as unavailable, not as a candidate.
 *
 * 描述路由器可以在其中选择的 Worker。
 *
 * 安装状态来自 Registry 而不是 Settings，因为"已配置"和"真的能跑"是两个不同的事实，
 * 只有后者才能满足一个请求。指向未安装命令的 Profile 必须以"不可用"的身份到达路由器，
 * 而不是作为候选。
 */

const ROLE_KINDS: Readonly<Record<WorkerProfile["role"], readonly TaskIntentKind[]>> = {
  direct: ["direct", "coding", "planning"],
  research: ["research"],
  draft: ["coding", "planning"],
  review: ["review"],
  external: ["operations"],
};

/** Only the two facts the router needs, so any source can supply them. 只包含路由器需要的两个事实，因此任何来源都能提供。 */
export interface WorkerAvailability {
  id: string;
  installed: boolean;
}

export function describeWorkers(
  profiles: readonly WorkerProfile[],
  installed: readonly WorkerAvailability[],
): WorkerDescriptor[] {
  // Availability may be keyed by provider (what is installed on the machine)
  // or by agent id (what an injected registry can actually run), so both are
  // accepted rather than forcing every caller into one shape.
  // 可用性可能以 Provider 为键（机器上装了什么），也可能以 Agent ID 为键（注入的 Registry
  // 实际能运行什么），因此两者都接受，而不是强迫所有调用方使用同一种形态。
  const available = new Map(installed.map((status) => [status.id, status.installed]));
  return profiles.map((profile, index) => {
    return {
      id: profile.id,
      providerId: profile.providerId,
      description: `${profile.title}. ${profile.description} ${profile.purpose}`.trim(),
      roles: ROLE_KINDS[profile.role],
      capabilities: workCapabilitiesForRole(profile.role),
      // Order in settings is the owner's own preference ordering.
      // Settings 中的顺序就是所有者自己的偏好顺序。
      priority: profiles.length - index,
      enabled: profile.enabled,
      // Unknown means not installed: the router must never dispatch to a
      // command nobody confirmed exists.
      // 未知即未安装：路由器绝不能派发到一个没人确认存在的命令。
      installed: available.get(profile.providerId) ?? available.get(profile.id) ?? false,
    };
  });
}
