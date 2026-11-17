#!/usr/bin/env node
// Supervisor-side checker for the Forbidden City 3D benchmark.
//
// It does not trust the workspace's own report: it loads the page in headless
// Chrome, reads the model window.getForbiddenCityModel() built, compares it
// with the sourced architectural expectations in expected.json, runs the
// workspace tests, and writes report.json / report.txt next to the evidence.
//
// Usage:
//   node check-forbidden-city.mjs --workspace DIR --out DIR [--port 8130]
//        [--frames 900] [--render]
//
// Requires playwright-core and ffmpeg-static. They are resolved from the
// caller's node_modules first, then from CLONE_AI_VERIFY_DEPS when set.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);
const workspace = resolve(flag("workspace", "."));
const outDir = resolve(flag("out", join(here, "out")));
const port = Number(flag("port", "8130"));
const renderFrames = Number(flag("frames", "900"));
const shouldRender = has("render");
const expected = JSON.parse(await readFile(join(here, "expected.json"), "utf8"));

function loadRequire() {
  const bases = [join(here, "package.json")];
  if (process.env.CLONE_AI_VERIFY_DEPS) bases.push(join(process.env.CLONE_AI_VERIFY_DEPS, "package.json"));
  bases.push(join(process.env.HOME ?? "", "study/clone-ai/eval-runs/2026-11-17-capability/verify/package.json"));
  const errors = [];
  for (const base of bases) {
    try {
      const req = createRequire(base);
      return { req, playwright: req("playwright-core"), ffmpeg: req("ffmpeg-static") };
    } catch (error) {
      errors.push(`${base}: ${error.message.split("\n")[0]}`);
    }
  }
  throw new Error(`cannot resolve playwright-core/ffmpeg-static:\n${errors.join("\n")}`);
}

