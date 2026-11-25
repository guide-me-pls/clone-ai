/**
 * A plan names intent, not a writable folder.
 *
 * There is no fixed working directory. A step that can write should carry a
 * `files` write scope for the exact targets it will touch, and the policy
 * engine judges that scope: `observe` denies it, `prepare`/`act_with_approval`
 * ask the owner, `act_auto` allows the declared scope, and `allow_all` — the
 * default — grants the whole domain and allows a write that names nothing.
 * Protected locations, unenforced domains and `.git`/`.rsi` writes remain hard
 * denials. A standing policy is an optional narrowing. When a step names no
 * target below `allow_all`, this module adds nothing: the Kernel does not
 * invent a folder, and the authority policy denies the unscoped write.
 *
 * 计划表达的是意图，而不是一个可写文件夹。
 *
 * 没有固定的工作目录。可能写入的步骤应当为它实际触碰的目标携带 `files` 写 Scope，由权限
 * 引擎判定：`observe` 拒绝，`prepare`/`act_with_approval` 询问所有者，`act_auto` 允许声明
 * 的 Scope，`allow_all`（默认值）授予整个域，并允许没有点名目标的写入。受保护位置、未实现
 * 强制的域、`.git`/`.rsi` 写入仍是硬拒绝。常设策略是可选的收紧手段。低于 `allow_all` 时，
 * 步骤没有点名目标则本模块不添加任何 Scope：Kernel 不凭空发明文件夹，权限引擎会拒绝没有
 * 点名目标的写入。
 */
import { isAbsolute } from "node:path";

import type { PlanStep } from "../core/contracts.ts";
import { expandHome, type Scope } from "./scope.ts";

export interface WriteScopeDefaults {
  /** The owner's request or plan summary, scanned for explicitly named targets. 所有者的请求或计划摘要，用于查找显式目标。 */
  requestText?: string;
}

/** More auto-scopes than this is a plan that should name one folder. 自动 Scope 超过这个数量，说明计划应当点名一个文件夹。 */
const MAX_AUTO_SCOPES = 8;

/**
 * Absolute or `~/` paths in prose. A URL's `//` is not a match because the
 * character before it is `:`, not whitespace or an opening quote.
 * 正文中的绝对路径或 `~/` 路径。URL 的 `//` 不会匹配，因为它前面的字符是 `:`，不是空白或开引号。
 */
