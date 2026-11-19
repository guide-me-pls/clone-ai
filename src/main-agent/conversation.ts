/**
 * Which task a Main Agent turn belongs to.
 *
 * A conversation id scopes three things that used to be global: the turn
 * ledger rows the model sees as history, the prompt lock that keeps one
 * conversation from interleaving two answers, and the sidebar entry the
 * desktop renders. Turns written before this field existed belong to the main
 * conversation, so an old clone home opens exactly where it left off.
 *
 * 一个 Main Agent 回合属于哪个任务。
 *
 * 对话 id 划分了三件过去是全局的事：模型当作历史的回合台账行、防止同一对话交错两次回答的
 * 提示词锁，以及桌面侧栏渲染的条目。该字段出现之前写入的回合属于主对话，因此旧的
 * clone home 会从它停下的地方原样打开。
 */

/** The owner's original thread; every legacy turn belongs here. 所有者最初的线索；所有旧回合都属于这里。 */
export const MAIN_AGENT_DEFAULT_CONVERSATION_ID = "main-agent-conversation";

/**
 * Conversation ids become lock-file names and ledger values, so they are
 * restricted to characters that need no quoting on disk or in a URL. They also
 * carry a namespace prefix: a bare run UUID must never become a conversation,
 * or the session route could no longer tell the two apart.
 * 对话 id 会成为锁文件名与台账值，因此限制为在磁盘和 URL 中都不需要转义的字符。它们还带
 * 命名空间前缀：裸 Run UUID 绝不能变成对话，否则会话路由将无法区分两者。
 */
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

const CONVERSATION_PREFIXES = ["conversation-", "whatsapp:"] as const;

/** A record's conversation, with the legacy default for rows written before scoping. 记录所属对话；划分之前写入的行归默认主对话。 */
export function conversationIdOf(value: string | undefined): string {
  return value === undefined || value.length === 0 ? MAIN_AGENT_DEFAULT_CONVERSATION_ID : value;
}

/**
 * Parse a conversation id from a request body. An absent or empty value means
 * the main conversation; a value that could escape a directory or a URL is
 * refused rather than silently rewritten.
 * 从请求体解析对话 id。缺省或空值表示主对话；可能逃出目录或 URL 的值会被拒绝，而不是
 * 悄悄改写。
 */
export function parseConversationId(value: unknown): { ok: true; id: string } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, id: MAIN_AGENT_DEFAULT_CONVERSATION_ID };
  if (typeof value !== "string") return { ok: false, error: "conversationId must be a string." };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: true, id: MAIN_AGENT_DEFAULT_CONVERSATION_ID };
  if (!CONVERSATION_ID_PATTERN.test(trimmed)) {
    return { ok: false, error: "conversationId may contain only letters, digits, dot, colon, underscore and hyphen (1-120 characters)." };
  }
  if (trimmed !== MAIN_AGENT_DEFAULT_CONVERSATION_ID && !CONVERSATION_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
    return { ok: false, error: "conversationId must start with conversation- or whatsapp:, or be the main conversation." };
  }
  return { ok: true, id: trimmed };
}
