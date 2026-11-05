/**
 * An owner-shared calendar, read from an ICS file or URL.
 *
 * ICS is the format every calendar app can export and most can serve, so one
 * reader covers Apple Calendar, Google Calendar's private URL, Outlook exports
 * and Nextcloud without an OAuth flow or a vendor SDK. The connector reads
 * only: it has no method to accept an invite or move an event, because
 * "noticing something" and "acting on it" must stay separable for the approval
 * gate to mean anything.
 *
 * Calendar titles are untrusted text like any other observation: a title can
 * say "ignore your rules", and it stays a string the runtime observed.
 *
 * 所有者共享的日历，从 ICS 文件或 URL 读取。
 *
 * ICS 是每个日历应用都能导出、多数还能远程提供的格式，因此一个读取器就能覆盖 Apple 日历、
 * Google 日历的私密链接、Outlook 导出与 Nextcloud，无需 OAuth 流程或厂商 SDK。Connector 只读：
 * 没有接受邀请或移动日程的方法，因为"注意到某事"与"对它采取行动"必须保持可分离，审批闸门才有意义。
 *
 * 日历标题与其他观察一样是不可信文本：标题里可以写着"忽略你的规则"，它仍只是被观察到的字符串。
 */
import { readFile } from "node:fs/promises";

import type { Connector, ConnectorReadResult, Observation } from "./connector.ts";

export interface CalendarConnectorOptions {
  id?: string;
  /** A local .ics path or an https URL serving ICS. 本地 .ics 路径，或提供 ICS 的 https URL。 */
  source: string;
  /** How far ahead and behind to report. 向前与向后报告多久。 */
  windowDays?: number;
  limit?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

interface IcsEvent {
  uid?: string;
  summary?: string;
  dtstart?: string;
  dtend?: string;
  location?: string;
  description?: string;
  status?: string;
}

/** Unfolds RFC 5545 line continuations and splits into BEGIN:VEVENT blocks. 展开 RFC 5545 的续行并按 BEGIN:VEVENT 分块。 */
export function parseIcsEvents(source: string): IcsEvent[] {
  const unfolded = source.replace(/\r?\n[ \t]/g, "");
  const events: IcsEvent[] = [];
  for (const block of unfolded.split("BEGIN:VEVENT").slice(1)) {
    const body = block.split("END:VEVENT")[0] ?? "";
    const event: IcsEvent = {};
    for (const line of body.split(/\r?\n/)) {
      const separator = line.indexOf(":");
      if (separator <= 0) continue;
      const rawKey = line.slice(0, separator);
      const key = rawKey.split(";")[0]!.toUpperCase();
      const value = unescapeText(line.slice(separator + 1));
      if (key === "UID") event.uid = value;
      else if (key === "SUMMARY") event.summary = value;
      else if (key === "DTSTART") event.dtstart = parseIcsDate(rawKey, value);
      else if (key === "DTEND") event.dtend = parseIcsDate(rawKey, value);
      else if (key === "LOCATION") event.location = value;
      else if (key === "DESCRIPTION") event.description = value;
      else if (key === "STATUS") event.status = value;
    }
    events.push(event);
  }
  return events;
}

/** Handles the two value forms ICS uses: local/UTC timestamps and dates. 处理 ICS 的两种取值形式：本地/UTC 时间戳与日期。 */
function parseIcsDate(rawKey: string, value: string): string | undefined {
  const isDateOnly = /VALUE=DATE(?!-TIME)/i.test(rawKey) || /^\d{8}$/.test(value);
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value);
  if (match === null) return undefined;
  const [, year, month, day, hour = "00", minute = "00", second = "00", zulu] = match;
  const stamp = `${year}-${month}-${day}T${hour}:${minute}:${second}${zulu === "Z" ? "Z" : ""}`;
  // A date-only value is a day, not an instant; reporting it at local midnight
  // would invent a time the calendar never stated.
  // 仅日期的值表示一天而非某个时刻；报成本地零点等于编造日历并未给出的时间。
  return isDateOnly ? `${year}-${month}-${day}` : stamp;
}

function unescapeText(value: string): string {
  return value.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\;/g, ";").replace(/\\\\/g, "\\").trim();
}

export class CalendarConnector implements Connector {
  readonly id: string;
  readonly label = "Calendar";
  readonly scope: string;
  readonly #options: CalendarConnectorOptions;
  readonly #fetch: typeof fetch;

  constructor(options: CalendarConnectorOptions) {
    this.id = options.id ?? "calendar";
    this.#options = options;
    this.#fetch = options.fetchImpl ?? fetch;
    this.scope = `Read-only: ${redactSource(options.source)}`;
  }

  async read(options: { since?: string; limit?: number } = {}): Promise<ConnectorReadResult> {
    const observedAt = new Date().toISOString();
    const now = (this.#options.now ?? (() => new Date()))();
    const windowDays = this.#options.windowDays ?? 14;
    const limit = Math.min(options.limit ?? this.#options.limit ?? 50, 500);
    const from = Date.parse(options.since ?? "") || now.getTime() - windowDays * 86_400_000;
    const to = now.getTime() + windowDays * 86_400_000;
    try {
      const source = await this.#load();
      const observations: Observation[] = [];
      for (const event of parseIcsEvents(source)) {
        if (event.summary === undefined) continue;
        if (event.status?.toUpperCase() === "CANCELLED") continue;
        const start = event.dtstart === undefined ? undefined : Date.parse(event.dtstart);
        // A date-only start has no instant; keep it when its day falls in range.
        // 仅日期的开始没有时刻；只要其日期落在范围内就保留。
        const inRange = start === undefined
          ? true
          : Number.isNaN(start)
            ? true
            : start >= from && start <= to;
        if (!inRange) continue;
        observations.push({
          externalId: event.uid ?? `${event.summary}@${event.dtstart ?? "unknown"}`,
          kind: "calendar_event",
          title: event.summary,
          ...(event.description === undefined ? {} : { body: event.description.slice(0, 400) }),
          ...(event.dtstart === undefined ? {} : { occurredAt: event.dtstart }),
          ...(event.location === undefined ? {} : { locator: event.location }),
        });
        if (observations.length >= limit) break;
      }
      observations.sort((left, right) => (left.occurredAt ?? "").localeCompare(right.occurredAt ?? ""));
      return { connectorId: this.id, observedAt, observations };
    } catch (error: unknown) {
      return { connectorId: this.id, observedAt, observations: [], error: error instanceof Error ? error.message : String(error) };
    }
  }

  async #load(): Promise<string> {
    if (/^https:\/\//i.test(this.#options.source)) {
      const response = await this.#fetch(this.#options.source, { headers: { accept: "text/calendar, text/plain" } });
      if (!response.ok) throw new Error(`The calendar returned ${response.status}.`);
      return await response.text();
    }
    return await readFile(this.#options.source, "utf8");
  }
}

/** Never show a secret-bearing calendar URL in full. 绝不完整展示可能带密钥的日历 URL。 */
function redactSource(source: string): string {
  try {
    const url = new URL(source);
    if (url.search.length > 0) url.search = "?…";
    return url.toString();
  } catch {
    return source;
  }
}
