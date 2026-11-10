/**
 * The path containment check shared by every in-process executor.
 *
 * A scope check is only as strong as the path it compares. This module resolves
 * both sides the way the filesystem will: symlinks are followed, missing
 * suffixes are resolved against their nearest existing ancestor, and the
 * comparison is case-folded on case-insensitive volumes. The previous check
 * compared lexical strings, so a symlink inside the workspace that pointed
 * outside it was inside by name and outside by effect.
 *
 * 每个进程内执行者共用的路径包含检查。
 *
 * Scope 检查的强度取决于它比较的路径。本模块按文件系统的实际行为解析两侧：跟随符号链接，
 * 不存在的后缀按最近的已存在祖先解析，并在不区分大小写的卷上折叠大小写。此前的检查比较的是
 * 字面字符串，因此工作区内一个指向外部的符号链接"名字在内、效果在外"。
 */
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Resolve a path to what the OS would actually open.
 *
 * `realpathSync` throws for a path that does not exist yet (a write target), so
 * the nearest existing ancestor is resolved instead and the remaining segments
 * are appended. The result is still a real path: a symlinked ancestor is
 * followed, which is exactly what a write would do.
 *
 * 解析成操作系统实际会打开的路径。
 *
 * 尚不存在的路径（写入目标）会让 `realpathSync` 抛错，因此改为解析最近的已存在祖先，
 * 再拼回其余段落。结果仍是真实路径：符号链接的祖先会被跟随，这正是写入会做的事。
 */
export function realTarget(path: string): string {
  let current = isAbsolute(path) ? path : resolve(path);
  const pending: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return pending.length === 0 ? real : join(real, ...pending.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return current;
      pending.push(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      current = parent;
    }
  }
}

/**
 * True when `candidate` is `root` or lies inside it, compared after both are
 * resolved. A case-insensitive filesystem is folded so `~/.SSH` cannot pass as
 * a different directory from `~/.ssh`.
 *
 * 当 `candidate` 是 `root` 或位于其内时为真，两侧都先解析再比较。不区分大小写的文件系统
 * 会被折叠，因此 `~/.SSH` 不能冒充与 `~/.ssh` 不同的目录。
 */
export function containsPath(root: string, candidate: string, options: { caseSensitive?: boolean } = {}): boolean {
  const fold = options.caseSensitive === false ? (value: string) => value.toLowerCase() : (value: string) => value;
  const relativePath = relative(fold(root), fold(candidate));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

/**
 * Whether two paths denote the same location, after resolution. Used for
 * denying a protected path whether it is written directly or through a link.
 * 两条路径在解析后是否指向同一位置。用于直接写入与经由链接写入都拒绝受保护路径。
 */
export function samePath(left: string, right: string, options: { caseSensitive?: boolean } = {}): boolean {
  const fold = options.caseSensitive === false ? (value: string) => value.toLowerCase() : (value: string) => value;
  return fold(left) === fold(right);
}
