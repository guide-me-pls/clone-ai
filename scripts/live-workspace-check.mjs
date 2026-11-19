#!/usr/bin/env node
/**
 * Live Main Agent / workspace check — a maintenance eval, not a product CLI.
 *
 * Starts an isolated companion (temp clone home; temp workspace unless
 * CLONE_AI_LIVE_WORKSPACE is set), asks the configured model one question, and
 * prints the reply plus every run the turn dispatched and how each settled.
 * Two properties are under test: a project outside the workspace must be
 * reported rather than reviewed, and a read-only request must produce one
 * read-only step, not a draft work order with an artifact contract.
 *
 * Usage:
 *   CLONE_AI_NATIVE_MODEL=... CLONE_AI_NATIVE_BASE_URL=... \
 *     node --experimental-strip-types scripts/live-workspace-check.mjs
 *   CLONE_AI_LIVE_WORKSPACE=/path/to/project CLONE_AI_LIVE_TEXT='只读取 README.md…' \
 *     CLONE_AI_NATIVE_MODEL=... CLONE_AI_NATIVE_BASE_URL=... \
 *     node --experimental-strip-types scripts/live-workspace-check.mjs
 *
 * 主 Agent / 工作区的 live 检查——维护用 eval，不是产品 CLI。
 *
 * 启动一个隔离的 companion（临时 clone home；未设置 CLONE_AI_LIVE_WORKSPACE 时使用临时
 * 工作区），向配置的模型问一个问题，并打印回复、本回合派发的每个 Run 及其最终状态。
 * 被测的两条性质：工作区之外的项目必须如实报告，而不是被审查；只读请求必须产生一个只读
 * 步骤，而不是带工件契约的 draft 工作单。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startCompanionServer } from "../src/companion-server.ts";

const text = process.env.CLONE_AI_LIVE_TEXT
  ?? "看一下knowledge-base这个项目，看一下rag项目有什么优化的空间";
const overrideWorkspace = process.env.CLONE_AI_LIVE_WORKSPACE?.trim();
const dataDirectory = await mkdtemp(join(tmpdir(), "clone-live-workspace-home-"));
const workspacePath = overrideWorkspace ?? await mkdtemp(join(tmpdir(), "clone-live-workspace-ws-"));
const server = await startCompanionServer({ port: 0, dataDirectory, workspacePath });

const terminal = new Set(["completed", "failed", "cancelled", "waiting_review", "waiting_approval"]);

async function settle(runId) {
  let view;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const response = await fetch(`${server.url}/api/sessions/${encodeURIComponent(runId)}`, {
      headers: { authorization: `Bearer ${server.token}` },
    });
    view = await response.json();
    if (terminal.has(view.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return {
    id: runId,
    status: view?.status,
    plan: view?.plan?.steps?.map((step) => ({
      id: step.id,
      title: step.title,
      agentId: step.agentId,
      delegated: step.delegated,
      risk: step.risk,
    })),
    messages: (view?.messages ?? []).map((message) => String(message.text ?? "").slice(0, 240)),
    evidence: (view?.evidence ?? []).map((item) => item.locator),
    trace: (view?.trace ?? []).slice(-12).map((item) => `${item.label}: ${String(item.detail ?? "").slice(0, 200)}`),
  };
}

try {
  const response = await fetch(`${server.url}/api/main-agent/query`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${server.token}` },
    body: JSON.stringify({ text }),
  });
  const body = await response.json();
  const runs = [];
  for (const run of body.newRuns ?? []) runs.push(await settle(run.id));
  console.log(JSON.stringify({
    status: response.status,
    workspacePath,
    model: process.env.CLONE_AI_NATIVE_MODEL,
    baseUrl: process.env.CLONE_AI_NATIVE_BASE_URL,
    reply: body.reply,
    error: body.error,
    newRuns: runs,
  }, null, 2));
} finally {
  await server.close();
  await rm(dataDirectory, { recursive: true, force: true });
  if (overrideWorkspace === undefined) await rm(workspacePath, { recursive: true, force: true });
}