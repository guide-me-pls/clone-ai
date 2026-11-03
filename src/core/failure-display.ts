/**
 * Convert raw worker failures into a short owner-facing diagnosis. The raw
 * text stays in the execution trace; the headline should say what happened
 * and what the owner can do next.
 *
 * 把原始 Worker 失败转换成面向所有者的简短诊断。原始文本仍保留在执行轨迹中；
 * 标题应说明发生了什么，以及下一步能做什么。
 */
export interface OwnerFailureDisplay {
  summary: string;
  guidance: string;
  /** Whether this failure is known to be caused by worker permissions. 是否属于已知的 Worker 权限问题。 */
  permissionBlocked: boolean;
}

export interface FailureDisplayContext {
  category?: string;
  providerId?: string;
}

export function describeFailureForOwner(
  reason: string | undefined,
  context: FailureDisplayContext = {},
): OwnerFailureDisplay {
  const text = reason?.trim() ?? "";
  const provider = context.providerId ?? "";
  const permissionBlocked = context.category === "permission_denied"
    || /Unrestricted host execution|no enforced sandbox|permission_denied|worker-boundary-refused/i.test(text);

  if (permissionBlocked) {
    return {
      summary: "本机 Worker 没有强制沙箱，默认禁止不受限运行。",
      guidance: "打开「设置 → Agent」，为这个 Worker 明确允许不受限运行；也可以把该角色改绑到其他已允许的 Worker。",
      permissionBlocked: true,
    };
  }
  if (/External actions require a separately governed action connector/i.test(text)) {
    return {
      summary: "黑盒 Worker 不能执行外部动作。",
      guidance: "请改用受治理的外部执行 Connector，或到「设置 → Agent」调整这个步骤的执行角色。",
      permissionBlocked: false,
    };
  }
  if (/missing capabilities|no executor|No adapter is registered/i.test(text)) {
    return {
      summary: "绑定的 Worker 缺少完成这一步所需的能力。",
      guidance: "打开「设置 → Agent」，更换一个具备该能力且已安装的 Worker。",
      permissionBlocked: false,
    };
  }
  if (/missing_credential|credential|unauthori[sz]ed|authentication|401|403/i.test(text)) {
    return {
      summary: "Worker 认证失败或缺少可用凭据。",
      guidance: "检查该 Provider 的登录状态与环境变量配置，然后重新发送任务。",
      permissionBlocked: false,
    };
  }
  if (/network|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|timed? out|timeout/i.test(text)) {
    return {
      summary: "Worker 无法连接网络，或请求超时。",
      guidance: "检查本地网关和网络连接，确认 Provider 可用后重新发送。",
      permissionBlocked: false,
    };
  }
  if (/attempt budget|retry budget|exceeded/i.test(text)) {
    return {
      summary: "这个任务已经用完当前的重试预算。",
      guidance: "查看执行轨迹，修正失败条件后再重新发送。",
      permissionBlocked: false,
    };
  }
  if (/local runtime stopped|runtime stopped|connection .*interrupted|连接在回复完成前中断/i.test(text)) {
    return {
      summary: "本地运行时在回复完成前中断了这次对话。",
      guidance: "确认应用仍在运行后重新发送；这次中断已经记录。",
      permissionBlocked: false,
    };
  }
  if (/model ended the turn with an error|model call was interrupted|模型的?调用.*(失败|中断)/i.test(text)) {
    return {
      summary: "Main Agent 的模型调用失败或被中断。",
      guidance: "到「设置」检查 Main Agent 模型与网关是否可用，然后重新发送。",
      permissionBlocked: false,
    };
  }
  if (text.length === 0) {
    if (provider === "codex-cli" || provider === "claude-code") {
      return {
        summary: "旧版本没有记录失败原因；本机黑盒 Worker 默认禁止不受限运行。",
        guidance: "打开「设置 → Agent」，明确允许该 Provider，或改绑其他已允许的 Worker。",
        permissionBlocked: true,
      };
    }
    return {
      summary: "这次任务没有完成，但没有记录到具体原因。",
      guidance: "查看下方“本地执行轨迹”里最后一次动作，确认 Worker 是否安装、登录并拥有所需权限。",
      permissionBlocked: false,
    };
  }
  if (/[\u3400-\u9fff]/.test(text)) {
    return {
      summary: text,
      guidance: "查看下方“本地执行轨迹”里的失败步骤，修正后重新发送。",
      permissionBlocked: false,
    };
  }
  return {
    summary: "Worker 执行失败。",
    guidance: "查看下方“本地执行轨迹”中的原始错误和最后一次动作，修正后重新发送。",
    permissionBlocked: false,
  };
}
