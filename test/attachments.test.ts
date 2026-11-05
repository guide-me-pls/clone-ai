import assert from "node:assert/strict";
import test from "node:test";

import { parseAttachments } from "../src/main-agent/attachments.ts";

const png = (() => {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([header, Buffer.from("payload")]).toString("base64");
})();

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

test("no attachments means an empty, successful result", () => {
  const result = parseAttachments(undefined);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.images, []);
});
