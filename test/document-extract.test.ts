import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { DOCX_MIME_TYPE } from "../src/main-agent/attachments.ts";
import { extractBinaryDocuments } from "../src/main-agent/document-extract.ts";

async function fixture(name: string): Promise<string> {
  return (await readFile(join(process.cwd(), "test", "fixtures", name), "utf8")).trim();
}

function binary(name: string, mimeType: string, data: string) {
  return { type: "binary-document" as const, name, mimeType, data };
}

test("a PDF's text is extracted into a document for the turn", async () => {
  const result = await extractBinaryDocuments([binary("sample.pdf", "application/pdf", await fixture("sample.pdf.b64"))], {
    remainingCharacters: 1_000,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.documents.length, 1);
    assert.equal(result.documents[0]!.name, "sample.pdf");
    assert.match(result.documents[0]!.text, /Hello from a PDF fixture/);
    assert.match(result.documents[0]!.text, /Second line with Tom & Jerry/);
    assert.equal(result.reports[0]!.truncated, false);
  }
});

test("a .docx's paragraphs and XML entities are extracted", async () => {
  const result = await extractBinaryDocuments([binary("sample.docx", DOCX_MIME_TYPE, await fixture("sample.docx.b64"))], {
    remainingCharacters: 1_000,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.match(result.documents[0]!.text, /Hello from a PDF fixture/);
    assert.match(result.documents[0]!.text, /Second line with Tom & Jerry/);
    assert.equal(result.documents[0]!.mimeType, DOCX_MIME_TYPE);
  }
});

test("an image-only PDF is refused instead of producing an empty document", async () => {
  const result = await extractBinaryDocuments([binary("scanned.pdf", "application/pdf", await fixture("scanned.pdf.b64"))], {
    remainingCharacters: 1_000,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /no extractable text.*OCR/);
});

test("a document longer than the budget is truncated with a marker and a report", async () => {
  const result = await extractBinaryDocuments([binary("sample.pdf", "application/pdf", await fixture("sample.pdf.b64"))], {
    remainingCharacters: 20,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.documents[0]!.truncated, true);
    assert.match(result.documents[0]!.text, /document truncated after 20 characters/);
    assert.equal(result.reports[0]!.truncated, true);
    assert.equal(result.reports[0]!.characters, 20);
  }
});

test("a .docx without a document body is refused", async () => {
  const result = await extractBinaryDocuments([binary("broken.docx", DOCX_MIME_TYPE, await fixture("sample.pdf.b64"))], {
    remainingCharacters: 1_000,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /no readable document body/);
});

test("a consumed budget refuses another document instead of dropping it", async () => {
  const pdf = await fixture("sample.pdf.b64");
  const result = await extractBinaryDocuments([
    binary("first.pdf", "application/pdf", pdf),
    binary("second.pdf", "application/pdf", pdf),
  ], { remainingCharacters: 20 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /exceed 100000 characters/);
});
