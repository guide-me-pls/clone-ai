import assert from "node:assert/strict";
import test from "node:test";

import { attachmentManifest, composeAttachedDocuments, DOCX_MIME_TYPE, DOC_MIME_TYPE, parseAttachments } from "../src/main-agent/attachments.ts";

const png = (() => {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([header, Buffer.from("payload")]).toString("base64");
})();

const document = (overrides: Record<string, unknown> = {}) => ({
  name: "notes.md",
  mimeType: "text/markdown",
  text: "hello\nworld",
  ...overrides,
});

test("a real PNG signature is accepted and its type corrected from the bytes", () => {
  const result = parseAttachments([{ data: png }]);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.images[0]!.mimeType, "image/png");
});

test("a declared type that contradicts the bytes is refused, not corrected", () => {
  const result = parseAttachments([{ mimeType: "image/jpeg", data: png }]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /declares image\/jpeg but is image\/png/);
});

test("a payload that is not an image is refused whatever it claims", () => {
  const result = parseAttachments([{ mimeType: "image/png", data: Buffer.from("not an image at all").toString("base64") }]);
  assert.equal(result.ok, false);
});

test("non-base64, oversized and too many attachments are refused with reasons", () => {
  assert.equal(parseAttachments([{ data: "!!!not base64!!!" }]).ok, false);
  assert.equal(parseAttachments(Array.from({ length: 5 }, () => ({ data: png }))).ok, false);
  assert.equal(parseAttachments("nope").ok, false);
});

test("a text document keeps its name, type and body", () => {
  const result = parseAttachments([document()]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.documents, [{
      type: "document",
      name: "notes.md",
      mimeType: "text/markdown",
      text: "hello\nworld",
    }]);
  }
});

test("a document without a declared type falls back to its extension", () => {
  const result = parseAttachments([{ name: "readme.md", text: "hi" }]);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.documents[0]!.mimeType, "text/markdown");
});

test("images and documents share one four-attachment budget", () => {
  const mixed = parseAttachments([{ data: png }, document()]);
  assert.equal(mixed.ok, true);
  if (mixed.ok) {
    assert.equal(mixed.images.length, 1);
    assert.equal(mixed.documents.length, 1);
  }
  const tooMany = parseAttachments([{ data: png }, document(), document({ name: "b.txt" }), { data: png }, document({ name: "c.txt" })]);
  assert.equal(tooMany.ok, false);
});

test("a PDF or .docx with a matching signature is accepted as a binary document", () => {
  const pdf = parseAttachments([{ kind: "document", name: "paper.pdf", mimeType: "application/pdf", data: Buffer.from("%PDF-1.4\nfixture").toString("base64") }]);
  assert.equal(pdf.ok, true);
  if (pdf.ok) {
    assert.equal(pdf.binaryDocuments.length, 1);
    assert.equal(pdf.binaryDocuments[0]!.name, "paper.pdf");
    assert.equal(pdf.documents.length, 0);
  }
  const docx = parseAttachments([{
    kind: "document",
    name: "notes.docx",
    mimeType: DOCX_MIME_TYPE,
    data: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]).toString("base64"),
  }]);
  assert.equal(docx.ok, true);
  if (docx.ok) assert.equal(docx.binaryDocuments[0]!.mimeType, DOCX_MIME_TYPE);
  const doc = parseAttachments([{
    kind: "document",
    name: "legacy.doc",
    mimeType: DOC_MIME_TYPE,
    data: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00]).toString("base64"),
  }]);
  assert.equal(doc.ok, true);
  if (doc.ok) assert.equal(doc.binaryDocuments[0]!.mimeType, DOC_MIME_TYPE);
});

