/**
 * A plan names intent, not a writable folder.
 *
 * There is no fixed working directory. Every step that can write must carry a
 * `files` write scope for the exact targets it will touch, and the policy
 * engine judges that scope like any other: `observe` denies it, `prepare` and
 * `act_with_approval` ask the owner, and only an `act_auto` standing policy
 * allows it without a prompt. When a step names no target of its own, this
 * module adds nothing: the Kernel does not invent a folder, and the authority
 * policy denies a write that named no target.
 *
 * 计划表达的是意图，而不是一个可写文件夹。
 *
 * 没有固定的工作目录。每个可能写入的步骤都必须为它实际触碰的目标携带 `files` 写 Scope，
 * 由权限引擎像其他 Scope 一样判定：`observe` 拒绝，`prepare` 与 `act_with_approval`
 * 询问所有者，只有 `act_auto` 常设策略才无需询问。步骤没有点名目标时，本模块不添加任何
 * Scope：Kernel 不凭空发明文件夹，权限引擎会拒绝没有点名目标的写入。
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
const WRITE_CUE = /(?:写到|写入|保存到|保存成|输出到|生成|创建|新建|形成|交付|write|save|create|output|generate|export|deliver)/iu;
const CLAUSE_SPLIT = /[。；;!?！？\n]+/u;

/** Explicit write targets in `text`, in order, bounded and de-duplicated. `text` 中按顺序出现、有界且去重的显式写入目标。 */
export function declaredWriteTargets(text: string): string[] {
  const targets: string[] = [];
  const seen = new Set<string>();
  for (const clause of text.split(CLAUSE_SPLIT)) {
    const cue = clause.match(WRITE_CUE);
    if (cue?.index === undefined) continue;
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

  const named = declaredWriteTargets([step.title, step.instructions, defaults.requestText ?? ""].join("\n"));
  // No target named means no scope. A default folder here is exactly the
  // implicit permission the owner removed; the policy engine will deny the
  // step instead of a folder being invented for it.
  // 没有点名目标就没有 Scope。在这里给一个默认文件夹，正是所有者移除的那种隐式权限；
  // 权限引擎会拒绝该步骤，而不是替它发明一个文件夹。
  if (named.length === 0) return step;

  const additions: Scope[] = named.map((resource) => ({ domain: "files", resource, access: "write" }));
  return { ...step, scopes: [...scopes, ...additions] };
}