const checks = [];
/** Phase prefix so one report can hold the baseline and the re-run side by side. */
const phasePrefix = (flag("phase", "") || "").trim();
function record(id, ok, detail) {
  const qualified = phasePrefix === "" ? id : `${phasePrefix}.${id}`;
  checks.push({ id: qualified, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${qualified}${detail ? ` — ${detail}` : ""}`);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function run(command, args, options = {}) {
  return await new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd: options.cwd ?? workspace, env: process.env, ...options.spawn });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => { stdout += String(d); });
    child.stderr?.on("data", (d) => { stderr += String(d); });
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 600_000);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}

await mkdir(outDir, { recursive: true });
await rm(join(outDir, "screens"), { recursive: true, force: true });
await mkdir(join(outDir, "screens"), { recursive: true });

/* ---------------------------------------------------------------- static */

const required = expected.requiredFiles;
const fileState = {};
for (const rel of required) {
  const path = join(workspace, rel);
  const present = await exists(path);
  let bytes = 0;
  if (present) bytes = (await readFile(path)).byteLength;
  fileState[rel] = { present, bytes };
}
const missing = required.filter((rel) => !fileState[rel].present || fileState[rel].bytes === 0);
record("files.required", missing.length === 0, missing.length ? `missing/empty: ${missing.join(", ")}` : `${required.length}/${required.length} present and non-empty`);

let srcFiles = [];
const srcDir = join(workspace, "src");
if (await exists(srcDir)) {
  srcFiles = (await readdir(srcDir, { recursive: true })).filter((name) => name.endsWith(".js") || name.endsWith(".mjs"));
}
record("src.modules", srcFiles.length >= expected.minimumSrcModules, `${srcFiles.length} module(s) under src/ (need >= ${expected.minimumSrcModules})`);

const sourceBlob = await (async () => {
  const parts = [];
  for (const rel of srcFiles) parts.push(await readFile(join(srcDir, rel), "utf8"));
  for (const rel of ["index.html", "main.js"]) {
    const path = join(workspace, rel);
    if (await exists(path)) parts.push(await readFile(path, "utf8"));
  }
  return parts.join("\n---\n");
})();
const unseededRandom = [...sourceBlob.matchAll(/Math\.random\s*\(/g)].length;
record("determinism.no-unseeded-random", unseededRandom === 0, unseededRandom === 0 ? "no Math.random() call found" : `${unseededRandom} Math.random() call(s)`);

const htmlPath = join(workspace, "index.html");
if (await exists(htmlPath)) {
  const html = await readFile(htmlPath, "utf8");
  const usesVendor = /vendor\/three\.module\.js/.test(html);
  const hasImportMap = /type=["']importmap["']/.test(html);
  // The benchmark seeds vendor/three.module.js; a page that resolves `three`
  // anywhere else would need a network install the worker cannot perform.
  const threeTarget = html.match(/"three"\s*:\s*"([^"]+)"/)?.[1] ?? "";
  const resolvesLocally = /three\.module\.js/.test(threeTarget) && !/^https?:/.test(threeTarget);
  record("html.three-import", usesVendor && hasImportMap && resolvesLocally, `importmap=${hasImportMap} three→${threeTarget || "missing"}`);
  record("html.external-assets", !/(https?:)?\/\/(?!127\.0\.0\.1|localhost)/.test(html.replace(/<!--[\s\S]*?-->/g, "")), "no absolute http(s) asset reference");
}

const renderPath = join(workspace, "render.mjs");
let renderState = { checked: false };
if (await exists(renderPath)) {
  const syntax = await run(process.execPath, ["--check", renderPath], { timeoutMs: 30_000 });
  const text = await readFile(renderPath, "utf8");
  const frames = /\b900\b/.test(text);
  const ffmpeg = /ffmpeg/.test(text);
  const h264 = /libx264|h264/.test(text);
  const clearErrors = /catch|try\s*\{|process\.exit\(1\)/.test(text);
  renderState = { syntax: syntax.code === 0, frames, ffmpeg, h264, clearErrors };
  record("render.script-static", syntax.code === 0 && frames && ffmpeg && h264,
    `syntax=${syntax.code === 0} frames900=${frames} ffmpeg=${ffmpeg} h264=${h264} errors=${clearErrors}`);
}

/* --------------------------------------------------------------- tests */

const testFiles = [];
const testsDir = join(workspace, "tests");
if (await exists(testsDir)) {
  for (const entry of await readdir(testsDir, { recursive: true })) {
    if (entry.endsWith(".test.mjs") || entry.endsWith(".test.js")) testFiles.push(join(testsDir, entry));
  }
}
let testState = { files: 0, code: null, pass: 0, fail: 0, output: "" };
if (testFiles.length > 0) {
  const result = await run(process.execPath, ["--test", ...testFiles], { timeoutMs: 180_000 });
  const text = result.stdout + result.stderr;
  const pass = Number(text.match(/(?:^|\s)(?:ℹ\s*)?#?\s*pass (\d+)/m)?.[1] ?? 0);
  const fail = Number(text.match(/(?:^|\s)(?:ℹ\s*)?#?\s*fail (\d+)/m)?.[1] ?? 0);
  testState = { files: testFiles.length, code: result.code, pass, fail, output: (result.stdout + result.stderr).slice(-8000) };
}
record("tests.run", testState.code === 0 && testState.fail === 0, testState.files === 0 ? "no test files found" : `${testState.pass} pass, ${testState.fail} fail (${testState.files} file(s))`);
await writeFile(join(outDir, "tests.txt"), testState.output || "(no tests)\n");

/* -------------------------------------------------------------- browser */

const deps = loadRequire();
const server = spawn(process.execPath, [join(here, "serve.mjs"), workspace, String(port)], { stdio: ["ignore", "pipe", "pipe"] });
const serverLog = [];
server.stdout.on("data", (d) => serverLog.push(String(d)));
server.stderr.on("data", (d) => serverLog.push(String(d)));
await new Promise((r) => setTimeout(r, 600));

const browser = await deps.playwright.chromium.launch({
  executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--use-gl=angle", "--use-angle=metal", "--enable-webgl", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const pageErrors = [];
const consoleErrors = [];
// A "Failed to load resource" console line does not name the URL, so the URL is
// recovered from the response events and matched there instead.
const failedResponses = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("response", (r) => { if (r.status() >= 400) failedResponses.push(`${r.status()} ${r.url()}`); });
const relevantConsole = () => consoleErrors.filter((line) => !/favicon\.ico/.test(line) && !/Failed to load resource/.test(line));
const relevantResponses = () => failedResponses.filter((line) => !/favicon\.ico/.test(line));

let model = null;
let videoChecks = null;
let cameraTelemetry = null;
let roofTable = [];
const screenshots = [];
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle", timeout: 120_000 });
  await page.waitForFunction(() => window.videoReady === true && typeof window.setVideoTime === "function", null, { timeout: 120_000 });
  record("browser.ready", true, "videoReady && setVideoTime");
  record("browser.no-uncaught-error", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | ") || "none");

  model = await page.evaluate(() => (typeof window.getForbiddenCityModel === "function" ? window.getForbiddenCityModel() : null));
  videoChecks = await page.evaluate(() => (typeof window.getForbiddenCityChecks === "function" ? window.getForbiddenCityChecks() : null));
  record("api.model", model && Array.isArray(model.buildings), model ? `${model.buildings?.length ?? 0} buildings` : "getForbiddenCityModel() missing");
  record("api.checks", videoChecks && typeof videoChecks === "object", videoChecks ? "getForbiddenCityChecks() present" : "getForbiddenCityChecks() missing");

  if (model?.buildings) {
    const byName = new Map(model.buildings.map((b) => [b.name, b]));
    const roofMismatches = [];
    for (const [name, roof] of Object.entries(expected.roofTypes)) {
      const building = byName.get(name);
      if (!building) roofMismatches.push(`${name}: absent`);
      else if (building.roofType !== roof) roofMismatches.push(`${name}: ${building.roofType} != ${roof}`);
    }
    record("model.roof-types", roofMismatches.length === 0, roofMismatches.length ? roofMismatches.join("; ") : `${Object.keys(expected.roofTypes).length} named roofs match`);
    // A single line per named hall, so a reader can see what was modeled even
    // when the roof check fails; the pass/fail above stays the hard verdict.
    roofTable = Object.entries(expected.roofTypes).map(([name, roof]) => {
      const b = byName.get(name);
      return `${name}\t${b?.roofType ?? "absent"}\t${b?.roofType === roof ? "ok" : `expected ${roof}`}`;
    });

    const axisTolerance = expected.axisToleranceM;
    const offAxis = model.buildings
      .filter((b) => expected.axisBuildings.includes(b.name))
      .filter((b) => Math.abs(b.position?.x ?? 1e9) > axisTolerance)
      .map((b) => `${b.name}@x=${b.position?.x}`);
    const presentAxis = expected.axisBuildings.filter((name) => byName.has(name));
    record("model.axis", offAxis.length === 0 && presentAxis.length === expected.axisBuildings.length,
      offAxis.length ? `off axis: ${offAxis.join(", ")}` : `${presentAxis.length}/${expected.axisBuildings.length} axis buildings within ±${axisTolerance} m`);

    const halls = expected.threeHalls.map((name) => byName.get(name)).filter(Boolean);
    const platformIds = new Set(halls.map((b) => b.platformId).filter(Boolean));
    record("model.three-platform", halls.length === expected.threeHalls.length && platformIds.size === 1,
      `${halls.length}/${expected.threeHalls.length} halls, platformIds=${[...platformIds].join(",") || "none"}`);

    const taihe = byName.get("太和殿");
    const size = expected.taiheHall;
    if (taihe) {
      const w = taihe.footprint?.widthM ?? 0;
      const d = taihe.footprint?.depthM ?? 0;
      const h = taihe.heightM ?? 0;
      const within = (value, target) => Math.abs(value - target) / target <= expected.sizeTolerance;
      const ok = within(w, size.widthM) && within(d, size.depthM) && within(h, size.heightM);
      record("model.taihe-dimensions", ok, `${w}×${d}×${h} m vs ${size.widthM}×${size.depthM}×${size.heightM} (±${expected.sizeTolerance * 100}%)`);
    } else {
      record("model.taihe-dimensions", false, "太和殿 absent");
    }

    const pairs = expected.symmetryPairs;
    const symmetryErrors = [];
    for (const [left, right] of pairs) {
      const a = byName.get(left);
      const b = byName.get(right);
      if (!a || !b) { symmetryErrors.push(`${left}/${right} absent`); continue; }
      const dx = Math.abs((a.position?.x ?? 0) + (b.position?.x ?? 0));
      const dz = Math.abs((a.position?.z ?? 0) - (b.position?.z ?? 0));
      if (Math.max(dx, dz) > expected.symmetryToleranceM) symmetryErrors.push(`${left}/${right} error ${Math.max(dx, dz).toFixed(1)} m`);
    }
    record("model.symmetry", symmetryErrors.length === 0, symmetryErrors.join("; ") || `${pairs.length} pairs within ±${expected.symmetryToleranceM} m`);

    const axisLength = model.axis?.lengthM ?? 0;
    const lengthOk = axisLength >= expected.axisLengthRangeM[0] && axisLength <= expected.axisLengthRangeM[1];
    record("model.axis-length", lengthOk, `${axisLength} m (expected ${expected.axisLengthRangeM.join("–")} m)`);

    const missingFeatures = expected.requiredModelFeatures.filter((feature) => {
      if (feature === "platforms") return !Array.isArray(model.platforms) || model.platforms.length < expected.minimumPlatforms;
      if (feature === "cameraKeys") return !Array.isArray(model.camera?.keys) || model.camera.keys.length < 3;
      if (feature === "props") return !model.props || typeof model.props !== "object";
      return true;
    });
    record("model.features", missingFeatures.length === 0, missingFeatures.length ? `missing: ${missingFeatures.join(", ")}` : "platforms, camera keys, props present");

    // Every named hall must sit on a modeled platform. A gate building drawn
    // straight on the ground reads as a wall, which is what the baseline showed.
    // 每座具名宫殿都必须落在有记录的台基上。直接落地的门楼读起来像一堵墙，这正是基线暴露的问题。
    const platformGround = expected.platformedBuildings;
    const unplatformed = platformGround
      .map((name) => byName.get(name))
      .filter((b) => b !== undefined && (b.platformId === null || b.platformId === undefined));
    const absentPlatformed = platformGround.filter((name) => !byName.has(name));
    record("model.platforms-for-halls", unplatformed.length === 0 && absentPlatformed.length === 0,
      absentPlatformed.length ? `absent: ${absentPlatformed.join(", ")}`
        : unplatformed.length ? `no platformId: ${unplatformed.map((b) => b.name).join(", ")}`
          : `${platformGround.length} named halls carry a platformId`);

    // Ornaments must be near a hall or platform, not floating in a plaza.
    // 陈设必须靠近某座建筑或台基，而不是浮在广场中间。
    const ornaments = Array.isArray(model.props?.ornaments) ? model.props.ornaments : [];
    const anchors = [
      ...model.buildings.map((b) => ({ x: b.position?.x ?? 0, z: b.position?.z ?? 0, w: Math.max(b.footprint?.widthM ?? 0, b.footprint?.depthM ?? 0) / 2 })),
      ...(model.platforms ?? []).map((p) => ({ x: p.position?.x ?? 0, z: p.position?.z ?? 0, w: Math.max(p.footprint?.widthM ?? 0, p.footprint?.depthM ?? 0) / 2 })),
    ];
    const floating = ornaments.filter((o) => {
      const x = o.position?.x ?? 0;
      const z = o.position?.z ?? 0;
      return !anchors.some((a) => Math.hypot(x - a.x, z - a.z) <= a.w + expected.ornamentAnchorSlackM);
    });
    record("model.ornament-anchoring", ornaments.length >= expected.minimumOrnaments && floating.length === 0,
      ornaments.length < expected.minimumOrnaments ? `only ${ornaments.length} ornament(s), need ${expected.minimumOrnaments}`
        : floating.length ? `${floating.length} ornament(s) far from any hall or platform: ${floating.slice(0, 3).map((o) => o.id ?? o.type).join(", ")}`
          : `${ornaments.length} ornament(s) anchored`);

    // Roof form: eave must flare above the body, and the crown must sit above
    // the eave with the ridge either narrow (hip/xieshan) or pointed (攒尖).
    // 屋顶形制：檐口必须高于墙身并外挑，顶部必须高于檐口，正脊窄（庑殿/歇山）或收成宝顶（攒尖）。
    const roofProblems = [];
    for (const name of expected.roofFormBuildings) {
      const b = byName.get(name);
      if (b === undefined) { roofProblems.push(`${name}: absent`); continue; }
      const eaveY = b.roof?.eaveY;
      const ridgeY = b.roof?.ridgeY;
      const eaveOverhang = b.roof?.eaveOverhangM;
      const ridgeLength = b.roof?.ridgeLengthM;
      if (typeof eaveY !== "number" || typeof ridgeY !== "number") { roofProblems.push(`${name}: roof.eaveY/ridgeY missing`); continue; }
      const body = b.bodyTopY;
      if (typeof body === "number" && eaveY < body - expected.roofFormToleranceM) roofProblems.push(`${name}: eave ${eaveY} below body top ${body}`);
      if (ridgeY <= eaveY + expected.roofFormToleranceM) roofProblems.push(`${name}: ridge ${ridgeY} not above eave ${eaveY}`);
      if (typeof eaveOverhang === "number" && eaveOverhang <= 0) roofProblems.push(`${name}: no eave overhang`);
      if (typeof ridgeLength === "number") {
        const width = b.footprint?.widthM ?? 0;
        if (b.roofType === "四角攒尖" && ridgeLength > expected.pointedRidgeMaxM) roofProblems.push(`${name}: 攒尖 ridge ${ridgeLength} m is not pointed`);
        if (b.roofType === "重檐庑殿" && ridgeLength > width * expected.hipRidgeMaxRatio) roofProblems.push(`${name}: 庑殿 ridge ${ridgeLength} m too wide for ${width} m`);
      }
    }
    record("model.roof-form", roofProblems.length === 0,
      roofProblems.length ? roofProblems.slice(0, 5).join("; ") : `${expected.roofFormBuildings.length} roofs report eave below ridge and a valid crown`);
  }

  // Screenshot differences along the timeline.
  for (const t of [0, 7.5, 15, 22.5, 30]) {
    const actual = await page.evaluate(async (time) => {
      const rendered = window.setVideoTime(time);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return rendered;
    }, t);
    const file = join(outDir, "screens", `t-${String(t).replace(".", "_")}.png`);
    await page.screenshot({ path: file, type: "png", animations: "disabled", timeout: 60_000 });
    const bytes = await readFile(file);
    screenshots.push({ t, actual, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex").slice(0, 16) });
  }
  const unique = new Set(screenshots.map((s) => s.sha256)).size;
  record("browser.timeline-differs", unique >= 3, `${unique}/5 distinct screenshots at t=0/7.5/15/22.5/30`);

  // Frame throughput: 60 forwards seeks, same path a renderer would use.
  const timing = await page.evaluate(async () => {
    const durations = [];
    for (let frame = 0; frame < 60; frame += 1) {
      const start = performance.now();
      window.setVideoTime(frame / 30);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      durations.push(performance.now() - start);
    }
    durations.sort((a, b) => a - b);
    return {
      medianMs: durations[Math.floor(durations.length / 2)],
      p95Ms: durations[Math.floor(durations.length * 0.95)],
      frames: durations.length,
    };
  });
  cameraTelemetry = timing;
  record("browser.frame-throughput", timing.medianMs <= 100, `median ${timing.medianMs.toFixed(1)} ms/frame, p95 ${timing.p95Ms.toFixed(1)} ms (60 seeks)`);
} catch (error) {
  record("browser.run", false, error.message.split("\n")[0]);
} finally {
  await browser.close();
  server.kill("SIGTERM");
}
record("browser.console", relevantConsole().length === 0 && relevantResponses().length === 0,
  [...relevantConsole(), ...relevantResponses()].slice(0, 3).join(" | ") || "no console errors, no failed requests");

/* ------------------------------------------------------- optional render */

let renderEvidence = null;
if (shouldRender) {
  const renderScript = join(here, "render-frames.mjs");
  if (await exists(renderScript)) {
    const started = Date.now();
    // The browser above closed its server, so the renderer starts one itself
    // from --root; --url is kept for a caller who supplies a live server.
    const result = await run(process.execPath, [renderScript, "--url", `http://127.0.0.1:${port}/`, "--root", workspace, "--out", join(outDir, "render"), "--frames", String(renderFrames)], { timeoutMs: 3_600_000, cwd: here });
    renderEvidence = {
      code: result.code,
      frames: renderFrames,
      durationMs: Date.now() - started,
      tail: (result.stdout + result.stderr).slice(-4000),
      video: join(outDir, "render", "video.mp4"),
    };
    record("render.900-frames", result.code === 0, `exit ${result.code}, ${((Date.now() - started) / 1000).toFixed(1)}s`);
    if (result.code === 0 && deps.ffmpeg) {
      const probe = await run(deps.ffmpeg, ["-hide_banner", "-i", renderEvidence.video], { timeoutMs: 120_000, cwd: outDir });
      const text = probe.stderr;
      const duration = Number(text.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/)?.slice(1).reduce((acc, n, i) => acc + Number(n) * [3600, 60, 1][i], 0));
      const size = text.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
      const fps = Number(text.match(/([\d.]+) fps/)?.[1] ?? 0);
      renderEvidence.probe = { duration, width: Number(size?.[1]), height: Number(size?.[2]), fps };
      record("render.video-spec", Math.abs(duration - 30) <= 0.5 && size?.[1] === "1920" && size?.[2] === "1080",
        `${duration?.toFixed(2)}s ${size?.[1]}×${size?.[2]} ${fps}fps`);
      await writeFile(join(outDir, "ffmpeg-probe.txt"), text.slice(-4000));
    }
  }
}

