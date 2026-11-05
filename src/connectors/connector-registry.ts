import { readJsonFile, writeJsonAtomic } from "../config/json-file.ts";
import type { JournalStore } from "../core/journal.ts";
import type { Connector, ConnectorReadResult, ConnectorSettings, Observation } from "./connector.ts";
import { FileConnector } from "./file-connector.ts";
import { CalendarConnector } from "./calendar-connector.ts";
import { EmailConnector } from "./email-connector.ts";

/**
 * Builds the enabled connectors and records what they saw.
 *
 * Observation is journaled like every other durable fact, for one reason that
 * matters more than tidiness: the twin will later act on things nobody typed
 * at it, and the owner has to be able to ask "why did you think that?" and get
 * an answer. An observation that only lived in memory could justify a proposal
 * that can never be traced back.
 *
 * 构建已启用的 Connector 并记录它们看到了什么。
 *
 * 观察结果与其他持久事实一样写入 Journal，理由比整洁更重要：分身以后会依据没人告诉它的
 * 事情行动，而所有者必须能问出"你为什么这么认为"并得到答案。只存在于内存里的观察，会
 * 支撑起一个永远无法回溯的提案。
 */

export interface ConnectorConfigFile {
  connectors?: ConnectorSettings[];
}

export async function readConnectorSettings(dataDirectory: string): Promise<ConnectorSettings[]> {
  const value = await readJsonFile<ConnectorConfigFile>(`${dataDirectory}/connectors.json`);
  const entries = value?.connectors ?? [];
  return entries.map((entry, index) => validate(entry, index));
}

export async function writeConnectorSettings(
  dataDirectory: string,
  connectors: readonly ConnectorSettings[],
): Promise<ConnectorSettings[]> {
  const validated = connectors.map((entry, index) => validate(entry, index));
  await writeJsonAtomic(`${dataDirectory}/connectors.json`, { connectors: validated });
  return validated;
}

/**
 * Builds a connector from its setting. A new source becomes available by adding
 * a builder here, not by changing anything that consumes observations.
 *
 * Credentials are named, never stored: `env` lists variable names, and a
 * connector that needs one reads it from the process environment at build
 * time. A missing variable leaves that connector disabled with a reported
 * error rather than an empty-looking mailbox.
 * 依据设置构建 Connector。新增来源只需在此添加构造器，消费观察结果的那一侧无需改动。
 *
 * 凭据只以名字出现、绝不存储：`env` 列出变量名，需要的 Connector 在构建时从进程环境读取。
 * 变量缺失时该 Connector 保持禁用并报告错误，而不是显示成一个空邮箱。
 */
export function buildConnector(
  settings: ConnectorSettings,
  workspacePath: string,
  environment: NodeJS.ProcessEnv = process.env,
): Connector | undefined {
  if (!settings.enabled) return undefined;
  if (settings.id === "local-files" || settings.id.startsWith("files:")) {
    return new FileConnector({ id: settings.id, root: settings.target ?? workspacePath });
  }
  if (settings.id === "calendar" || settings.id.startsWith("calendar:")) {
    if (settings.target === undefined) return new UnavailableConnector(settings.id, "A calendar connector needs a target: an .ics path or an https URL.");
    return new CalendarConnector({ id: settings.id, source: settings.target });
  }
  if (settings.id === "email" || settings.id.startsWith("email:")) {
    const [host, user] = (settings.target ?? "").split("|");
    const passwordVariable = settings.env?.find((name) => /pass|token|secret/i.test(name));
    const password = passwordVariable === undefined ? undefined : environment[passwordVariable];
    if (host === undefined || host.length === 0 || user === undefined || password === undefined) {
      return new UnavailableConnector(
        settings.id,
        "An email connector needs target \"host|user\" and one env variable holding the password (e.g. CLONE_AI_EMAIL_PASSWORD).",
      );
    }
    return new EmailConnector({ id: settings.id, host, user, password });
  }
  return undefined;
}

