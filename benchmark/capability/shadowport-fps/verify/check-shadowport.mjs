#!/usr/bin/env node
/**
 * Supervisor-side checker for the Shadowport one-query FPS benchmark.
 *
 * It does not trust the workspace's own report. It serves the workspace on
 * loopback, loads it in headless Chrome, drives the public `window.__game`
 * hook, and records what actually happened: movement, a shot that removes
 * enemy health, all three relays, extraction, the debrief, console errors and
 * external requests.
 *
 * Usage:
 *   node check-shadowport.mjs --workspace DIR --out DIR [--port 8140]
 *
 * Requires playwright-core. It is resolved from CLONE_AI_VERIFY_DEPS when set,
 * then from the repository's eval verification node_modules.
 *
 * 供 Shadowport 一次性 FPS 评测使用的主管侧检查器。
 * 不信任工作区自己的报告：在环回上启动静态服务器，用无头 Chrome 加载，驱动公开的
 * `window.__game` 钩子，记录实际发生的事：移动、射击扣血、三处中继、撤离、结算、
 * 控制台错误与外部请求。
 */
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};
const workspace = resolve(flag("workspace", "."));
const outDir = resolve(flag("out", join(here, "out")));
const port = Number(flag("port", "8140"));
const expected = JSON.parse(await readFile(join(here, "..", "expected.json"), "utf8"));
await mkdir(outDir, { recursive: true });

function loadPlaywright() {
  const bases = [];
  if (process.env.CLONE_AI_VERIFY_DEPS) bases.push(join(process.env.CLONE_AI_VERIFY_DEPS, "package.json"));
  bases.push(join(process.env.HOME ?? "", "study/clone-ai/eval-runs/2026-11-17-capability/verify/package.json"));
  bases.push(join(here, "package.json"));
  const errors = [];
  for (const base of bases) {
    try {
      return createRequire(base)("playwright-core");
    } catch (error) {
      errors.push(`${base}: ${error.message.split("\n")[0]}`);
    }
  }
  throw new Error(`cannot resolve playwright-core:\n${errors.join("\n")}`);
}