/* --------------------------------------------------------------- report */

const passed = checks.filter((c) => c.ok).length;
const hardFailures = checks.filter((c) => !c.ok && !expected.softChecks.includes(c.id.replace(new RegExp(`^${phasePrefix === "" ? "__none__" : phasePrefix}\\.`), "")));
const report = {
  task: "05-forbidden-city",
  workspace,
  machine: { platform: `${platform()} ${release()} ${arch()}`, node: process.version, chrome: process.env.CHROME_PATH ?? "system Google Chrome" },
  timestampNote: "timestamped by the caller; scripts avoid wall-clock reads",
  model,
  videoChecks,
  cameraTelemetry,
  roofTable,
  screenshots,
  fileState,
  srcFiles,
  renderState,
  testState: { files: testState.files, code: testState.code, pass: testState.pass, fail: testState.fail },
  renderEvidence,
  checks,
  summary: {
    passed,
    total: checks.length,
    hardFailures: hardFailures.map((c) => `${c.id}: ${c.detail}`),
    verdict: hardFailures.length === 0 ? "pass" : "fail",
  },
};
await writeFile(join(outDir, "report.json"), JSON.stringify(report, null, 2));
const lines = [
  `Forbidden City 3D benchmark — ${workspace}`,
  `checks: ${passed}/${checks.length}, hard failures: ${hardFailures.length}`,
  "",
  ...checks.map((c) => `${c.ok ? "PASS" : "FAIL"}  ${c.id} — ${c.detail}`),
  "",
  "roof model (name / modeled / verdict):",
  ...roofTable.map((line) => `  ${line}`),
  "",
  `model buildings: ${model?.buildings?.length ?? "n/a"}`,
  `checks object: ${JSON.stringify(videoChecks)}`,
  `frame throughput: ${JSON.stringify(cameraTelemetry)}`,
];
await writeFile(join(outDir, "report.txt"), `${lines.join("\n")}\n`);
console.log(`\n${passed}/${checks.length} checks passed; hard failures: ${hardFailures.length}`);
process.exit(hardFailures.length === 0 ? 0 : 1);