/**
 * A connector that explains why it cannot run. Reporting beats disappearing:
 * the owner enabled it and deserves to know what is missing.
 * 一个说明自己为何无法运行的 Connector。报告胜过消失：所有者启用了它，理应知道缺什么。
 */
class UnavailableConnector implements Connector {
  readonly id: string;
  readonly label = "Unavailable";
  readonly scope: string;
  readonly #reason: string;

  constructor(id: string, reason: string) {
    this.id = id;
    this.#reason = reason;
    this.scope = "Read-only: nothing (not configured)";
  }

  async read(): Promise<ConnectorReadResult> {
    return { connectorId: this.id, observedAt: new Date().toISOString(), observations: [], error: this.#reason };
  }
}

export interface ObservationSweep {
  results: readonly ConnectorReadResult[];
  observations: readonly Observation[];
}

/**
 * Reads every enabled connector. One failing source is reported and skipped
 * rather than aborting the sweep, so a single misconfigured path cannot make
 * the twin blind to everything else.
 * 读取每一个已启用的 Connector。失败的来源会被报告并跳过而不是中断整个扫描，因此单个
 * 配置错误的路径不会让分身对其余一切失明。
 */
export async function sweepConnectors(input: {
  dataDirectory: string;
  workspacePath: string;
  journal?: JournalStore;
  since?: string;
  limitPerConnector?: number;
}): Promise<ObservationSweep> {
  const settings = await readConnectorSettings(input.dataDirectory);
  const results: ConnectorReadResult[] = [];

  for (const entry of settings) {
    const connector = buildConnector(entry, input.workspacePath);
    if (connector === undefined) continue;
    const result = await connector.read({
      ...(input.since === undefined ? {} : { since: input.since }),
      ...(input.limitPerConnector === undefined ? {} : { limit: input.limitPerConnector }),
    });
    results.push(result);
    if (input.journal !== undefined) {
      await input.journal.append({
        type: "observation.recorded",
        payload: {
          connectorId: result.connectorId,
          observedAt: result.observedAt,
          // Titles and locators only: a journal is inspected by the owner, and
          // bodies would turn it into a copy of everything the twin ever read.
          // 只记标题与定位：Journal 是给所有者查阅的，把正文写进去会让它变成分身读过的
          // 一切内容的副本。
          observations: result.observations.map((observation) => ({
            externalId: observation.externalId,
            kind: observation.kind,
            title: observation.title,
            occurredAt: observation.occurredAt,
            locator: observation.locator,
          })),
          ...(result.error === undefined ? {} : { error: result.error }),
        },
      });
    }
  }

  return { results, observations: results.flatMap((result) => result.observations) };
}

function validate(value: unknown, index: number): ConnectorSettings {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Connector declaration #${index} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.trim().length === 0) {
    throw new Error(`Connector declaration #${index} needs a non-empty id.`);
  }
  if (typeof record.enabled !== "boolean") {
    throw new Error(`Connector "${record.id}" needs an explicit enabled flag.`);
  }
  if (record.target !== undefined && typeof record.target !== "string") {
    throw new Error(`Connector "${record.id}" target must be a path.`);
  }
  if (
    record.env !== undefined
    && (!Array.isArray(record.env) || record.env.some((name) => typeof name !== "string" || !/^[A-Z_][A-Z0-9_]*$/i.test(name)))
  ) {
    // Names only, never values: a config file must not become a place a
    // credential can sit.
    // 只存名字不存值：配置文件不能变成凭据的存放处。
    throw new Error(`Connector "${record.id}" env must contain variable names only.`);
  }
  return {
    id: record.id,
    enabled: record.enabled,
    ...(typeof record.target === "string" ? { target: record.target } : {}),
    ...(Array.isArray(record.env) ? { env: record.env as string[] } : {}),
  };
}