const PATH_PATTERN = /(?:^|[\s"'`(（])((?:~\/|\/)[^\s"'`）)，,。；;：]+)/gu;

/**
 * Only a path after a positive write cue is a write target. A request such as
 * "read /etc/hosts and write a summary" must not scope `/etc/hosts` for
 * writing; the path after "write" is what the owner asked to create.
 * 只有正向写入线索之后的路径才是写入目标。"读取 /etc/hosts 并写一份摘要"不应把
 * `/etc/hosts` 当成写入目标；"写"之后出现的路径才是所有者要求创建的。
 */
const WRITE_CUE = /(?:写到|写入|保存到|保存成|输出到|生成|创建|新建|形成|交付|修改|编辑|改动|write|save|create|output|generate|export|deliver|edit|modify|change|update)/giu;
const CLAUSE_SPLIT = /[。；;!?！？\n]+/u;
/**
 * A write cue inside a prohibition is not a grant. "Do not write X" and
 * "不要写 X" name a boundary, not a target; treating them as scopes would make
 * the brief's own restriction enforceable against the worker it protects.
 * 禁令里的写入线索不是授权。"Do not write X" 与"不要写 X"点名的是边界，不是目标；
 * 把它们当成 Scope，会让简报自己的限制反过来能作用于它保护的文件。
 */
const NEGATED_WRITE_CUE = /(?:\b(?:do not|don't|never|without|not)\b[^.;,，\n]{0,40}|(?:不要|不得|不能|不可|禁止|只读|仅读|不写|别)[^。；;，,\n]{0,40})$/iu;

/** Explicit write targets in `text`, in order, bounded and de-duplicated. `text` 中按顺序出现、有界且去重的显式写入目标。 */
export function declaredWriteTargets(text: string): string[] {
  const targets: string[] = [];
  const seen = new Set<string>();
  for (const clause of text.split(CLAUSE_SPLIT)) {
    // Find the first cue that is not inside a prohibition. A clause may contain
    // both ("Do not write X, but write Y"); the positive cue is the one that
    // grants a target.
    // 找到第一个不在禁令里的线索。同一分句可能两者都有（"不要写 X，但写 Y"）；只有
    // 正向线索才授予目标。
    WRITE_CUE.lastIndex = 0;
    let cue: RegExpExecArray | null = null;
    for (let match = WRITE_CUE.exec(clause); match !== null; match = WRITE_CUE.exec(clause)) {
      if (!NEGATED_WRITE_CUE.test(clause.slice(0, match.index))) {
        cue = match;
        break;
      }
    }
    if (cue === null) continue;
    for (const match of clause.slice(cue.index).matchAll(PATH_PATTERN)) {
      // A sentence-ending full stop or ASCII period is punctuation, not part
      // of the path; an interior dot (an extension) is kept.
      // 结尾的句号是标点，不是路径的一部分；中间的句点（扩展名）保留。
      const raw = (match[1] ?? "").replace(/[。，、；]+$/u, "").replace(/\.$/u, "");
      if (raw.length === 0) continue;
      const target = expandHome(raw);
      if (!isAbsolute(target) || seen.has(target)) continue;
      seen.add(target);
      targets.push(target);
      if (targets.length >= MAX_AUTO_SCOPES) return targets;
    }
  }
  return targets;
}

/**
 * Add the missing write scope to every step that can write. A step that already
 * declares a files write scope keeps exactly that scope: the plan author chose
 * the target, and widening it here would make the declaration meaningless.
 * 为每个可能写入的步骤补上缺失的写 Scope。已经声明 files 写 Scope 的步骤保留原样：
 * 目标是计划作者选的，在这里放宽会让声明失去意义。
 */
export function ensureWriteScopes(steps: readonly PlanStep[], defaults: WriteScopeDefaults): PlanStep[] {
  return steps.map((step) => withWriteScope(step, defaults));
}

function withWriteScope(step: PlanStep, defaults: WriteScopeDefaults): PlanStep {
  if (step.risk === "read_only") return step;
  // External and irreversible work runs in an isolated copy the Kernel creates;
  // that copy is writable as the sandbox itself, not as a workspace grant.
  // 外部与不可逆工作运行在 Kernel 创建的隔离副本里；该副本作为沙箱本身可写，而不是
  // 作为工作区授权。
  if (step.risk === "external_side_effect" || step.risk === "irreversible") return step;
  const scopes = step.scopes ?? [];
  if (scopes.some((scope) => scope.domain === "files" && scope.access !== "read")) return step;

  // The Main Agent's worker brief is part of the step: a target named only
  // there is still a target the owner asked to write. A subagent order's brief
  // is scanned too, because the step's scopes cover its orders.
  // 主 Agent 的 Worker 简报属于步骤的一部分：只写在简报里的目标仍是所有者要求写入的目标。
  // 子 Agent 工作单的简报也要扫描，因为步骤的 Scope 覆盖它的工作单。
  const briefs = [step.workerBrief ?? "", ...(step.subagents ?? []).map((order) => order.workerBrief ?? "")].join("\n");
  const named = declaredWriteTargets([step.title, step.instructions, briefs, defaults.requestText ?? ""].join("\n"));
  // No target named means no scope. A default folder here is exactly the
  // implicit permission the owner removed; the policy engine will deny the
  // step instead of a folder being invented for it.
  // 没有点名目标就没有 Scope。在这里给一个默认文件夹，正是所有者移除的那种隐式权限；
  // 权限引擎会拒绝该步骤，而不是替它发明一个文件夹。
  if (named.length === 0) return step;

  const additions: Scope[] = named.map((resource) => ({ domain: "files", resource, access: "write" }));
  return { ...step, scopes: [...scopes, ...additions] };
}
