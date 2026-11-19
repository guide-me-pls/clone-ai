/**
 * Rerunnable attachment-client benchmark.
 *
 * Runs the attachment block sliced from two app.js revisions in a VM with the
 * same fake FileReader/URL/DOM the deterministic test uses. The "old" revision
 * (default `HEAD`) carries the serial data-URL path; the "new" revision (the
 * working tree by default) carries the ordered pool, blob previews and
 * background encoding. Read latency is simulated with `--read-ms` so the two
 * strategies can be compared without a browser; the numbers measure the
 * strategy, not a WebView.
 *
 * 可重跑的附件客户端基准测试。
 *
 * 在 VM 中执行从两个 app.js 版本切出的附件代码块，使用与确定性测试相同的假
 * FileReader/URL/DOM。"旧"版本（默认 `HEAD`）是串行 data URL 路径；"新"版本（默认工作区）
 * 是按序池、blob 预览与后台编码。读取延迟由 `--read-ms` 模拟，因此不需要浏览器即可比较两种
 * 策略；数字衡量的是策略，而不是 WebView。
 */
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { runInNewContext } from "node:vm";

import { parseAttachments } from "../src/main-agent/attachments.ts";

const root = resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
function option(name: string, fallback: string): string {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] !== undefined && argv[index + 1]!.length > 0 ? argv[index + 1]! : fallback;
}

const runs = Math.max(1, Number(option("--runs", "3")));
const readMs = Math.max(0, Number(option("--read-ms", "10")));
const oldRef = option("--old-ref", "HEAD");
const newPath = option("--new", join(root, "apps", "desktop", "ui", "app.js"));
const outPath = option("--out", join(root, "benchmark", "results", `attachment-client-${new Date().toISOString().replace(/[:.]/g, "-")}.json`));
const oldSource = execFileSync("git", ["show", `${oldRef}:apps/desktop/ui/app.js`], { cwd: root, encoding: "utf8" });
const newSource = await readFile(newPath, "utf8");

const counters = { reads: 0, active: 0, maxActive: 0 };
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

class BenchFile extends File {
  override async arrayBuffer(): Promise<ArrayBuffer> {
    return await track(() => super.arrayBuffer());
  }
  override async text(): Promise<string> {
    return await track(() => super.text());
  }
}

async function track<T>(work: () => Promise<T>): Promise<T> {
  counters.active += 1;
  counters.maxActive = Math.max(counters.maxActive, counters.active);
  try {
    if (readMs > 0) await sleep(readMs);
    return await work();
  } finally {
    counters.active -= 1;
  }
}

class BenchFileReader {
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;

  readAsText(file: File): void { void this.#run(file, "text"); }
  readAsDataURL(file: File): void { void this.#run(file, "data"); }

  async #run(file: File, mode: string): Promise<void> {
    counters.reads += 1;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      this.result = mode === "text"
        ? new TextDecoder().decode(bytes)
        : `data:${file.type};base64,${Buffer.from(bytes).toString("base64")}`;
      this.onload?.();
    } catch (error) {
      this.onerror?.(error);
    }
  }
}

interface Harness {
  addAttachmentFiles: (files: File[]) => Promise<number>;
  attachmentsForRequest?: (items: Array<Record<string, unknown>>) => Promise<{ ok: boolean; attachments?: unknown[]; error?: string }>;
  state: {
    attachments: Array<Record<string, unknown>>;
    attachmentsPending: Array<Record<string, unknown>>;
    attachmentsPreparing: number;
    attachmentsPreparingSince: number;
  };
  host: { hidden: boolean; innerHTML: string };
}

function harness(source: string): Harness {
  const start = source.indexOf("const MAX_ATTACHMENTS");
  const end = source.indexOf("function clipboardAttachmentFiles", start);
  if (start < 0 || end <= start) throw new Error("the attachment block is missing from this app.js revision");
  counters.reads = 0;
  counters.active = 0;
  counters.maxActive = 0;
  const state = {
    attachments: [] as Array<Record<string, unknown>>,
    attachmentsPending: [] as Array<Record<string, unknown>>,
    attachmentsPreparing: 0,
    attachmentsPreparingSince: 0,
  };
  const host = { hidden: false, innerHTML: "" };
  let created = 0;
  const api = runInNewContext(`(function () {
${source.slice(start, end)}
return {
  addAttachmentFiles,
  ...(typeof attachmentsForRequest === "function" ? { attachmentsForRequest } : {}),
};
}())`, {
    state,
    announce: () => undefined,
    $: (id: string) => id === "attachment-preview" ? host : {},
    escape: (value: unknown) => String(value ?? ""),
    URL: {
      createObjectURL: () => `blob:bench-${++created}`,
      revokeObjectURL: () => undefined,
    },
    FileReader: BenchFileReader,
    performance: { now: () => performance.now() },
  }) as Omit<Harness, "state" | "host">;
  return { ...api, state, host };
}

function bytes(size: number, header: number[] = []): Uint8Array {
  const data = new Uint8Array(size);
  data.set(header);
  return data;
}

const imageHeader = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const pdfHeader = [...new TextEncoder().encode("%PDF-1.4\n")];

