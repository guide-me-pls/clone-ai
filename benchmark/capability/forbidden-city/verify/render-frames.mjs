#!/usr/bin/env node
// Frames + video for the Forbidden City benchmark, rendered with the installed
// Google Chrome. This is the supervisor's substitute when a workspace's own
// render.mjs depends on a browser download the machine cannot perform; it uses
// exactly the page's window.setVideoTime contract.
//
// Usage: node render-frames.mjs --url URL --out DIR [--frames 900] [--fps 30]
//                               [--width 1920] [--height 1080]
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";

const requireFromHere = createRequire(import.meta.url);
const resolveDep = (name) => {
  const bases = [import.meta.url];
  if (process.env.CLONE_AI_VERIFY_DEPS) bases.push(join(process.env.CLONE_AI_VERIFY_DEPS, "package.json"));
  bases.push(join(process.env.HOME ?? "", "study/clone-ai/eval-runs/2026-11-17-capability/verify/package.json"));
  const errors = [];
  for (const base of bases) {
    try {
      return createRequire(base)(name);
    } catch (error) {
      errors.push(`${base}: ${error.message.split("\n")[0]}`);
    }
  }
  throw new Error(`cannot resolve ${name}:\n${errors.join("\n")}`);
};
const { chromium } = resolveDep("playwright-core");
const ffmpeg = resolveDep("ffmpeg-static");

const args = process.argv.slice(2);
const get = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const url = get("url");
const out = resolve(get("out", "render-out"));
const frames = Number(get("frames", "900"));
const fps = Number(get("fps", "30"));
const width = Number(get("width", "1920"));
const height = Number(get("height", "1080"));
if (!url) {
  console.error("usage: node render-frames.mjs --url URL --out DIR [--frames 900]");
  process.exit(1);
}
// If the caller points at a local page and nothing is listening there, serve
// the workspace itself: the frame renderer is often run after the checker's
// server has exited.
const target = new URL(url);
let localServer;
if (target.hostname === "127.0.0.1" || target.hostname === "localhost") {
  const up = await new Promise((resolveUp) => {
    const probe = new URL(url);
    const socket = createConnection(Number(probe.port || 80), probe.hostname, () => {
      socket.end();
      resolveUp(true);
    });
    socket.on("error", () => resolveUp(false));
  });
  if (!up) {
    const root = resolve(get("root", process.cwd()));
    localServer = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "serve.mjs"), root, target.port || "8130"], { stdio: ["ignore", "inherit", "inherit"] });
    await new Promise((r) => setTimeout(r, 600));
  }
}
await mkdir(out, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), "forbidden-city-"));
console.log(`rendering ${frames} frames at ${width}x${height} into ${out} (temp ${temp})`);

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--use-gl=angle", "--use-angle=metal", "--enable-webgl", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/favicon\.ico/.test(m.text())) errors.push(m.text()); });
await page.goto(url, { waitUntil: "networkidle", timeout: 120_000 });
await page.waitForFunction(() => window.videoReady === true && typeof window.setVideoTime === "function", null, { timeout: 120_000 });
// Common control chrome across the tasks' pages; a workspace that hides its own
// controls via ?capture=1 needs none of this.
await page.addStyleTag({
  content: [
    "#controls,.controls,#status,#hud,.hud{display:none!important}",
    "body{overflow:hidden!important}",
  ].join(""),
});

const started = Date.now();
for (let frame = 0; frame < frames; frame += 1) {
  const t = frame / fps;
  const actual = await page.evaluate(async (time) => {
    const rendered = window.setVideoTime(time);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return rendered;
  }, t);
  if (actual !== t) throw new Error(`seek ${t} returned ${actual}`);
  await page.screenshot({ path: join(temp, `${String(frame).padStart(6, "0")}.png`), type: "png", animations: "disabled", timeout: 30_000 });
  if (frame % 100 === 0) {
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`frame ${frame}/${frames} t=${t.toFixed(2)}s elapsed=${elapsed}s`);
  }
}
if (errors.length > 0) console.log(`page errors (${errors.length}): ${errors.slice(0, 5).join(" | ")}`);
const video = join(out, "video.mp4");
const child = spawn(ffmpeg, [
  "-hide_banner", "-loglevel", "error", "-y", "-framerate", String(fps),
  "-start_number", "0", "-i", join(temp, "%06d.png"),
  "-frames:v", String(frames), "-c:v", "libx264", "-pix_fmt", "yuv420p",
  "-r", String(fps), video,
], { stdio: "inherit" });
const code = await new Promise((r) => child.on("close", r));
await browser.close();
await rm(temp, { recursive: true, force: true });
if (localServer) localServer.kill("SIGTERM");
if (code !== 0) {
  console.error(`ffmpeg exited ${code}`);
  process.exit(1);
}
console.log(`wrote ${video} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
