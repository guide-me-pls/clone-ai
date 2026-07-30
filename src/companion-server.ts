import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { JournalEvent, MemoryCandidate, Run, Task } from "./core/contracts.ts";
import { JsonlJournalStore } from "./core/journal.ts";
import { replay } from "./core/run-state.ts";
import { approveDemoWorkflow, startDemoWorkflow } from "./demo-workflow.ts";
import { LocalScheduler } from "./scheduling/local-scheduler.ts";
import { describeSchedule, ScheduleStore, type LocalSchedule, type ScheduleKind } from "./scheduling/schedule-store.ts";
import { SessionStore } from "./sessions/session-store.ts";
import { AgentSettingsStore } from "./settings/agent-settings.ts";
import { LocalAgentRegistry } from "./agents/agent-registry.ts";
import { LocalMemoryStore } from "./memory/memory-store.ts";

export interface CompanionServerOptions {
  host?: string;
  port?: number;
  dataDirectory?: string;
  clientPath?: string;
}

export interface RunningCompanionServer {
  url: string;
  close(): Promise<void>;
}

/**
 * Local-only daemon transport used by the desktop shell. The shipped Tauri
 * window opens this loopback URL; it is never a hosted web service.
 */
export async function startCompanionServer(options: CompanionServerOptions = {}): Promise<RunningCompanionServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? parsePort(process.env.CLONE_AI_PORT, 4317);
  const dataDirectory = options.dataDirectory ?? process.env.CLONE_AI_DATA_DIR ?? join(process.cwd(), ".clone-ai");
  const clientPath = options.clientPath ?? join(process.cwd(), "apps", "desktop", "ui", "index.html");
  const clientDirectory = dirname(clientPath);
  const [client, clientCss, clientJs] = await Promise.all([
    readFile(clientPath, "utf8"),
    readFile(join(clientDirectory, "style.css"), "utf8"),
    readFile(join(clientDirectory, "app.js"), "utf8"),
  ]);
  const schedules = new ScheduleStore(join(dataDirectory, "schedules.json"));
  const sessions = new SessionStore(join(dataDirectory, "sessions.json"));
  const agentSettings = new AgentSettingsStore(join(dataDirectory, "settings.json"));
  const agentRegistry = new LocalAgentRegistry();
  const memoryStore = new LocalMemoryStore(join(dataDirectory, "memory.json"));
  await syncMemory(dataDirectory, memoryStore);
  const scheduler = new LocalScheduler({
    store: schedules,
    run: async (schedule) => {
      await startDemoWorkflow(dataDirectory, schedule.query, {
        kind: "schedule",
        payload: { scheduleId: schedule.id, scheduleKind: schedule.kind, scheduleDescription: describeSchedule(schedule) },
      }, await agentSettings.get());
      await syncMemory(dataDirectory, memoryStore);
    },
  });

  const server = createServer(async (request, response) => {
    try {
      await handleRequest(request, response, { host, dataDirectory, client, clientCss, clientJs, schedules, sessions, agentSettings, agentRegistry, memoryStore });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "The local runtime encountered an unexpected error.";
      sendJson(response, 500, { error: message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The local companion did not expose a TCP address.");
  }
  const url = `http://${host}:${address.port}`;
  scheduler.start();
  return {
    url,
    close: () => new Promise((resolve, reject) => {
      scheduler.stop();
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    }),
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: { host: string; dataDirectory: string; client: string; clientCss: string; clientJs: string; schedules: ScheduleStore; sessions: SessionStore; agentSettings: AgentSettingsStore; agentRegistry: LocalAgentRegistry; memoryStore: LocalMemoryStore },
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${context.host}`);

  if (request.method === "GET" && url.pathname === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(context.client);
    return;
  }
  if (request.method === "GET" && url.pathname === "/style.css") {
    response.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" });
    response.end(context.clientCss);
    return;
  }
  if (request.method === "GET" && url.pathname === "/app.js") {
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
    response.end(context.clientJs);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/dashboard") {
    sendJson(response, 200, await buildDashboard(context.dataDirectory, context.sessions));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/settings") {
    sendJson(response, 200, await context.agentSettings.get());
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/agents") {
    sendJson(response, 200, { providers: await context.agentRegistry.list() });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/agents/install-missing") {
    try {
      const providers = await context.agentRegistry.list();
      const installed = [];
      for (const provider of providers.filter((provider) => !provider.installed)) {
        installed.push(await context.agentRegistry.install(provider.id));
      }
      sendJson(response, 200, { installed, providers: await context.agentRegistry.list() });
    } catch (error: unknown) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "The local Agent installation failed." });
    }
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/memory") {
    const query = url.searchParams.get("q")?.trim() ?? "";
    if (query.length > 0) {
      sendJson(response, 200, { query, matches: await context.memoryStore.search(query) });
      return;
    }
    sendJson(response, 200, await buildMemoryView(context.memoryStore));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/memory") {
    const body = await readJsonBody(request);
    if (typeof body.summary !== "string") {
      sendJson(response, 400, { error: "A new memory needs a summary." });
      return;
    }
    try {
      sendJson(response, 201, { memory: await context.memoryStore.create(body.summary) });
    } catch (error: unknown) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "The local memory could not be created." });
    }
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/schedules") {
    sendJson(response, 200, { schedules: (await context.schedules.list()).map(toScheduleView) });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/schedules") {
    const body = await readJsonBody(request);
    const query = typeof body.query === "string" ? body.query : "";
    const kind = isScheduleKind(body.kind) ? body.kind : "daily";
    const time = typeof body.time === "string" ? body.time : undefined;
    const weekdays = Array.isArray(body.weekdays) && body.weekdays.every((day) => typeof day === "number") ? body.weekdays : undefined;
    const dayOfMonth = typeof body.dayOfMonth === "number" ? body.dayOfMonth : undefined;
    const month = typeof body.month === "number" ? body.month : undefined;
    const cron = typeof body.cron === "string" ? body.cron : undefined;
    const intervalMinutes = typeof body.intervalMinutes === "number" ? body.intervalMinutes : undefined;
    try {
      sendJson(response, 201, { schedule: toScheduleView(await context.schedules.add({ query, kind, time, weekdays, dayOfMonth, month, cron, intervalMinutes })) });
    } catch (error: unknown) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "The schedule is invalid." });
    }
    return;
  }

  const scheduleMatch = url.pathname.match(/^\/api\/schedules\/([^/]+)$/);
  if (request.method === "PATCH" && scheduleMatch?.[1] !== undefined) {
    const body = await readJsonBody(request);
    if (typeof body.enabled !== "boolean") {
      sendJson(response, 400, { error: "A schedule update needs an enabled boolean." });
      return;
    }
    try {
      sendJson(response, 200, { schedule: toScheduleView(await context.schedules.setEnabled(decodeURIComponent(scheduleMatch[1]), body.enabled)) });
    } catch (error: unknown) {
      sendJson(response, 404, { error: error instanceof Error ? error.message : "The schedule was not found." });
    }
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/requests") {
    const body = await readJsonBody(request);
    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (query.length < 3) {
      sendJson(response, 400, { error: "Please describe the work in at least three characters." });
      return;
    }
    const result = await startDemoWorkflow(context.dataDirectory, query, {}, await context.agentSettings.get());
    await syncMemory(context.dataDirectory, context.memoryStore);
    sendJson(response, 201, result);
    return;
  }

  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (request.method === "GET" && sessionMatch?.[1] !== undefined) {
    const runId = decodeURIComponent(sessionMatch[1]);
    if (await context.sessions.isDeleted(runId)) {
      sendJson(response, 404, { error: "This session was removed from the local conversation list." });
      return;
    }
    sendJson(response, 200, await buildSession(context.dataDirectory, runId, await context.agentSettings.get()));
    return;
  }
  if (request.method === "DELETE" && sessionMatch?.[1] !== undefined) {
    const runId = decodeURIComponent(sessionMatch[1]);
    const { runs } = await loadRuntimeView(context.dataDirectory);
    if (!runs.some((run) => run.id === runId)) {
      sendJson(response, 404, { error: "The requested local session does not exist." });
      return;
    }
    await context.sessions.delete(runId);
    sendJson(response, 204, undefined);
    return;
  }

  const agentSettingMatch = url.pathname.match(/^\/api\/settings\/agents\/([^/]+)$/);
  if (request.method === "PATCH" && agentSettingMatch?.[1] !== undefined) {
    const body = await readJsonBody(request);
    const update: { enabled?: boolean; providerId?: "codex-cli" | "claude-code" | "pi" } = {};
    if (typeof body.enabled === "boolean") update.enabled = body.enabled;
    if (body.providerId === "codex-cli" || body.providerId === "claude-code" || body.providerId === "pi") update.providerId = body.providerId;
    if (Object.keys(update).length === 0) {
      sendJson(response, 400, { error: "An agent setting update needs an enabled boolean or providerId." });
      return;
    }
    try {
      sendJson(response, 200, await context.agentSettings.updateAgent(decodeURIComponent(agentSettingMatch[1]), update));
    } catch (error: unknown) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "The agent setting could not be updated." });
    }
    return;
  }

  const agentInstallMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/install$/);
  if (request.method === "POST" && agentInstallMatch?.[1] !== undefined) {
    const id = decodeURIComponent(agentInstallMatch[1]);
    if (id !== "codex-cli" && id !== "claude-code" && id !== "pi") {
      sendJson(response, 404, { error: "The requested local Agent is not supported." });
      return;
    }
    try {
      sendJson(response, 200, { provider: await context.agentRegistry.install(id) });
    } catch (error: unknown) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "The local Agent installation failed." });
    }
    return;
  }

  if (request.method === "PATCH" && url.pathname === "/api/memory/settings") {
    const body = await readJsonBody(request);
    const update: { enabled?: boolean; maxRecall?: number } = {};
    if (typeof body.enabled === "boolean") update.enabled = body.enabled;
    if (typeof body.maxRecall === "number") update.maxRecall = body.maxRecall;
    if (Object.keys(update).length === 0) {
      sendJson(response, 400, { error: "A Memory setting update needs enabled or maxRecall." });
      return;
    }
    try {
      sendJson(response, 200, { settings: await context.memoryStore.updateSettings(update) });
    } catch (error: unknown) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "The Memory setting could not be updated." });
    }
    return;
  }

  const memoryMatch = url.pathname.match(/^\/api\/memory\/([^/]+)$/);
  if (request.method === "PATCH" && memoryMatch?.[1] !== undefined) {
    const body = await readJsonBody(request);
    const update: { summary?: string; status?: "active" | "archived" } = {};
    if (typeof body.summary === "string") update.summary = body.summary;
    if (body.status === "active" || body.status === "archived") update.status = body.status;
    if (Object.keys(update).length === 0) {
      sendJson(response, 400, { error: "A memory update needs a summary or status." });
      return;
    }
    try {
      sendJson(response, 200, { memory: await context.memoryStore.update(decodeURIComponent(memoryMatch[1]), update) });
    } catch (error: unknown) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "The local memory could not be updated." });
    }
    return;
  }

  const approvalMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/approve$/);
  if (request.method === "POST" && approvalMatch?.[1] !== undefined) {
    const result = await approveDemoWorkflow(context.dataDirectory, decodeURIComponent(approvalMatch[1]), await context.agentSettings.get());
    await syncMemory(context.dataDirectory, context.memoryStore);
    sendJson(response, 200, result);
    return;
  }
  sendJson(response, 404, { error: "The local companion endpoint was not found." });
}

async function buildDashboard(dataDirectory: string, sessions: SessionStore): Promise<DashboardView> {
  const { events, state, tasks, runs } = await loadRuntimeView(dataDirectory);
  const deletedRunIds = await sessions.deletedRunIds();
  const visibleRuns = runs.filter((run) => !deletedRunIds.has(run.id));
  const visibleRunIds = new Set(visibleRuns.map((run) => run.id));

  const approvals = visibleRuns
    .filter((run) => run.status === "waiting_approval" && run.activeStepId !== undefined)
    .map((run) => ({
      runId: run.id,
      title: titleFor(run, tasks),
      stepId: run.activeStepId!,
      description: "The next step can affect an external system and needs your approval.",
    }));
  const active = visibleRuns
    .filter((run) => ["planning", "queued", "running", "verifying"].includes(run.status))
    .slice(0, 4)
    .map((run) => compactRun(run, tasks));
  const subagents = Object.values(state.subagents)
    .filter((subagent) => visibleRunIds.has(subagent.runId))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 8)
    .map((subagent) => ({
      runId: subagent.runId,
      title: subagent.title,
      agentId: subagent.agentId,
      role: subagent.role,
      status: subagent.status,
      summary: subagent.summary,
      updatedAt: subagent.updatedAt,
    }));
  const completed = visibleRuns
    .filter((run) => run.status === "completed")
    .slice(0, 4)
    .map((run) => ({ ...compactRun(run, tasks), evidenceCount: (state.evidenceByRun[run.id] ?? []).length }));
  const memories = events
    .filter((event) => event.type === "memory.candidate.proposed")
    .slice(-4)
    .reverse()
    .map((event) => {
      const payload = asRecord(event.payload);
      return {
        summary: typeof payload.summary === "string" ? payload.summary : "The system proposed a memory candidate.",
        confidence: typeof payload.confidence === "string" ? payload.confidence : "unknown",
      };
    });

  return {
    generatedAt: new Date().toISOString(),
    counts: { approvals: approvals.length, active: active.length, completed: visibleRuns.filter((run) => run.status === "completed").length },
    approvals,
    active,
    subagents,
    completed,
    memories,
    sessions: visibleRuns.slice(0, 40).map((run) => toSessionSummary(run, tasks)),
    timeline: events.slice(-12).reverse().map(toTimelineItem),
  };
}

async function buildSession(dataDirectory: string, runId: string, settings: { agents: Array<{ id: string; providerId: string }> }): Promise<SessionView> {
  const { events, state, tasks, runs } = await loadRuntimeView(dataDirectory);
  const run = runs.find((candidate) => candidate.id === runId);
  if (run === undefined) {
    throw new Error("The requested local session does not exist.");
  }

  const task = tasks[run.taskId];
  const trigger = events.find((event) => event.type === "trigger.received" && asRecord(event.payload).id === task?.triggerId);
  const query = typeof asRecord(trigger?.payload).summary === "string" ? String(asRecord(trigger?.payload).summary) : titleFor(run, tasks);
  const providerByRole = new Map(settings.agents.map((agent) => [agent.id, agent.providerId]));
  const subagents = Object.values(state.subagents)
    .filter((subagent) => subagent.runId === run.id)
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
    .map((subagent) => ({
      id: subagent.id,
      title: subagent.title,
      agentId: subagent.agentId,
      role: subagent.role,
      providerId: providerByRole.get(subagent.agentId) ?? "demo",
      status: subagent.status,
      summary: subagent.summary,
      updatedAt: subagent.updatedAt,
    }));
  const evidenceCount = (state.evidenceByRun[run.id] ?? []).length;
  const plan = run.planId === undefined ? undefined : state.plans[run.planId];
  const approvals = run.status === "waiting_approval" && run.activeStepId !== undefined
    ? [{ runId: run.id, stepId: run.activeStepId, description: "下一步会影响外部系统，需要你的确认。" }]
    : [];
  const runEvents = events.filter((event) => event.runId === run.id);
  const recalledMemories = runEvents
    .filter((event) => event.type === "memory.recalled")
    .flatMap((event) => {
      const payload = asRecord(event.payload);
      const memories = Array.isArray(payload.memories) ? payload.memories : [];
      return memories.map((memory) => asRecord(memory)).filter((memory) => typeof memory.summary === "string").map((memory) => ({
        id: String(memory.id ?? ""),
        summary: String(memory.summary),
        score: typeof memory.score === "number" ? memory.score : 0,
        matchedTerms: Array.isArray(memory.matchedTerms) ? memory.matchedTerms.filter((term): term is string => typeof term === "string") : [],
      }));
    });

  return {
    ...toSessionSummary(run, tasks),
    query,
    evidenceCount,
    plan: plan === undefined
      ? undefined
      : {
        summary: displayPlanSummary(plan.summary),
        steps: plan.steps.map((step) => ({
          id: step.id,
          title: displayPlanStepTitle(step.title),
          risk: step.risk,
          delegated: step.subagents !== undefined,
        })),
      },
    subagents,
    approvals,
    messages: buildConversation(run, query, subagents.length, evidenceCount, runEvents, recalledMemories.length),
    recalledMemories,
    activity: runEvents.slice(-16).reverse().map(toTimelineItem),
    trace: runEvents.map(toTraceItem),
  };
}

async function loadRuntimeView(dataDirectory: string) {
  const journal = new JsonlJournalStore(join(dataDirectory, "journal.jsonl"));
  const events = await journal.list();
  const state = replay(events);
  const tasks = state.tasks;
  const runs = Object.values(state.runs).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return { events, state, tasks, runs };
}

function toSessionSummary(run: Run, tasks: Record<string, Task>): SessionSummary {
  return {
    id: run.id,
    title: titleFor(run, tasks),
    status: run.status,
    updatedAt: run.updatedAt,
    preview: previewForStatus(run.status),
  };
}

function buildConversation(
  run: Run,
  query: string,
  subagentCount: number,
  evidenceCount: number,
  events: JournalEvent[],
  recalledMemoryCount: number,
): ConversationMessage[] {
  const messages: ConversationMessage[] = [{ id: `user-${run.id}`, role: "person", text: query, occurredAt: run.createdAt }];
  const plan = events.find((event) => event.type === "plan.created");
  if (plan !== undefined) {
    messages.push({
      id: `plan-${run.id}`,
      role: "clone",
      text: subagentCount > 0
        ? `我已把这件事拆成 ${subagentCount} 个可追踪的子任务，并会在每一步保留证据。`
        : "我已准备好一份有边界的执行计划，并会在关键动作前检查权限。",
      occurredAt: plan.occurredAt,
    });
  }

  if (recalledMemoryCount > 0) {
    messages.push({
      id: `memory-${run.id}`,
      role: "clone",
      text: `I used ${recalledMemoryCount} active local memory item${recalledMemoryCount === 1 ? "" : "s"} as context for this work.`,
      occurredAt: plan?.occurredAt ?? run.createdAt,
    });
  }

  if (run.status === "waiting_approval") {
    messages.push({
      id: `approval-${run.id}`,
      role: "clone",
      text: "准备工作已经完成。下一步会影响外部系统，我需要你确认后才会继续。",
      occurredAt: run.updatedAt,
      tone: "approval",
    });
  } else if (run.status === "completed") {
    messages.push({
      id: `complete-${run.id}`,
      role: "clone",
      text: `已完成并验证结果${evidenceCount > 0 ? `，附有 ${evidenceCount} 条证据` : ""}。你可以在下方查看执行记录。`,
      occurredAt: run.updatedAt,
      tone: "success",
    });
  } else if (run.status === "failed" || run.status === "cancelled") {
    messages.push({
      id: `blocked-${run.id}`,
      role: "clone",
      text: "这条工作暂时没有安全地完成。我保留了当前进度和原因，等待你决定下一步。",
      occurredAt: run.updatedAt,
      tone: "warning",
    });
  } else {
    messages.push({
      id: `progress-${run.id}`,
      role: "clone",
      text: "我正在按计划推进，并持续检查权限、证据和可恢复性。",
      occurredAt: run.updatedAt,
    });
  }
  return messages;
}

function previewForStatus(status: Run["status"]): string {
  if (status === "waiting_approval") return "等待你的确认";
  if (status === "completed") return "已完成并验证";
  if (status === "failed" || status === "cancelled") return "需要处理";
  return "正在推进";
}

function compactRun(run: Run, tasks: Record<string, Task>): { runId: string; title: string; status: string; updatedAt: string } {
  return { runId: run.id, title: titleFor(run, tasks), status: run.status, updatedAt: run.updatedAt };
}

function titleFor(run: Run, tasks: Record<string, Task>): string {
  return tasks[run.taskId]?.title ?? "Unnamed work";
}

function displayPlanSummary(summary: string): string {
  return summary === "Prepare with parallel child agents, review their evidence, then wait before an external action."
    ? "旧版演示会先在本地准备，再在外部动作前等待你的确认。"
    : summary;
}

function displayPlanStepTitle(title: string): string {
  const legacyTitles: Record<string, string> = {
    "Prepare the work safely": "在本地准备结果",
    "Perform the external action": "执行外部操作",
  };
  return legacyTitles[title] ?? title;
}

function toScheduleView(schedule: LocalSchedule): ScheduleView {
  return {
    id: schedule.id,
    query: schedule.query,
    kind: schedule.kind,
    time: schedule.time,
    weekdays: schedule.weekdays,
    dayOfMonth: schedule.dayOfMonth,
    month: schedule.month,
    cron: schedule.cron,
    intervalMinutes: schedule.intervalMinutes,
    description: describeSchedule(schedule),
    enabled: schedule.enabled,
    lastRunKey: schedule.lastRunKey,
  };
}

function isScheduleKind(value: unknown): value is ScheduleKind {
  return value === "daily" || value === "weekly" || value === "monthly" || value === "yearly" || value === "cron" || value === "interval";
}

function toTraceItem(event: JournalEvent): TraceItem {
  return { ...toTimelineItem(event), sequence: event.sequence, type: event.type };
}

function toTimelineItem(event: JournalEvent): { label: string; detail: string; occurredAt: string } {
  const payload = asRecord(event.payload);
  const labels: Partial<Record<JournalEvent["type"], string>> = {
    "trigger.received": "Received a trigger",
    "task.created": "Created work",
    "run.created": "Started a run",
    "run.status_changed": "Updated run status",
    "plan.created": "Prepared a plan",
    "policy.decided": "Checked authority",
    "approval.granted": "Recorded your approval",
    "execution.started": "Started a step",
    "execution.progress": "Execution progress",
    "subagent.dispatched": "Dispatched a child agent",
    "subagent.progress": "Child-agent progress",
    "subagent.completed": "Child agent returned evidence",
    "subagent.failed": "Child agent failed",
    "evidence.recorded": "Recorded evidence",
    "verification.completed": "Verified the result",
    "memory.candidate.requested": "Queued memory review",
    "memory.candidate.proposed": "Proposed memory candidate",
    "memory.recalled": "Recalled local memory",
  };
  return { label: labels[event.type] ?? event.type, detail: detailFor(event.type, payload), occurredAt: event.occurredAt };
}

function detailFor(type: JournalEvent["type"], payload: Record<string, unknown>): string {
  if ((type === "execution.progress" || type === "subagent.progress") && typeof payload.message === "string") {
    return payload.message;
  }
  if (type === "policy.decided") {
    const decision = asRecord(payload.decision);
    return decision.outcome === "approval_required"
      ? "An external action needs your approval."
      : decision.outcome === "allowed"
        ? "This local, reversible step may continue."
        : "The current policy did not allow this step.";
  }
  if (type === "verification.completed") {
    return typeof payload.summary === "string" ? payload.summary : "Recorded the verification result.";
  }
  if (type === "memory.recalled") {
    const memories = Array.isArray(payload.memories) ? payload.memories : [];
    return `Used ${memories.length} active local memory item${memories.length === 1 ? "" : "s"} as task context.`;
  }
  if (typeof payload.summary === "string") {
    return payload.summary;
  }
  if (typeof payload.title === "string") {
    return payload.title;
  }
  return "Recorded in the local journal.";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

async function syncMemory(dataDirectory: string, memoryStore: LocalMemoryStore): Promise<void> {
  const journal = new JsonlJournalStore(join(dataDirectory, "journal.jsonl"));
  const candidates = (await journal.list())
    .filter((event) => event.type === "memory.candidate.proposed")
    .map((event) => event.payload as MemoryCandidate);
  await memoryStore.sync(candidates);
}

async function buildMemoryView(memoryStore: LocalMemoryStore) {
  const [memories, settings] = await Promise.all([memoryStore.list(), memoryStore.settings()]);
  const active = memories.filter((memory) => memory.status === "active");
  return {
    memories,
    settings,
    stats: {
      total: memories.length,
      active: active.length,
      archived: memories.length - active.length,
      recallCount: memories.reduce((total, memory) => total + memory.useCount, 0),
      used: memories.filter((memory) => memory.useCount > 0).length,
    },
  };
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > 32_000) {
      throw new Error("The local request body is too large.");
    }
  }
  return body.length === 0 ? {} : asRecord(JSON.parse(body) as unknown);
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
}

function parsePort(value: string | undefined, fallback: number): number {
  const port = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("CLONE_AI_PORT must be a TCP port between 0 and 65535.");
  }
  return port;
}

interface DashboardView {
  generatedAt: string;
  counts: { approvals: number; active: number; completed: number };
  approvals: Array<{ runId: string; title: string; stepId: string; description: string }>;
  active: Array<{ runId: string; title: string; status: string; updatedAt: string }>;
  subagents: Array<{ runId: string; title: string; agentId: string; role: string; status: string; summary?: string; updatedAt: string }>;
  completed: Array<{ runId: string; title: string; status: string; updatedAt: string; evidenceCount: number }>;
  memories: Array<{ summary: string; confidence: string }>;
  sessions: SessionSummary[];
  timeline: Array<{ label: string; detail: string; occurredAt: string }>;
}

interface SessionSummary {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
  preview: string;
}

interface ConversationMessage {
  id: string;
  role: "person" | "clone";
  text: string;
  occurredAt: string;
  tone?: "approval" | "success" | "warning";
}

interface SessionView extends SessionSummary {
  query: string;
  evidenceCount: number;
  plan?: {
    summary: string;
    steps: Array<{ id: string; title: string; risk: string; delegated: boolean }>;
  };
  subagents: Array<{ id: string; title: string; agentId: string; role: string; providerId: string; status: string; summary?: string; updatedAt: string }>;
  approvals: Array<{ runId: string; stepId: string; description: string }>;
  messages: ConversationMessage[];
  recalledMemories: Array<{ id: string; summary: string; score: number; matchedTerms: string[] }>;
  activity: Array<{ label: string; detail: string; occurredAt: string }>;
  trace: TraceItem[];
}

interface TraceItem {
  sequence: number;
  type: string;
  label: string;
  detail: string;
  occurredAt: string;
}

interface ScheduleView {
  id: string;
  query: string;
  kind: ScheduleKind;
  time?: string;
  weekdays?: number[];
  dayOfMonth?: number;
  month?: number;
  cron?: string;
  intervalMinutes?: number;
  description: string;
  enabled: boolean;
  lastRunKey?: string;
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/companion-server.ts") === true) {
  void startCompanionServer()
    .then((companion) => console.log(`clone-ai desktop companion preview: ${companion.url}`))
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
