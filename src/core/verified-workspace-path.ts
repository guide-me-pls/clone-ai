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
