import { resolveExecutable } from "../workers/executable-resolver.ts";

const DEFAULT_MAGPIE_ENDPOINT = "http://127.0.0.1:3425";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export interface MagpieGatewayModel {
  id: string;
  name: string;
  provider?: string;
  reasoning?: boolean;
  input?: string[];
  compatible?: boolean;
}

export interface MagpieGatewayStatus {
  id: "magpie";
  label: "Magpie";
  installed: boolean;
  running: boolean;
  endpoint: string;
  cliPath?: string;
  version?: string;
  modelCount: number;
  compatibleModelCount?: number;
  models: MagpieGatewayModel[];
  apis: string[];
  checkedAt: string;
  error?: string;
}

export interface InspectMagpieGatewayOptions {
  environment?: NodeJS.ProcessEnv;
  endpoint?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Probe Magpie without reading its provider keys. The root and model routes
 * are intentionally enough to establish availability and enumerate models;
 * credentials stay in Magpie, and Clone AI only asks the local gateway.
 *
 * 只读探测 Magpie，不读取它的 Provider 密钥。根路由与模型路由足以确认可用性并列出
 * 模型；凭据留在 Magpie，Clone AI 只访问本机网关。
 */
export async function inspectMagpieGateway(
  options: InspectMagpieGatewayOptions = {},
): Promise<MagpieGatewayStatus> {
  const environment = options.environment ?? process.env;
  const endpoint = normalizeLoopbackEndpoint(
    options.endpoint
      ?? environment.MAGPIE_GATEWAY_URL
      ?? environment.MAGPIE_BASE_URL
      ?? DEFAULT_MAGPIE_ENDPOINT,
  );
  const cli = resolveExecutable("magpie", { environment });
  const base: MagpieGatewayStatus = {
    id: "magpie",
    label: "Magpie",
    installed: cli.resolvedPath !== undefined,
    running: false,
    endpoint,
    ...(cli.resolvedPath === undefined ? {} : { cliPath: cli.resolvedPath }),
    modelCount: 0,
    models: [],
    apis: [],
    checkedAt: new Date().toISOString(),
  };

  try {
    const root = await requestJson(`${endpoint}/`, options);
    if (root.record.name !== "magpie") {
      return { ...base, error: "The local port answered, but it is not a Magpie gateway." };
    }
    const models = await requestJson(`${endpoint}/v1/models`, options)
      .then((value) => parseModels(value.record))
      .catch(() => []);
    return {
      ...base,
      running: true,
      ...(typeof root.record.version === "string" ? { version: root.record.version } : {}),
      modelCount: numericValue(root.record.models) ?? models.length,
      models,
      apis: stringArray(root.record.apis),
    };
  } catch (error: unknown) {
    return {
      ...base,
      error: error instanceof Error ? error.message : "Magpie gateway is unreachable.",
    };
  }
}

export function normalizeLoopbackEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return DEFAULT_MAGPIE_ENDPOINT;
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(hostname)) return DEFAULT_MAGPIE_ENDPOINT;
  url.username = "";
  url.password = "";
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

async function requestJson(
  url: string,
  options: InspectMagpieGatewayOptions,
): Promise<{ record: Record<string, unknown> }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 1_500);
  timeout.unref();
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Magpie gateway returned HTTP ${response.status}.`);
    const value = await response.json() as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Magpie gateway returned an invalid JSON object.");
    }
    return { record: value as Record<string, unknown> };
  } finally {
    clearTimeout(timeout);
  }
}

function parseModels(record: Record<string, unknown>): MagpieGatewayModel[] {
  const entries = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : [];
  return entries.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const value = entry as Record<string, unknown>;
    if (typeof value.id !== "string" || value.id.trim().length === 0) return [];
    const modalities = typeof value.modalities === "object" && value.modalities !== null
      ? value.modalities as Record<string, unknown>
      : undefined;
    const input = modalities === undefined ? stringArray(value.input) : stringArray(modalities.input);
    return [{
      id: value.id,
      name: typeof value.display_name === "string"
        ? value.display_name
        : typeof value.name === "string"
          ? value.name
          : value.id,
      ...(typeof value.owned_by === "string" ? { provider: value.owned_by } : {}),
      ...(typeof value.reasoning === "boolean" ? { reasoning: value.reasoning } : {}),
      ...(input.length === 0 ? {} : { input }),
    }];
  });
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function numericValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
