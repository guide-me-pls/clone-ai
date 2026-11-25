/**
 * Client-side attachment preparation: concurrency, ordering and deferred reads.
 *
 * The composer is a plain browser script, so this test evaluates the attachment
 * block from app.js in a VM with a fake FileReader, URL and host. It pins the
 * behavior the optimization relies on: a chip appears before a slow read ends,
 * files are prepared concurrently in input order, the twenty-attachment and
 * 100,000-character caps still apply, image and PDF bytes are read in the
 * background rather than carried as a data URL, and the request payload is
 * accepted by the real server parser.
 *
 * 客户端附件准备：并发、顺序与延迟读取。
 *
 * 输入框是普通浏览器脚本，因此本测试在 VM 中执行 app.js 的附件代码块，并注入假的
 * FileReader、URL 与宿主。它钉住优化依赖的行为：慢读取结束前 chip 已出现、文件按输入
 * 顺序并发准备、二十附件与 100,000 字符上限仍然生效、图片与 PDF 的字节在后台读取而不是
 * 作为 data URL 携带、请求载荷能被真实服务端解析器接受。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { parseAttachments } from "../src/main-agent/attachments.ts";

interface Counts {
  arrayBuffer: number;
  text: number;
  reads: Array<{ name: string; mode: string }>;
  maxActive: number;
}

class CountingFile extends File {
  readonly counts: Counts;
  constructor(parts: BlobPart[], name: string, options: FilePropertyBag, counts: Counts) {
    super(parts, name, options);
    this.counts = counts;
  }
  override async arrayBuffer(): Promise<ArrayBuffer> {
    this.counts.arrayBuffer += 1;
    return await super.arrayBuffer();
  }
  override async text(): Promise<string> {
    this.counts.text += 1;
    return await super.text();
  }
}

class SlowFileReader {
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  static active = 0;
  static delay = 0;
  static counts: Counts = { arrayBuffer: 0, text: 0, reads: [], maxActive: 0 };

  readAsText(file: File): void { void this.#run(file, "text"); }
  readAsDataURL(file: File): void { void this.#run(file, "data"); }

  async #run(file: File, mode: string): Promise<void> {
    SlowFileReader.counts.reads.push({ name: file.name, mode });
    SlowFileReader.active += 1;
    SlowFileReader.counts.maxActive = Math.max(SlowFileReader.counts.maxActive, SlowFileReader.active);
    try {
      if (SlowFileReader.delay > 0) await new Promise((resolve) => setTimeout(resolve, SlowFileReader.delay));
      const bytes = new Uint8Array(await file.arrayBuffer());
      this.result = mode === "text"
        ? new TextDecoder().decode(bytes)
        : `data:${file.type};base64,${Buffer.from(bytes).toString("base64")}`;
      SlowFileReader.active -= 1;
      this.onload?.();
    } catch (error) {
      SlowFileReader.active -= 1;
      this.onerror?.(error);
    }
  }
}

function harness(delay = 0, { nativeBase64 = true, nativeVideoFrame }: { nativeBase64?: boolean; nativeVideoFrame?: string } = {}) {
  const counts: Counts = { arrayBuffer: 0, text: 0, reads: [], maxActive: 0 };
  SlowFileReader.delay = delay;
  SlowFileReader.active = 0;
  SlowFileReader.counts = counts;
  const notices: Array<{ message: string; error: boolean }> = [];
  const revoked: string[] = [];
  let created = 0;
  const state = {
    attachments: [] as Array<Record<string, unknown>>,
    attachmentsPending: [] as Array<Record<string, unknown>>,
    attachmentsPreparing: 0,
    attachmentsPreparingSince: 0,
  };
  const host = { hidden: false, innerHTML: "" };
  const app = appSource;
  const start = app.indexOf("const MAX_ATTACHMENTS");
  const end = app.indexOf("function clipboardAttachmentFiles", start);
  assert.ok(start >= 0 && end > start, "the attachment block must exist in app.js");
  class NoNativeBase64 extends Uint8Array {}
  Object.defineProperty(NoNativeBase64.prototype, "toBase64", { value: undefined, configurable: true });
  const api = runInNewContext(`(function () {
${app.slice(start, end)}
return { addAttachmentFiles, attachmentsForRequest, prepareAttachment, releaseAttachmentPreview, mergeRestoredAttachments, releaseReplacedAttachmentPreviews, filesFromNativePayloads };
})()`, {
    state,
    announce: (message: string, error = false) => notices.push({ message, error }),
    $: (id: string) => id === "attachment-preview" ? host : {},
    escape: (value: unknown) => String(value ?? ""),
    URL: {
      createObjectURL: () => `blob:test-${++created}`,
      revokeObjectURL: (url: string) => revoked.push(url),
    },
    File,
    Blob,
    FileReader: SlowFileReader,
    atob: (value: string) => Buffer.from(value, "base64").toString("binary"),
    performance: { now: () => Date.now() },
    ...(nativeBase64 ? {} : { Uint8Array: NoNativeBase64 }),
    ...(nativeVideoFrame === undefined ? {} : { window: { CloneNative: { videoFrame: async () => nativeVideoFrame } } }),
  }) as {
    addAttachmentFiles: (files: File[]) => Promise<number>;
    attachmentsForRequest: (items: Array<Record<string, unknown>>) => Promise<{ ok: boolean; attachments?: unknown[]; error?: string }>;
    prepareAttachment: (file: File) => Promise<{ item?: Record<string, unknown>; rejected?: string }>;
    releaseAttachmentPreview: (item: Record<string, unknown>) => void;
    mergeRestoredAttachments: (outgoing: Array<Record<string, unknown>>, current: Array<Record<string, unknown>>) => Array<Record<string, unknown>>;
    releaseReplacedAttachmentPreviews: (card: { isConnected: boolean }, items: Array<Record<string, unknown>>) => void;
    filesFromNativePayloads: (payloads: Array<{ name: string; path: string; size: number; mimeType: string; data: string }>) => Array<File & { clonePath?: string }>;
  };
  return { api, state, host, notices, counts, revoked };
}

function fileOf(bytes: Uint8Array, name: string, type: string, counts: Counts): File {
  return new CountingFile([bytes], name, { type }, counts);
}

function textFile(text: string, name: string, counts: Counts): File {
  return fileOf(new TextEncoder().encode(text), name, "text/plain", counts);
}

function pngBytes(size = 1024): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.set([1, 2, 3, 4], 8);
  return bytes;
}

function pdfBytes(size = 1024): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(new TextEncoder().encode("%PDF-1.4\n"));
  return bytes;
}

const appSource = await readFile(join(process.cwd(), "apps", "desktop", "ui", "app.js"), "utf8");

test("native clipboard payloads become attachable Files", async () => {
  const { api } = harness();
  const files = api.filesFromNativePayloads([{
    name: "notes.md",
    path: "/tmp/notes.md",
    size: 5,
    mimeType: "text/markdown",
    data: Buffer.from("hello").toString("base64"),
  }]);
  assert.equal(files.length, 1);
  assert.equal(files[0]!.name, "notes.md");
  assert.equal(files[0]!.type, "text/markdown");
  assert.equal(files[0]!.clonePath, "/tmp/notes.md");
  assert.equal(await files[0]!.text(), "hello");
  // The same File shape feeds the existing pipeline: a native payload can
  // become a document attachment without a path crossing the wire.
  // 同一 File 形状进入现有管线：原生载荷无需让路径过线，就能成为文档附件。
  const prepared = await api.prepareAttachment(files[0]!);
  assert.equal(prepared.item?.kind, "document");
  assert.equal(prepared.item?.name, "notes.md");
});

test("a slow read shows a preparing chip before the file is added", async () => {
  const { api, state, host } = harness(40);
  const file = textFile("hello", "notes.txt", SlowFileReader.counts);
  const work = api.addAttachmentFiles([file]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(state.attachmentsPending.length, 1);
  assert.match(host.innerHTML, /读取中…/);
  await work;
  assert.equal(state.attachmentsPending.length, 0);
  assert.equal(state.attachments.length, 1);
});

test("files are prepared concurrently but accepted in input order", async () => {
  const { api, state, counts } = harness(20);
  const files = ["a.txt", "b.txt", "c.txt", "d.txt"].map((name) => textFile(name, name, counts));
  const added = await api.addAttachmentFiles(files);
  assert.equal(added, 4);
  assert.ok(counts.maxActive > 1 && counts.maxActive <= 3, `expected 2-3 concurrent reads, saw ${counts.maxActive}`);
  assert.deepEqual(state.attachments.map((item) => item.name), ["a.txt", "b.txt", "c.txt", "d.txt"]);
});

test("overlapping batches stay within the global pool and the twenty-file cap", async () => {
  const { api, state, counts } = harness(15);
  const batchA = Array.from({ length: 12 }, (_, index) => textFile(`a${index}.txt`, `a${index}.txt`, counts));
  const batchB = Array.from({ length: 12 }, (_, index) => textFile(`b${index}.txt`, `b${index}.txt`, counts));
  await Promise.all([api.addAttachmentFiles(batchA), api.addAttachmentFiles(batchB)]);
  assert.equal(state.attachments.length, 20);
  assert.equal(state.attachmentsPending.length, 0);
  assert.ok(counts.maxActive <= 3, `the global pool exceeded three readers: ${counts.maxActive}`);
});

test("the twenty-attachment cap and the shared character budget still apply", async () => {
  const capped = harness();
  const beyond = Array.from({ length: 21 }, (_, index) => textFile(`file ${index}`, `${index}.txt`, capped.counts));
  assert.equal(await capped.api.addAttachmentFiles(beyond), 20);
  assert.equal(capped.state.attachments.length, 20);
  assert.ok(capped.notices.some((notice) => notice.message.includes("最多添加 20 个附件")));

  const budget = harness();
  const big = "x".repeat(40_000);
  const three = ["a.txt", "b.txt", "c.txt"].map((name) => textFile(big, name, budget.counts));
  assert.equal(await budget.api.addAttachmentFiles(three), 2);
  assert.equal(budget.state.attachments.length, 2);
  assert.ok(budget.notices.some((notice) => notice.message.includes("文档合计超过 100000 字符")));
});

test("images and PDFs keep the File and a small preview instead of a data URL", async () => {
  const { api, state, counts } = harness();
  const png = fileOf(pngBytes(5 * 1024 * 1024), "photo.png", "image/png", counts);
  const pdf = fileOf(pdfBytes(10 * 1024 * 1024), "paper.pdf", "application/pdf", counts);
  assert.equal(await api.addAttachmentFiles([png, pdf]), 2);
  const image = state.attachments[0]!;
  const document = state.attachments[1]!;
  assert.equal(image.file, png);
  assert.match(String(image.previewUrl), /^blob:/);
  assert.equal(image.data, undefined);
  assert.equal(document.file, pdf);
  assert.equal(document.data, undefined);

  const request = await api.attachmentsForRequest(state.attachments);
  assert.equal(request.ok, true);
  const parsed = parseAttachments(request.attachments);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.images.length, 1);
    assert.equal(parsed.binaryDocuments.length, 1);
  }
});

test("a successful payload is encoded once and reused", async () => {
  const { api, state, counts } = harness();
  await api.addAttachmentFiles([fileOf(pngBytes(1024), "photo.png", "image/png", counts)]);
  const item = state.attachments[0]!;
  await item.payload;
  const before = counts.arrayBuffer + counts.reads.length;
  const first = await api.attachmentsForRequest([item]);
  const second = await api.attachmentsForRequest([item]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(counts.arrayBuffer + counts.reads.length, before);
});

test("the FileReader fallback encodes when the runtime has no native base64", async () => {
  const { api, state, counts } = harness(0, { nativeBase64: false });
  await api.addAttachmentFiles([fileOf(pngBytes(64), "photo.png", "image/png", counts)]);
  const request = await api.attachmentsForRequest(state.attachments);
  assert.equal(request.ok, true);
  assert.ok(counts.reads.some((read) => read.mode === "data"), "the fallback must read as a data URL");
  const parsed = parseAttachments(request.attachments);
  assert.equal(parsed.ok, true);
});

test("a native video frame is used when the shell provides one", async () => {
  const dataUrl = "data:image/jpeg;base64,AAAA";
  const { api } = harness(0, { nativeVideoFrame: dataUrl });
  const file = new File([new Uint8Array(8)], "video.mp4", { type: "video/mp4" });
  const outcome = await api.prepareAttachment(file);
  assert.equal(outcome.item?.kind, "image");
  assert.equal(outcome.item?.data, "AAAA");
  assert.equal(outcome.item?.previewUrl, dataUrl);
});

test("a read failure keeps the attachment and returns the file name", async () => {
  const { api, state, counts } = harness();
  const broken = new CountingFile([pngBytes(64)], "gone.png", { type: "image/png" }, counts);
  broken.arrayBuffer = async () => {
    throw new Error("file is gone");
  };
  assert.equal(await api.addAttachmentFiles([broken]), 1);
  const request = await api.attachmentsForRequest(state.attachments);
  assert.equal(request.ok, false);
  assert.match(String(request.error), /gone\.png/);
  assert.equal(state.attachments.length, 1);
});

test("a transient read failure is retried instead of cached", async () => {
  const { api, counts } = harness();
  const file = new CountingFile([pngBytes(64)], "flaky.png", { type: "image/png" }, counts);
  const original = file.arrayBuffer.bind(file);
  let calls = 0;
  let fail = true;
  file.arrayBuffer = async () => {
    calls += 1;
    if (fail) throw new Error("transient");
    return await original();
  };
  const outcome = await api.prepareAttachment(file);
  assert.ok(outcome.item);
  // The first request may read once (FileReader-only runtimes) or twice (a
  // runtime with native toBase64 falls back to FileReader); every read fails.
  // 第一次请求可能读一次（只有 FileReader 的运行时），也可能读两次（有原生 toBase64
  // 的运行时回退到 FileReader）；每次读取都失败。
  const first = await api.attachmentsForRequest([outcome.item]);
  assert.equal(first.ok, false);
  assert.ok(calls >= 1, "the failed request must have read the file");
  fail = false;
  const second = await api.attachmentsForRequest([outcome.item]);
  assert.equal(second.ok, true);
  assert.ok(calls >= 2, "the retry must reread the file");
});

test("a failed send restores the originals first, within the cap", () => {
  const { api } = harness();
  const a = { name: "a" };
  const b = { name: "b" };
  const c = { name: "c" };
  const d = { name: "d" };
  const e = { name: "e" };
  assert.deepEqual(Array.from(api.mergeRestoredAttachments([a, b], [c]), (item) => item.name), ["a", "b", "c"]);
  assert.deepEqual(Array.from(api.mergeRestoredAttachments([a, b], [c, d, e]), (item) => item.name), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(Array.from(api.mergeRestoredAttachments([a, b], [a, c]), (item) => item.name), ["b", "a", "c"]);
  assert.deepEqual(Array.from(api.mergeRestoredAttachments([a, b], [c, d]), (item) => item.name), ["a", "b", "c", "d"]);
  // At the cap only the remaining room is restored, earliest first.
  // 达到上限时只恢复剩余空位，靠前的优先。
  const current = Array.from({ length: 19 }, (_, index) => ({ name: `c${index}` }));
  const merged = api.mergeRestoredAttachments([a, b, e], current);
  assert.equal(merged.length, 20);
  assert.deepEqual(Array.from(merged.slice(0, 2), (item) => item.name), ["a", "c0"]);
  assert.ok(!merged.includes(b) && !merged.includes(e));
});

test("a connected card or a restored item keeps its preview URL", () => {
  const { api, state, revoked } = harness();
  const item = { name: "photo.png", previewUrl: "blob:keep" };
  state.attachments = [item];
  api.releaseReplacedAttachmentPreviews({ isConnected: true }, [item]);
  assert.equal(revoked.length, 0);
  api.releaseReplacedAttachmentPreviews({ isConnected: false }, [item]);
  assert.equal(revoked.length, 0);
  state.attachments = [];
  api.releaseReplacedAttachmentPreviews({ isConnected: false }, [item]);
  assert.deepEqual(revoked, ["blob:keep"]);
});

test("removing an attachment releases its preview URL", async () => {
  const { api, state, revoked } = harness();
  await api.addAttachmentFiles([fileOf(pngBytes(64), "photo.png", "image/png", SlowFileReader.counts)]);
  const item = state.attachments[0]!;
  api.releaseAttachmentPreview(item);
  assert.ok(revoked.includes(String(item.previewUrl)));
});