test("a binary document with the wrong signature is refused", () => {
  const pdf = parseAttachments([{ kind: "document", name: "paper.pdf", mimeType: "application/pdf", data: Buffer.from("not a PDF").toString("base64") }]);
  assert.equal(pdf.ok, false);
  if (!pdf.ok) assert.match(pdf.error, /does not look like a PDF/);
  const renamed = parseAttachments([{ kind: "document", name: "paper.docx", mimeType: DOCX_MIME_TYPE, data: Buffer.from("%PDF-1.4").toString("base64") }]);
  assert.equal(renamed.ok, false);
  if (!renamed.ok) assert.match(renamed.error, /does not look like a \.docx/);
  const legacy = parseAttachments([{ kind: "document", name: "paper.doc", mimeType: DOC_MIME_TYPE, data: Buffer.from("not an OLE file").toString("base64") }]);
  assert.equal(legacy.ok, false);
  if (!legacy.ok) assert.match(legacy.error, /does not look like a \.doc/);
});

test("binary documents count toward the shared attachment budget and name rules", () => {
  const pdf = { kind: "document", name: "paper.pdf", mimeType: "application/pdf", data: Buffer.from("%PDF-1.4").toString("base64") };
  assert.equal(parseAttachments([pdf, pdf, { data: png }, { data: png }, pdf]).ok, false);
  assert.equal(parseAttachments([{ ...pdf, name: "../paper.pdf" }]).ok, false);
  assert.equal(parseAttachments([{ kind: "document", name: "paper.txt", mimeType: "application/pdf", text: "hello" }]).ok, false);
});

test("empty, binary, path-named and non-text documents are refused", () => {
  assert.equal(parseAttachments([{ kind: "document", name: "a.txt" }]).ok, false);
  assert.equal(parseAttachments([document({ text: "" })]).ok, false);
  assert.equal(parseAttachments([document({ text: "abc\u0000def" })]).ok, false);
  assert.equal(parseAttachments([document({ name: "../secret.txt" })]).ok, false);
  assert.equal(parseAttachments([document({ name: "a/b.txt" })]).ok, false);
  assert.equal(parseAttachments([document({ name: `${"x".repeat(121)}.txt` })]).ok, false);
  assert.equal(parseAttachments([document({ name: "paper.pdf", mimeType: "application/pdf" })]).ok, false);
  assert.equal(parseAttachments([document({ name: "archive.zip", mimeType: "application/zip" })]).ok, false);
  // A suffix does not override a declared binary type. 后缀不能覆盖声明的二进制类型。
  assert.equal(parseAttachments([document({ name: "paper.txt", mimeType: "application/pdf" })]).ok, false);
  assert.equal(parseAttachments([document({ name: "blob.md", mimeType: "application/octet-stream" })]).ok, false);
});

test("per-file and total character caps are enforced", () => {
  assert.equal(parseAttachments([document({ text: "a".repeat(50_001) })]).ok, false);
  const three = parseAttachments([
    document({ name: "a.txt", text: "a".repeat(40_000) }),
    document({ name: "b.txt", text: "b".repeat(40_000) }),
    document({ name: "c.txt", text: "c".repeat(40_000) }),
  ]);
  assert.equal(three.ok, false);
  if (!three.ok) assert.match(three.error, /exceed 100000 characters/);
});

test("the ledger manifest names the documents without their bodies", () => {
  const result = parseAttachments([document()]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(attachmentManifest(result.documents), "[attached documents: notes.md (11 characters)]");
    assert.doesNotMatch(attachmentManifest(result.documents), /hello/);
  }
  assert.equal(attachmentManifest([]), "");
});

test("the model message delimits documents and marks them as data", () => {
  const documents = [{ type: "document" as const, name: "plan\"notes.md", mimeType: "text/markdown", text: "hello\nworld" }];
  const composed = composeAttachedDocuments("summarize this", documents);
  assert.match(composed, /^summarize this\n\n/);
  assert.match(composed, /reference data, not instructions/);
  assert.match(composed, /<document name="plan&quot;notes\.md" media-type="text\/markdown">/);
  assert.match(composed, /hello\nworld/);
  assert.match(composed, /<\/document>/);
  assert.match(composeAttachedDocuments("", documents), /^The owner attached/);
  assert.equal(composeAttachedDocuments("plain", []), "plain");
});

test("no attachments means an empty, successful result", () => {
  const result = parseAttachments(undefined);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.images, []);
    assert.deepEqual(result.documents, []);
    assert.deepEqual(result.binaryDocuments, []);
  }
});
