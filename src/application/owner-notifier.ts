/**
 * Owner-facing desktop notification for a decision the Kernel is waiting on.
 *
 * macOS is the only target with a native surface here. `osascript` posts a
 * user notification without a new daemon dependency, and arguments are passed
 * as `argv` rather than interpolated into AppleScript, so a task title cannot
 * inject script. Every failure is ignored: a notification is a courtesy, not
 * part of the execution contract. Other platforms do nothing.
 *
 * 面向所有者的桌面通知：Kernel 正在等待一个决定。
 *
 * 这里只有 macOS 有原生界面。`osascript` 能发出用户通知而不引入新的守护进程依赖；
 * 文本通过 `argv` 传入而不是拼进 AppleScript，因此任务标题无法注入脚本。所有失败都被忽略：
 * 通知是好意，不是执行契约的一部分。其他平台不做任何事。
 */
import { execFile } from "node:child_process";

import type { OwnerDecisionNotice, OwnerDecisionNotifier } from "../core/contracts.ts";

/** The one-line body shown under the title. 标题下显示的一行正文。 */
export function ownerNoticeBody(notice: OwnerDecisionNotice): string {
  const collapsed = `${notice.title}｜${notice.detail}`.replace(/\s+/g, " ").trim();
  return collapsed.length > 240 ? `${collapsed.slice(0, 239)}…` : collapsed;
}

/** The AppleScript title for the notice. 通知的 AppleScript 标题。 */
export function ownerNoticeTitle(notice: OwnerDecisionNotice): string {
  return notice.kind === "approval" ? "Clone AI：需要你的确认" : "Clone AI：需要你的复核";
}

/**
 * Arguments for `osascript -e … body title`. Kept pure so the quoting can be
 * tested without spawning anything. The script reads `argv`, so no owner text
 * becomes AppleScript source.
 * `osascript -e … body title` 的参数。保持纯函数，使引号无需启动进程即可测试。
 * 脚本读取 `argv`，因此没有任何所有者文本会变成 AppleScript 源码。
 */
export function ownerNotificationArgs(notice: OwnerDecisionNotice): string[] {
  return [
    "-e", "on run argv",
    "-e", "display notification (item 1 of argv) with title (item 2 of argv)",
    "-e", "end run",
    ownerNoticeBody(notice),
    ownerNoticeTitle(notice),
  ];
}

export interface OwnerNotifierOptions {
  platform?: NodeJS.Platform;
  /** Test seam: replace the process spawn. 测试切口：替换进程启动。 */
  exec?: typeof execFile;
}

/** Build the notifier the daemon passes to the Runtime. 构建守护进程传给 Runtime 的通知器。 */
export function createOwnerDecisionNotifier(options: OwnerNotifierOptions = {}): OwnerDecisionNotifier {
  const platform = options.platform ?? process.platform;
  const exec = options.exec ?? execFile;
  return (notice) => {
    if (platform !== "darwin") return;
    try {
      exec("osascript", ownerNotificationArgs(notice), { timeout: 3_000 }, () => undefined);
    } catch {
      // A notification failure must never reach the Kernel. 通知失败绝不能传到 Kernel。
    }
  };
}