const checks = [];
function record(id, ok, detail = "") {
  checks.push({ id, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}${detail ? ` — ${detail}` : ""}`);
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function startServer(root, listenPort) {
  const types = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg",
    ".svg": "image/svg+xml", ".wasm": "application/wasm", ".woff2": "font/woff2",
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith("/")) pathname += "index.html";
      if (pathname.includes("\0") || pathname.split("/").some((part) => part === "..")) {
        response.writeHead(403).end();
        return;
      }
      const target = normalize(join(root, pathname));
      if (!(target === root || target.startsWith(root.endsWith(sep) ? root : root + sep))) {
        response.writeHead(403).end();
        return;
      }
      const info = await stat(target);
      if (!info.isFile()) { response.writeHead(404).end(); return; }
      const body = await readFile(target);
      response.writeHead(200, {
        "content-type": types[extname(target).toLowerCase()] ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(listenPort, "127.0.0.1", resolvePromise);
  });
  return server;
}

const { chromium } = loadPlaywright();
const server = await startServer(workspace, port);
let browser;
try {
  for (const rel of expected.requiredFiles) {
    record(`file.${rel}`, await exists(join(workspace, rel)), rel);
  }
  const indexHtml = await readFile(join(workspace, "index.html"), "utf8").catch(() => "");
  record("classic-script", !/\btype\s*=\s*["']module["']/.test(indexHtml) && /<script\b/i.test(indexHtml), "no ES module entry");
  record("local-three", /vendor\/three\.iife\.js/.test(indexHtml), "global THREE from the workspace");

  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--use-gl=angle", "--use-angle=metal", "--enable-webgl", "--ignore-gpu-blocklist"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  const external = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("request", (request) => {
    const url = request.url();
    if (!url.startsWith(`http://127.0.0.1:${port}`) && !url.startsWith("data:") && !url.startsWith("blob:")) external.push(url);
  });

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForFunction(() => window.__game !== undefined, null, { timeout: 30_000 }).catch(() => undefined);
  const hook = await page.evaluate(() => {
    const g = window.__game;
    return g === undefined ? null : {
      keys: Object.keys(g),
      hasPlayer: g.player !== undefined && g.player.position !== undefined,
      hasState: g.state !== undefined && typeof g.state.phase === "string",
    };
  });
  record("hook", hook !== null && expected.requiredHooks.every((key) => hook.keys.includes(key)), hook === null ? "window.__game missing" : hook.keys.join(","));

  const start = await page.evaluate(async () => {
    const g = window.__game;
    const button = document.getElementById("start");
    if (button !== null) button.click(); else g.begin();
    await new Promise((r) => setTimeout(r, 700));
    return {
      phase: g.state.phase,
      health: g.player.health,
      ammo: g.player.ammo,
      enemies: g.enemies.filter((enemy) => enemy.alive).length,
      relays: g.relays.length,
      x: g.player.position.x,
      z: g.player.position.z,
    };
  });
  record("start", start.phase === "playing" && start.health > 0 && start.ammo > 0, JSON.stringify(start));
  record("enemies", start.enemies >= expected.minimumEnemies, `${start.enemies} alive`);
  record("relays", start.relays === expected.relayCount, `${start.relays} relays`);

  await page.keyboard.down("KeyW");
  await page.waitForTimeout(650);
  await page.keyboard.up("KeyW");
  const moved = await page.evaluate(() => {
    const g = window.__game;
    return { x: g.player.position.x, z: g.player.position.z };
  });
  record("movement", Math.hypot(moved.x - start.x, moved.z - start.z) > 0.2, `moved ${Math.hypot(moved.x - start.x, moved.z - start.z).toFixed(2)} m`);

  const combat = await page.evaluate(async () => {
    const g = window.__game;
    const enemy = g.enemies.find((candidate) => candidate.alive);
    if (enemy === undefined) return { fired: false, reason: "no enemy" };
    g.player.position.set(enemy.position.x, 0, enemy.position.z + 8);
    g.player.yaw = 0;
    g.player.pitch = 0;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const before = { hp: enemy.health, ammo: g.player.ammo };
    const fired = g.fire();
    await new Promise((r) => setTimeout(r, 120));
    return { fired, before, after: { hp: enemy.health, ammo: g.player.ammo } };
  });
  record("shot", combat.fired === true && combat.after?.ammo === combat.before?.ammo - 1, JSON.stringify(combat));
  record("damage", combat.after?.hp < combat.before?.hp, `${combat.before?.hp} -> ${combat.after?.hp}`);

  const mission = await page.evaluate(async () => {
    const g = window.__game;
    const cuts = [];
    for (const relay of g.relays) {
      g.player.position.set(relay.position.x, 0, relay.position.z);
      await new Promise((r) => setTimeout(r, 80));
      g.interact();
      cuts.push(relay.cut);
    }
    const extraction = g.state.extraction;
    g.player.position.set(extraction.x, 0, extraction.z);
    await new Promise((r) => setTimeout(r, 120));
    const interacted = g.interact();
    await new Promise((r) => setTimeout(r, 250));
    return {
      cuts,
      interacted,
      phase: g.state.phase,
      endVisible: document.getElementById("end") !== null && !document.getElementById("end").classList.contains("hidden"),
    };
  });
  record("relays-cut", mission.cuts.every(Boolean), JSON.stringify(mission.cuts));
  record("extraction", mission.interacted === true && mission.phase === "ended", `phase=${mission.phase}`);
  record("debrief", mission.endVisible === true, "end screen visible");

  const shotPath = join(outDir, "shadowport.png");
  await page.screenshot({ path: shotPath });
  record("console", errors.length <= expected.maxConsoleErrors, `${errors.length} error(s)`);
  record("external-requests", expected.allowExternalRequests || external.length === 0, external.slice(0, 5).join(" "));

  const report = {
    benchmark: "shadowport-fps",
    workspace,
    port,
    at: new Date().toISOString(),
    checks,
    passed: checks.every((check) => check.ok),
    screenshot: shotPath,
    errors,
    externalRequests: external,
  };
  await writeFile(join(outDir, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(join(outDir, "report.txt"), checks.map((check) => `${check.ok ? "PASS" : "FAIL"} ${check.id}${check.detail ? ` — ${check.detail}` : ""}`).join("\n"));
  console.log(`\n${report.passed ? "PASS" : "FAIL"}  ${checks.filter((check) => check.ok).length}/${checks.length} checks`);
  process.exitCode = report.passed ? 0 : 1;
} finally {
  if (browser !== undefined) await browser.close().catch(() => undefined);
  await new Promise((resolvePromise) => server.close(() => resolvePromise(undefined)));
}
