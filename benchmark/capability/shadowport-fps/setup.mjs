#!/usr/bin/env node
/**
 * Prepare a clean Shadowport benchmark workspace.
 *
 * Usage:
 *   node setup.mjs --workspace /tmp/shadowport --three /path/to/three.module.js [--port 8137]
 *
 * Copies the workspace rules, writes a minimal classic-script page and an empty
 * game.js, and builds vendor/three.iife.js with esbuild. It never writes game
 * code: the model under test does that.
 *
 * 准备一个干净的 Shadowport 评测工作区。只写规则、最小页面、空 game.js 与 Three 的全局构建，
 * 不写任何游戏代码——那由被测模型完成。
 */
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const workspace = resolve(flag("workspace", ""));
const three = flag("three", "");
const port = Number(flag("port", "8137"));
if (workspace === "" || three === "") {
  console.error("usage: node setup.mjs --workspace DIR --three /path/to/three.module.js [--port 8137]");
  process.exit(2);
}

await mkdir(join(workspace, "vendor"), { recursive: true });
const esbuild = process.env.ESBUILD ?? join(here, "..", "..", "..", "node_modules", ".bin", "esbuild");
execFileSync(esbuild, [
  resolve(three),
  "--bundle",
  "--format=iife",
  "--global-name=THREE",
  "--minify",
  "--outfile=" + join(workspace, "vendor", "three.iife.js"),
], { stdio: "inherit" });

await writeFile(join(workspace, "index.html"), `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SHADOWPORT · 暗港</title>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: #05080a; }
  canvas { display: block; width: 100vw; height: 100vh; }
</style>
</head>
<body>
<canvas id="view"></canvas>
<script src="./vendor/three.iife.js"></script>
<script src="./game.js"></script>
</body>
</html>
`, "utf8");

await writeFile(join(workspace, "game.js"), `// SHADOWPORT game code. THREE is the global from vendor/three.iife.js.
// 暗港游戏代码。THREE 是 vendor/three.iife.js 提供的全局变量。
`, "utf8");

const rules = await readFile(join(here, "workspace-AGENTS.md"), "utf8");
await writeFile(join(workspace, "AGENTS.md"), rules.replaceAll("__PORT__", String(port)), "utf8");

console.log(`Prepared ${workspace}`);
console.log("Next:");
console.log(`  node scripts/serve-workspace.mjs --root ${workspace} --port ${port}`);
console.log(`  CLONE_AI_MAIN_EFFORT=medium node --experimental-strip-types eval-runs/2026-11-17-browser-mcp/run.mjs ${workspace} <clone-home> ${join(here, "prompt.md")}`);
console.log(`  node ${join(here, "verify", "check-shadowport.mjs")} --workspace ${workspace} --out ${join(here, "verify", "out")} --port 8140`);
