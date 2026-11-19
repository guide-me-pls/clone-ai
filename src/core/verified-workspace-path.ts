import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export async function verifiedWorkspacePath(locator: string, workspacePath: string | undefined): Promise<string | undefined> {
  if (workspacePath === undefined) return undefined;
  let path = locator;
  if (locator.startsWith("file://")) {
    try { path = fileURLToPath(locator); } catch { return undefined; }
  } else if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(locator)) {
    return undefined;
  }
  try {
    const root = await realpath(workspacePath);
    const candidate = await realpath(isAbsolute(path) ? path : resolve(workspacePath, path));
    const inside = relative(root, candidate);
    if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return undefined;
    return candidate;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a locator inside any of the authorized roots. With no fixed working
 * directory, the internal base is one root and each write scope the step
 * declared is another; a scope is where the owner allowed that step to write,
 * so it is also a place the verifier may read. A path outside every root is
 * still refused.
 * 在任一授权根内解析定位符。没有固定工作目录时，内部基准是一个根，步骤声明的每个写
 * Scope 是另一个根；Scope 是所有者允许该步骤写入的位置，因此也是验证器可以读取的位置。
 * 所有根之外的路径仍然拒绝。
 */
export async function verifiedPathInRoots(
  locator: string,
  roots: readonly (string | undefined)[],
): Promise<string | undefined> {
  for (const root of roots) {
    if (root === undefined) continue;
    const resolved = await verifiedWorkspacePath(locator, root);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}
