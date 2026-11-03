/**
 * Per-request usage from the local Magpie gateway, joined onto audit records.
 *
 * Black-box workers do not report tokens, cost or HTTP errors, but every model
 * call they make goes through the gateway, which does. Joining by time window and
 * client name is an inference, not an identity: the gateway has no idea which
 * Clone AI run a request belonged to. The audit therefore labels the join as
 * `time_window` so an eval never mistakes it for an exact attribution.
 *
 * 本机 Magpie 网关的逐请求用量，联表到审计记录上。
 *
 * 黑盒 Worker 不上报 token、费用和 HTTP 错误，但它们发出的每个模型调用都经过网关，而网关有这些
 * 数据。按时间窗口与客户端名关联是推断而非身份：网关并不知道某个请求属于哪个 Clone AI Run。
 * 因此审计把这种关联标成 `time_window`，评估不会把它误当成精确归因。
 */
import { normalizeLoopbackEndpoint } from "./magpie-gateway.ts";

/** Gateway client names per worker provider. 各 worker provider 在网关里的客户端名。 */
const GATEWAY_AGENT: Readonly<Record<string, string>> = {
  "claude-code": "claude",
  "codex-cli": "codex",
  pi: "pi",
  opencode: "opencode",
};

export interface GatewayRequestRow {
  t: string;
  agent: string;
  model?: string;
  status: number;
  in?: number;
  out?: number;
  cache_read?: number;
  cost?: number;
  ms?: number;
  err?: string;
  ep?: string;
}

export interface GatewayUsage {
  correlation: "time_window";
  calls: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  models: string[];
  /** Up to three distinct gateway error messages, shortest-first trimmed; the usual real cause of a worker failure. 最多三条不同的网关错误信息；通常就是 worker 失败的真正原因。 */
  errorSamples: Array<{ status: number; model?: string; message: string }>;
}

export async function fetchGatewayRows(options: {
  endpoint?: string;
  limit?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
} = {}): Promise<GatewayRequestRow[]> {
  const endpoint = normalizeLoopbackEndpoint(options.endpoint ?? process.env.MAGPIE_GATEWAY_URL ?? "http://127.0.0.1:3425");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 2_000);
  timer.unref();
  try {
    const response = await (options.fetchImpl ?? fetch)(`${endpoint}/v1/magpie/usage/requests?limit=${options.limit ?? 500}`, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const body = await response.json() as { rows?: unknown };
    return Array.isArray(body.rows) ? (body.rows as GatewayRequestRow[]) : [];
  } catch {
    // The gateway is optional: no gateway means no usage, never a failed audit.
    // 网关是可选的：没有网关只是没有用量，绝不让审计失败。
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export function usageForWindow(
  rows: readonly GatewayRequestRow[],
  window: { providerId: string; startedAt: string; endedAt: string },
  slackMs = 2_000,
): GatewayUsage | undefined {
  const agent = GATEWAY_AGENT[window.providerId];
  if (agent === undefined) return undefined;
  const from = Date.parse(window.startedAt) - slackMs;
  const to = Date.parse(window.endedAt) + slackMs;
  const matched = rows.filter((row) => {
    const at = Date.parse(row.t);
    return row.agent === agent && Number.isFinite(at) && at >= from && at <= to;
  });
  if (matched.length === 0) return undefined;
  const errors = matched.filter((row) => row.status >= 400);
  const seen = new Set<string>();
  const errorSamples: GatewayUsage["errorSamples"] = [];
  for (const row of errors) {
    const message = (row.err ?? `HTTP ${row.status}`).replace(/\s+/g, " ").slice(0, 400);
    if (seen.has(message) || errorSamples.length >= 3) continue;
    seen.add(message);
    errorSamples.push({ status: row.status, ...(row.model === undefined ? {} : { model: row.model }), message });
  }
  return {
    correlation: "time_window",
    calls: matched.length,
    errors: errors.length,
    inputTokens: matched.reduce((sum, row) => sum + (row.in ?? 0), 0),
    outputTokens: matched.reduce((sum, row) => sum + (row.out ?? 0), 0),
    cacheReadTokens: matched.reduce((sum, row) => sum + (row.cache_read ?? 0), 0),
    costUsd: Number(matched.reduce((sum, row) => sum + (row.cost ?? 0), 0).toFixed(6)),
    models: [...new Set(matched.map((row) => row.model).filter((model): model is string => model !== undefined))],
    errorSamples,
  };
}