function fixtures(): Record<string, () => File[]> {
  return {
    fourImages: () => [0, 1, 2, 3].map((index) => new BenchFile([bytes(5 * 1024 * 1024, imageHeader)], `image-${index}.png`, { type: "image/png" })),
    mixed: () => [
      new BenchFile([bytes(5 * 1024 * 1024, imageHeader)], "photo.png", { type: "image/png" }),
      new BenchFile([bytes(10 * 1024 * 1024, pdfHeader)], "paper.pdf", { type: "application/pdf" }),
      new BenchFile([new TextEncoder().encode("x".repeat(40_000))], "notes.txt", { type: "text/plain" }),
      new BenchFile([bytes(5 * 1024 * 1024, imageHeader)], "second.png", { type: "image/png" }),
    ],
    sixFiles: () => Array.from({ length: 6 }, (_, index) => new BenchFile([bytes(1024 * 1024, imageHeader)], `image-${index}.png`, { type: "image/png" })),
  };
}

interface Measurement {
  attachMs: number;
  totalMs: number;
  added: number;
  maxActive: number;
  reads: number;
  innerHtmlBytes: number;
  dataPreviews: number;
  blobPreviews: number;
  payloadOk: boolean | null;
}

async function measure(source: string, makeFiles: () => File[]): Promise<Measurement> {
  const api = harness(source);
  const files = makeFiles();
  const started = performance.now();
  const added = await api.addAttachmentFiles(files);
  const attachMs = performance.now() - started;
  let payloadOk: boolean | null = null;
  if (api.attachmentsForRequest !== undefined) {
    const request = await api.attachmentsForRequest(api.state.attachments);
    payloadOk = request.ok ? parseAttachments(request.attachments).ok : false;
  }
  const totalMs = performance.now() - started;
  return {
    attachMs,
    totalMs,
    added,
    maxActive: counters.maxActive,
    reads: counters.reads,
    innerHtmlBytes: api.host.innerHTML.length,
    dataPreviews: (api.host.innerHTML.match(/src="data:/g) ?? []).length,
    blobPreviews: (api.host.innerHTML.match(/src="blob:/g) ?? []).length,
    payloadOk,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function summarize(measurements: Measurement[]): Record<string, number | boolean | null> {
  return {
    attachMsMedian: Math.round(median(measurements.map((item) => item.attachMs))),
    totalMsMedian: Math.round(median(measurements.map((item) => item.totalMs))),
    added: measurements[0]?.added ?? 0,
    maxActive: Math.max(...measurements.map((item) => item.maxActive)),
    reads: measurements[0]?.reads ?? 0,
    innerHtmlBytesMedian: Math.round(median(measurements.map((item) => item.innerHtmlBytes))),
    dataPreviews: measurements[0]?.dataPreviews ?? 0,
    blobPreviews: measurements[0]?.blobPreviews ?? 0,
    payloadOk: measurements[0]?.payloadOk ?? null,
  };
}

const scenarios: Record<string, { old: ReturnType<typeof summarize>; new: ReturnType<typeof summarize>; runs: { old: Measurement[]; new: Measurement[] } }> = {};
for (const [name, makeFiles] of Object.entries(fixtures())) {
  const oldRuns: Measurement[] = [];
  const newRuns: Measurement[] = [];
  for (let run = 0; run < runs; run += 1) {
    oldRuns.push(await measure(oldSource, makeFiles));
    newRuns.push(await measure(newSource, makeFiles));
  }
  scenarios[name] = { old: summarize(oldRuns), new: summarize(newRuns), runs: { old: oldRuns, new: newRuns } };
}

const result = {
  kind: "attachment-client-benchmark",
  date: new Date().toISOString(),
  command: `node --experimental-strip-types benchmark/attachment-client.ts --old-ref ${oldRef} --new ${newPath} --runs ${runs} --read-ms ${readMs}`,
  provider: "none",
  model: "none",
  machine: {
    platform: process.platform,
    node: process.version,
    cpu: cpus()[0]?.model ?? "unknown",
    cores: cpus().length,
    memoryGb: Math.round(totalmem() / 1e9),
  },
  parameters: {
    runs,
    readMs,
    maxAttachments: 4,
    fixtures: {
      fourImages: "four 5 MB image/png files with a PNG signature",
      mixed: "5 MB image, 10 MB PDF, 40,000-character text, 5 MB image",
      sixFiles: "six 1 MB image/png files (tests the four-file cap)",
    },
  },
  old: { ref: oldRef, source: "HEAD:apps/desktop/ui/app.js" },
  new: { path: newPath },
  scenarios,
  notes: [
    "The VM has no createImageBitmap, so the new revision uses its object-URL fallback rather than decoding a 240 px thumbnail.",
    "Read latency is simulated with --read-ms; this compares strategies, not WebView or disk speed.",
    "The old revision is taken from git; run with --old-ref at a commit before the change.",
    "Chromium/JS numbers are not WKWebView numbers; the native NSOpenPanel is not represented.",
  ],
};

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
for (const [name, scenario] of Object.entries(scenarios)) {
  console.log(`${name}: old attach ${scenario.old.attachMsMedian}ms maxActive ${scenario.old.maxActive} data:${scenario.old.dataPreviews} | new attach ${scenario.new.attachMsMedian}ms maxActive ${scenario.new.maxActive} blob:${scenario.new.blobPreviews}`);
}
console.log(`result: ${outPath}`);