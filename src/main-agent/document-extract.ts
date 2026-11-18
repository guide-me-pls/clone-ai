/**
 * Text extraction for PDF and .docx attachments.
 *
 * A PDF or Word file is a container, not text: the model cannot read the bytes,
 * and writing them into the workspace would create a second, ungoverned copy of
 * the owner's document. This module turns the file into plain text inside the
 * request, bounded by the same character budget as a text attachment. PDF text
 * comes from `unpdf` (a serverless PDF.js build); `.docx` is a ZIP of OOXML, so
 * a small reader over `node:zlib` is enough. No dependency is loaded until a
 * PDF actually arrives, and nothing is written to disk.
 *
 * PDF 与 .docx 附件的文本提取。
 *
 * PDF 或 Word 文件是容器而不是文本：模型读不了字节，把字节写进工作区又会制造所有者文档的
 * 第二份、不受治理的副本。本模块在请求内把文件变成纯文本，并与文本文档共用同一字符预算。
 * PDF 文本来自 `unpdf`（PDF.js 的 serverless 构建）；`.docx` 是 OOXML 的 ZIP，因此用
 * `node:zlib` 的小型读取器即可。只有 PDF 真正到达时才加载依赖，且不向磁盘写入任何内容。
 */
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";

import {
  DOCX_MIME_TYPE,
  DOC_MIME_TYPE,
  MAX_DOCUMENT_CHARACTERS,
  MAX_TOTAL_DOCUMENT_CHARACTERS,
  type BinaryDocumentAttachment,
  type DocumentAttachment,
} from "./attachments.ts";

/** Bound the CPU a single PDF can spend on page fan-out. 限制单个 PDF 在页级展开上的 CPU。 */
const MAX_PDF_PAGES = 300;
/** Bound one declared image so a malformed PDF cannot allocate gigabytes. 限制单张声明图片，避免畸形 PDF 分配巨量内存。 */
const MAX_IMAGE_BYTES = 16_777_216;

export interface AttachmentReport {
  name: string;
  mimeType: string;
  /** Characters handed to the model after extraction and truncation. 提取与截断后交给模型的字符数。 */
  characters: number;
  truncated: boolean;
}

export type DocumentToolMode = "ocr-pdf" | "doc";
export type DocumentToolRunner = (mode: DocumentToolMode, bytes: Buffer) => Promise<string>;

export type BinaryExtractionResult =
  | { ok: true; documents: DocumentAttachment[]; reports: AttachmentReport[] }
  | { ok: false; error: string };

type PdfModule = typeof import("unpdf");
let pdfModule: Promise<PdfModule> | undefined;

function loadPdfModule(): Promise<PdfModule> {
  pdfModule ??= import("unpdf");
  return pdfModule;
}

/**
 * The Swift helper ships next to the bundled Node, or is named by the shell
 * that started this process. A daemon started outside the app has neither; the
 * caller then gets a clear "needs the desktop app" error instead of a crash.
 * Swift 助手与打包的 Node 相邻，或由启动本进程的外壳指定。App 之外启动的守护进程
 * 两者都没有；调用方会得到明确的“需要桌面 App”错误，而不是崩溃。
 */
function resolveDocumentTool(): string | undefined {
  const configured = process.env.CLONE_AI_DOCUMENT_TOOL?.trim();
  if (configured !== undefined && configured.length > 0) return configured;
  const sibling = join(dirname(process.execPath), "CloneAIDocumentTool");
  try {
    accessSync(sibling, constants.X_OK);
    return sibling;
  } catch {
    return undefined;
  }
}

async function defaultRunDocumentTool(mode: DocumentToolMode, bytes: Buffer): Promise<string> {
  const tool = resolveDocumentTool();
  if (tool === undefined) {
    throw new Error(
      mode === "ocr-pdf"
        ? "OCR needs the desktop app's document tool; open Clone AI and retry."
        : "Legacy .doc needs the desktop app's document tool; open Clone AI and retry.",
    );
  }
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(tool, [mode], { stdio: ["pipe", "pipe", "pipe"] });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) reject(error);
      else resolve(Buffer.concat(output).toString("utf8"));
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("the document tool timed out"));
    }, 120_000);
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 4_000_000) {
        child.kill("SIGKILL");
        finish(new Error("the document tool produced too much text"));
        return;
      }
      output.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errors.length < 64) errors.push(chunk);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code !== 0) {
        const detail = Buffer.concat(errors).toString("utf8").trim();
        finish(new Error(detail.length > 0 ? detail : `the document tool exited with ${code}`));
        return;
      }
      finish();
    });
    // A tool that exits early closes its stdin; EPIPE is its error, not ours.
    // 提前退出的助手会关闭 stdin；EPIPE 是它的错误，不是我们的。
    child.stdin.on("error", () => undefined);
    child.stdin.end(bytes);
  });
}

/**
 * Extracts every binary attachment, then applies the remaining document budget.
 * A longer document keeps its first `cap` characters and gains an explicit
 * marker; the caller learns the truncation through the report, so the interface
 * can tell the owner instead of silently shortening the file.
 * 提取所有二进制附件，再套用剩余的文档预算。超长文档保留前 `cap` 个字符并加上显式标记；
 * 调用方通过 report 得知截断，界面因此可以告诉所有者，而不是静默缩短文件。
 */
