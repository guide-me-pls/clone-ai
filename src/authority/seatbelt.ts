/**
 * macOS Seatbelt (`sandbox-exec`) profile builder.
 *
 * What is enforced by the OS, honestly stated:
 *  - file writes: nothing outside the granted roots (plus temp locations)
 *  - protected locations (keys, browser profiles, Clone AI's own audit trail):
 *    unreadable and unwritable, whatever any policy says
 *  - network: off unless the step was granted a network scope
 *  - reads elsewhere: allowed by default, because agent CLIs need to read their
 *    own runtimes; `strictReads` additionally hides the home directory except
 *    for the granted roots and the paths the caller lists in `extraReadRoots`.
 *
 * 由 OS 强制执行的内容（如实陈述）：写入只能落在授权根（外加临时目录）；受保护位置（密钥、
 * 浏览器档案、Clone AI 自己的审计轨迹）无论策略如何都不可读写；除非步骤获得 network Scope，
 * 否则断网；其他位置的读取默认允许，因为 Agent CLI 需要读取自身运行时；`strictReads` 额外
 * 隐藏家目录，只留下授权根与调用方列在 `extraReadRoots` 中的路径。
 *
 * Seatbelt resolves rules last-match-wins, so the protected-location denials are
 * emitted last and cannot be overridden by an earlier allow.
 * Seatbelt 规则以最后匹配者为准，所以受保护位置的拒绝规则放在最后，不会被前面的允许覆盖。
 */
import { homedir } from "node:os";

import type { EffectiveGrants } from "./path-gateway.ts";
import { forbiddenRoots } from "./scope.ts";

export interface SeatbeltOptions {
  grants: EffectiveGrants;
  home?: string;
  strictReads?: boolean;
  /** Needed only with strictReads: runtime and config dirs the CLI itself requires. 仅 strictReads 需要：CLI 自身所需的运行时与配置目录。 */
  extraReadRoots?: readonly string[];
  /** Extra writable dirs the CLI needs for its own state (e.g. ~/.claude). CLI 自身状态所需的额外可写目录。 */
  extraWriteRoots?: readonly string[];
}

/** Quote for a Seatbelt string literal; rejects characters that could break out. 为 Seatbelt 字符串字面量加引号；拒绝可能逃逸的字符。 */
export function sbString(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error("Sandbox paths must not contain control characters.");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

const subpath = (path: string): string => `(subpath ${sbString(path)})`;

export function buildSeatbeltProfile(options: SeatbeltOptions): string {
  const home = options.home ?? homedir();
  const { grants } = options;
  const writes = [...grants.writeRoots, ...(options.extraWriteRoots ?? [])];
  const lines: string[] = [
    "(version 1)",
    "(allow default)",
    // Writes: deny everything, then re-allow the granted roots. 写：先全部拒绝，再放开授权根。
    "(deny file-write*)",
    `(allow file-write* ${writes.map(subpath).join(" ")})`,
    '(allow file-write* (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper"))',
    '(allow file-write* (subpath "/private/tmp") (subpath "/private/var/folders") (subpath "/tmp"))',
  ];
  if (!grants.network) lines.push("(deny network*)", '(allow network* (local unix-socket))');
  if (options.strictReads === true) {
    const reads = [...grants.readRoots, ...grants.writeRoots, ...(options.extraReadRoots ?? []), ...(options.extraWriteRoots ?? [])];
    lines.push(`(deny file-read* ${subpath(home)})`);
    if (reads.length > 0) lines.push(`(allow file-read* ${reads.map(subpath).join(" ")})`);
  }
  // Last, so nothing above can re-open them. 放在最后，前面的任何规则都无法重新开放它们。
  const protectedRoots = forbiddenRoots(home);
  lines.push(`(deny file-read* file-write* ${protectedRoots.map(subpath).join(" ")})`);
  return `${lines.join("\n")}\n`;
}

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** Wraps a command so it runs under the profile. 包装命令，使其在该 profile 下运行。 */
export function wrapWithSandbox(profile: string, command: string, args: readonly string[]): { command: string; args: string[] } {
  return { command: SANDBOX_EXEC, args: ["-p", profile, command, ...args] };
}
