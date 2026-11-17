#!/usr/bin/env node
// Measures how much visual detail a render actually has, from its pixels.
//
// "Looks like a floor plan" is a real, measurable complaint: a flat-shaded
// model has almost no luminance gradient inside its surfaces and very few
// distinct colours. This loads a PNG into a canvas and reports gradient energy
// (mean |dL/dx| + |dL/dy| over interior pixels), the number of distinct colours,
// and the share of pixels that are a near-flat region.
//
// With --crop, only the central region is measured: the full frame is mostly
// sky and pavement, which makes every render look equally flat. The crop is
// where the building is, so it is where detail is claimed.
//
// Usage: node pixel-detail.mjs [--crop WxH] [--threshold N] <image.png> [...]
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

const requireFrom = (base) => createRequire(base)("playwright-core");
function loadPlaywright() {
  const bases = [];
  if (process.env.CLONE_AI_VERIFY_DEPS) bases.push(join(process.env.CLONE_AI_VERIFY_DEPS, "package.json"));
  bases.push(join(process.env.HOME ?? "", "study/clone-ai/eval-runs/2026-11-17-capability/verify/package.json"));
  for (const base of bases) {
    try { return requireFrom(base); } catch { /* next */ }
  }
  throw new Error("cannot resolve playwright-core");
}
const { chromium } = loadPlaywright();
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
const args = process.argv.slice(2);
const cropArg = args.includes("--crop") ? args[args.indexOf("--crop") + 1] : undefined;
const edgeThreshold = args.includes("--threshold") ? Number(args[args.indexOf("--threshold") + 1]) : 6;
const files = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && ["--crop", "--threshold"].includes(args[i - 1])));
const [cropW, cropH] = (cropArg ?? "").split("x").map(Number);
const rows = [];
for (const path of files) {
  const bytes = await readFile(path);
  const dataUrl = `data:image/png;base64,${bytes.toString("base64")}`;
  await page.evaluate(([w, h]) => { globalThis.__cropW = w; globalThis.__cropH = h; }, [cropW, cropH]);
  const metrics = await page.evaluate(async ([url, threshold]) => {
    const image = new Image();
    image.src = url;
    await image.decode();
    const sw = Number.isFinite(globalThis.__cropW) ? globalThis.__cropW : image.width;
    const sh = Number.isFinite(globalThis.__cropH) ? globalThis.__cropH : image.height;
    const sx = Math.floor((image.width - sw) / 2);
    const sy = Math.floor((image.height - sh) / 2);
    const canvas = document.createElement("canvas");
    canvas.width = sw;
    canvas.height = sh;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
    const { data, width, height } = context.getImageData(0, 0, sw, sh);
    const gray = new Float32Array(width * height);
    const colours = new Set();
    for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
      gray[p] = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      colours.add((data[i] >> 3) << 10 | (data[i + 1] >> 3) << 5 | (data[i + 2] >> 3));
    }
    let sum = 0;
    let count = 0;
    let flat = 0;
    let edges = 0;
    const interior = (x, y) => x > 1 && y > 1 && x < width - 2 && y < height - 2;
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        if (!interior(x, y)) continue;
        const p = y * width + x;
        const gx = Math.abs(gray[p + 1] - gray[p - 1]);
        const gy = Math.abs(gray[p + width] - gray[p - width]);
        const g = (gx + gy) / 2;
        sum += g;
        count += 1;
        if (g < 1.5) flat += 1;
        if (g >= threshold) edges += 1;
      }
    }
    return {
      width, height,
      gradientEnergy: Number((sum / Math.max(1, count)).toFixed(3)),
      distinctColours: colours.size,
      flatShare: Number((flat / Math.max(1, count)).toFixed(3)),
      edgeShare: Number((edges / Math.max(1, count)).toFixed(3)),
    };
  }, [dataUrl, edgeThreshold]);
  rows.push({ path, ...metrics });
}
await browser.close();
for (const row of rows) {
  console.log(`${row.path}\tgradient=${row.gradientEnergy}\tedges=${(row.edgeShare * 100).toFixed(1)}%\tcolours=${row.distinctColours}\tflat=${(row.flatShare * 100).toFixed(1)}%`);
}