export async function extractBinaryDocuments(
  binaries: ReadonlyArray<BinaryDocumentAttachment>,
  options: { remainingCharacters?: number; runDocumentTool?: DocumentToolRunner } = {},
): Promise<BinaryExtractionResult> {
  const runDocumentTool = options.runDocumentTool ?? defaultRunDocumentTool;
  let remaining = Math.max(0, options.remainingCharacters ?? MAX_TOTAL_DOCUMENT_CHARACTERS);
  const documents: DocumentAttachment[] = [];
  const reports: AttachmentReport[] = [];
  for (const binary of binaries) {
    if (remaining <= 0) {
      return { ok: false, error: `The attachments together exceed ${MAX_TOTAL_DOCUMENT_CHARACTERS} characters.` };
    }
    const cap = Math.min(MAX_DOCUMENT_CHARACTERS, remaining);
    let extracted: { text: string; truncated: boolean };
    try {
      const bytes = Buffer.from(binary.data, "base64");
      if (binary.mimeType === DOC_MIME_TYPE) {
        extracted = { text: await runDocumentTool("doc", bytes), truncated: false };
      } else if (binary.mimeType === DOCX_MIME_TYPE) {
        extracted = extractDocxText(bytes);
      } else {
        const pdf = await extractPdfText(bytes, cap + 1);
        extracted = normalizeExtractedText(pdf.text).length === 0
          ? { text: await runDocumentTool("ocr-pdf", bytes), truncated: false }
          : pdf;
      }
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `${binary.name}: ${reason}` };
    }
    const normalized = normalizeExtractedText(extracted.text);
    if (normalized.length === 0) {
      const hint = binary.mimeType === "application/pdf" ? " (OCR recognized nothing)" : "";
      return { ok: false, error: `${binary.name}: no extractable text was found${hint}.` };
    }
    const truncated = extracted.truncated || normalized.length > cap;
    const marker = `\n\n[… document truncated after ${cap} characters …]`;
    const text = truncated ? `${normalized.slice(0, cap)}${marker}` : normalized;
    remaining -= text.length;
    documents.push({
      type: "document",
      name: binary.name,
      mimeType: binary.mimeType,
      text,
      ...(truncated ? { truncated: true } : {}),
    });
    reports.push({
      name: binary.name,
      mimeType: binary.mimeType,
      characters: truncated ? cap : text.length,
      truncated,
    });
  }
  return { ok: true, documents, reports };
}

async function extractPdfText(bytes: Buffer, limit: number): Promise<{ text: string; truncated: boolean }> {
  const { getDocumentProxy } = await loadPdfModule();
  const pdf = await getDocumentProxy(new Uint8Array(bytes), { maxImageSize: MAX_IMAGE_BYTES });
  try {
    const pageCount = Math.min(pdf.numPages, MAX_PDF_PAGES);
    const parts: string[] = [];
    let length = 0;
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const pageText = content.items
          .map((item) => ("str" in item ? `${item.str}${item.hasEOL ? "\n" : " "}` : ""))
          .join("")
          .replace(/[ \t]{2,}/g, " ")
          .replace(/[ \t]+\n/g, "\n")
          .trim();
        if (pageText.length > 0) {
          parts.push(pageText);
          length += pageText.length + 2;
        }
      } finally {
        await page.cleanup();
      }
      if (length > limit) break;
    }
    const text = parts.join("\n\n");
    return { text, truncated: text.length > limit || pdf.numPages > pageCount };
  } finally {
    await pdf.cleanup();
  }
}

function extractDocxText(bytes: Buffer): { text: string; truncated: boolean } {
  const documentXml = readZipEntry(bytes, "word/document.xml");
  if (documentXml === undefined) {
    throw new Error("the .docx has no readable document body");
  }
  return { text: docxXmlToText(documentXml.toString("utf8")), truncated: false };
}

function readZipEntry(bytes: Buffer, entryName: string): Buffer | undefined {
  const eocd = findEndOfCentralDirectory(bytes);
  if (eocd < 0) return undefined;
  const entryCount = bytes.readUInt16LE(eocd + 10);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  if (centralOffset === 0xffffffff || entryCount === 0xffff) return undefined; // ZIP64 is not needed for Word files.
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) return undefined;
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    if (offset + 46 + nameLength > bytes.length) return undefined;
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (name === entryName) {
      if ((flags & 0x0001) !== 0) return undefined; // Encrypted.
      if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== 0x04034b50) return undefined;
      const localNameLength = bytes.readUInt16LE(localOffset + 26);
      const localExtraLength = bytes.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;
      if (dataEnd > bytes.length) return undefined;
      const data = bytes.subarray(dataStart, dataEnd);
      try {
        if (method === 0) return Buffer.from(data);
        if (method === 8) return inflateRawSync(data);
      } catch {
        return undefined;
      }
      return undefined;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return undefined;
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  if (bytes.length < 22) return -1;
  const minimum = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function docxXmlToText(xml: string): string {
  const body = xml
    .replace(/<w:instrText[\s\S]*?<\/w:instrText>/g, "")
    .replace(/<w:delText[\s\S]*?<\/w:delText>/g, "");
  const withBreaks = body
    .replace(/<w:tab\b[^>]*\/>/g, "\t")
    .replace(/<w:br\b[^>]*\/>/g, "\n")
    .replace(/<w:cr\b[^>]*\/>/g, "\n")
    .replace(/<w:noBreakHyphen\b[^>]*\/>/g, "-")
    .replace(/<\/w:tc>/g, "\t")
    .replace(/<\/w:tr>/g, "\n")
    .replace(/<\/w:p>/g, "\n");
  const text = withBreaks.replace(/<[^>]+>/g, "");
  return decodeXmlEntities(text)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (match, entity: string) => {
    if (entity === "amp") return "&";
    if (entity === "lt") return "<";
    if (entity === "gt") return ">";
    if (entity === "quot") return '"';
    if (entity === "apos") return "'";
    const codePoint = entity.startsWith("#x")
      ? Number.parseInt(entity.slice(2), 16)
      : entity.startsWith("#") ? Number.parseInt(entity.slice(1), 10) : Number.NaN;
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return match;
    }
  });
}

function normalizeExtractedText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
