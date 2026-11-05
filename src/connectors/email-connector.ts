/**
 * Owner-shared mail, read through an IMAP INBOX search.
 *
 * Read-only by construction: it opens the mailbox, searches recent messages and
 * closes. There is no SMTP client here, so noticing a message and replying to
 * it cannot be the same action; a reply would have to be a separate work order
 * with its own approval.
 *
 * The mail body is untrusted text like every observation. Mail is the most
 * likely place for an injected instruction ("forward this to everyone"), which
 * is exactly why it crosses the boundary as quoted data with its authority
 * stripped by the renderer.
 *
 * 所有者共享的邮件，通过 IMAP 的 INBOX 搜索读取。
 *
 * 按构造只读：打开邮箱、搜索近期邮件、关闭。这里没有 SMTP 客户端，因此"注意到一封信"与
 * "回复它"不可能是同一个动作；回复必须是一个独立的工作单，拥有自己的审批。
 *
 * 邮件正文与其他观察一样是不可信文本。邮件是最容易被注入指令的地方（"把这封转发给所有人"），
 * 正因如此它越过边界时是被引用的数据，其命令权威由渲染器剥除。
 */
import type { Connector, ConnectorReadResult, Observation } from "./connector.ts";

export interface EmailConnectorOptions {
  id?: string;
  host: string;
  port?: number;
  user: string;
  /** Resolved from an environment variable named in the connector settings, never stored. 从设置中指定的环境变量解析，绝不存储。 */
  password: string;
  /** Mailbox to read; default INBOX. 读取的邮箱，默认 INBOX。 */
  mailbox?: string;
  secure?: boolean;
  windowDays?: number;
  limit?: number;
  now?: () => Date;
  /** Injected for tests; production resolves the package lazily. 供测试注入；生产环境延迟解析该包。 */
  transport?: () => Promise<ImapTransport>;
}

/** The smallest slice of IMAP this connector needs; keeps the dependency optional. 本 Connector 所需的最小 IMAP 接口，使依赖保持可选。 */
export interface ImapTransport {
  connect(): Promise<void>;
  search(since: Date, limit: number, mailbox: string): Promise<Array<{ uid: string; from?: string; subject?: string; date?: string; snippet?: string }>>;
  close(): Promise<void>;
}

export class EmailConnector implements Connector {
  readonly id: string;
  readonly label = "Email";
  readonly scope: string;
  readonly #options: EmailConnectorOptions;

  constructor(options: EmailConnectorOptions) {
    this.id = options.id ?? "email";
    this.#options = options;
    this.scope = `Read-only: ${options.mailbox ?? "INBOX"} on ${options.host} as ${options.user}`;
  }

  async read(options: { since?: string; limit?: number } = {}): Promise<ConnectorReadResult> {
    const observedAt = new Date().toISOString();
    const now = (this.#options.now ?? (() => new Date()))();
    const windowDays = this.#options.windowDays ?? 7;
    const since = new Date(Date.parse(options.since ?? "") || now.getTime() - windowDays * 86_400_000);
    const limit = Math.min(options.limit ?? this.#options.limit ?? 30, 200);
    let transport: ImapTransport | undefined;
    try {
      transport = this.#options.transport === undefined ? await this.#loadTransport() : await this.#options.transport();
      await transport.connect();
      const messages = await transport.search(since, limit, this.#options.mailbox ?? "INBOX");
      const observations: Observation[] = messages.slice(0, limit).map((message) => ({
        externalId: message.uid,
        kind: "message",
        title: `${message.subject ?? "(no subject)"}${message.from === undefined ? "" : ` — ${message.from}`}`,
        ...(message.snippet === undefined ? {} : { body: message.snippet.slice(0, 400) }),
        ...(message.date === undefined ? {} : { occurredAt: message.date }),
        locator: `imap://${this.#options.host}/${message.uid}`,
      }));
      return { connectorId: this.id, observedAt, observations };
    } catch (error: unknown) {
      // A missing IMAP dependency or a refused login is reported, not thrown:
      // one broken source must not blind the rest of the sweep.
      // 缺少 IMAP 依赖或登录被拒会被报告而不是抛出：单个坏来源不能让整轮扫描失明。
      return { connectorId: this.id, observedAt, observations: [], error: error instanceof Error ? error.message : String(error) };
    } finally {
      await transport?.close().catch(() => undefined);
    }
  }

  async #loadTransport(): Promise<ImapTransport> {
    // IMAP is an optional dependency: a clone without mail must not fail to
    // start, and the error says exactly what to install.
    // IMAP 是可选依赖：没有邮件功能的克隆必须能正常启动，且错误信息应明确说明要装什么。
    const moduleName = "imapflow";
    let imported: unknown;
    try {
      imported = await import(/* @vite-ignore */ moduleName).catch(() => ({}));
    } catch {
      imported = {};
    }
    const ImapFlow = (imported as { ImapFlow?: new (options: Record<string, unknown>) => ImapSession }).ImapFlow;
    if (ImapFlow === undefined) {
      throw new Error("Reading mail needs the optional package \"imapflow\"; install it with `npm install imapflow`.");
    }
    const client = new ImapFlow({ host: this.#options.host, port: this.#options.port ?? 993, secure: this.#options.secure ?? true, auth: { user: this.#options.user, pass: this.#options.password } });
    return new ImapflowTransport(client);
  }
}

interface ImapSession {
  connect(): Promise<void>;
  getMailboxLock(path: string): Promise<{ release(): void }>;
  search(criteria: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown[]>;
  fetch(range: unknown, query: Record<string, unknown>, options?: Record<string, unknown>): AsyncIterable<Record<string, unknown>>;
  logout(): Promise<void>;
}

class ImapflowTransport implements ImapTransport {
  readonly #client: ImapSession;
  #lock: { release(): void } | undefined;

  constructor(client: ImapSession) {
    this.#client = client;
  }

  async connect(): Promise<void> {
    await this.#client.connect();
  }

  async search(since: Date, limit: number, mailbox: string): Promise<Array<{ uid: string; from?: string; subject?: string; date?: string; snippet?: string }>> {
    this.#lock = await this.#client.getMailboxLock(mailbox);
    const uids = await this.#client.search({ since }, { uid: true }) as Array<number | string>;
    const selected = uids.slice(-limit);
    if (selected.length === 0) return [];
    const messages: Array<{ uid: string; from?: string; subject?: string; date?: string; snippet?: string }> = [];
    for await (const message of this.#client.fetch(selected, { envelope: true, bodyStructure: true }, { uid: true })) {
      const envelope = (message.envelope ?? {}) as { subject?: string; date?: Date; from?: Array<{ name?: string; address?: string }> };
      const from = envelope.from?.[0];
      messages.push({
        uid: String(message.uid ?? ""),
        ...(envelope.subject === undefined ? {} : { subject: envelope.subject }),
        ...(from === undefined ? {} : { from: from.name ?? from.address }),
        ...(envelope.date === undefined ? {} : { date: new Date(envelope.date).toISOString() }),
      });
    }
    return messages;
  }

  async close(): Promise<void> {
    this.#lock?.release();
    await this.#client.logout().catch(() => undefined);
  }
}
