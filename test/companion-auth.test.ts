import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  authorizeCompanionRequest,
  clearCompanionEndpoint,
  injectCompanionToken,
  isLoopbackHostname,
  loopbackHostname,
  normalizeCompanionHost,
  originIsLoopback,
  persistCompanionEndpoint,
  readCompanionEndpoint,
  tokensMatch,
} from "../src/companion-auth.ts";

test("loopback hostnames are the only accepted Host values", () => {
  assert.equal(loopbackHostname("127.0.0.1:4317"), "127.0.0.1");
  assert.equal(loopbackHostname("localhost:4317"), "localhost");
  assert.equal(isLoopbackHostname("127.0.0.1"), true);
  assert.equal(isLoopbackHostname("evil.example"), false);
  assert.equal(loopbackHostname("[::1]:4317"), "::1");
  assert.equal(originIsLoopback("http://[::1]:4317", 4317), true);
});

test("a remote Host cannot retrieve the HTML containing the local bearer", () => {
  const result = authorizeCompanionRequest({
    method: "GET", pathname: "/", hostHeader: "evil.example:4317", originHeader: undefined,
    authorization: undefined, token: "secret", listenPort: 4317,
  });
  assert.deepEqual(result, { ok: false, status: 403, error: "Companion APIs are loopback-only." });
});

test("the local companion only accepts a literal loopback bind", () => {
  assert.throws(() => normalizeCompanionHost("0.0.0.0"), /loopback/i);
  assert.throws(() => normalizeCompanionHost("192.0.2.1"), /loopback/i);
  assert.equal(normalizeCompanionHost("localhost"), "127.0.0.1");
  assert.equal(normalizeCompanionHost("::1"), "::1");
});

test("an Origin on another host or port is refused", () => {
  assert.equal(originIsLoopback(undefined, 4317), true);
  assert.equal(originIsLoopback("http://127.0.0.1:4317", 4317), true);
  assert.equal(originIsLoopback("http://127.0.0.1:9999", 4317), false);
  assert.equal(originIsLoopback("http://example.com", 4317), false);
});

test("bearer comparison is length-safe and rejects a missing token", () => {
  assert.equal(tokensMatch("abcd", "abcd"), true);
  assert.equal(tokensMatch("abcd", "abce"), false);
  assert.equal(tokensMatch("abcd", undefined), false);
});

test("unauthenticated approve is 401; a non-loopback Host is 403", () => {
  const denied = authorizeCompanionRequest({
    method: "POST",
    pathname: "/api/runs/run-1/approve",
    hostHeader: "127.0.0.1:4317",
    originHeader: undefined,
    authorization: undefined,
    token: "secret",
    listenPort: 4317,
  });
  assert.deepEqual(denied, { ok: false, status: 401, error: "Companion APIs require a bearer token." });

  const foreign = authorizeCompanionRequest({
    method: "POST",
    pathname: "/api/runs/run-1/approve",
    hostHeader: "evil.example",
    originHeader: undefined,
    authorization: "Bearer secret",
    token: "secret",
    listenPort: 4317,
  });
  assert.deepEqual(foreign, { ok: false, status: 403, error: "Companion APIs are loopback-only." });
});

test("health and the GUI assets stay reachable without a bearer", () => {
  for (const pathname of ["/", "/style.css", "/components.css", "/app.js", "/components.js", "/api/health"]) {
    const allowed = authorizeCompanionRequest({
      method: "GET",
      pathname,
      hostHeader: "127.0.0.1:4317",
      originHeader: undefined,
      authorization: undefined,
      token: "secret",
      listenPort: 4317,
    });
    assert.equal(allowed.ok, true, pathname);
  }
});

test("server mode permits a public Host only when explicitly enabled", () => {
  const publicRequest = {
    method: "GET",
    pathname: "/api/config",
    hostHeader: "agent.example.com",
    originHeader: "https://agent.example.com",
    authorization: "Bearer secret",
    token: "secret",
    listenPort: 4317,
  } as const;
  assert.equal(authorizeCompanionRequest(publicRequest).ok, false);
  assert.equal(authorizeCompanionRequest({ ...publicRequest, allowRemoteHost: true }).ok, true);
  assert.equal(authorizeCompanionRequest({
    ...publicRequest,
    allowRemoteHost: true,
    authorization: undefined,
  }).ok, false);
});

test("the served HTML receives the companion token", () => {
  const html = injectCompanionToken("<html><head></head><body></body></html>", "tok");
  assert.match(html, /window\.CLONE_AI_TOKEN="tok"/);
});

test("a companion endpoint file can only publish a loopback origin", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-endpoint-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  await assert.rejects(
    persistCompanionEndpoint(directory, "http://192.0.2.1:4317"),
    /loopback/i,
  );
  await persistCompanionEndpoint(directory, "http://127.0.0.1:4317");
  const endpoint = await readCompanionEndpoint(directory);
  assert.equal(endpoint?.url, "http://127.0.0.1:4317");
  assert.equal(endpoint?.pid, process.pid);
  await clearCompanionEndpoint(directory);
  assert.equal(await readCompanionEndpoint(directory), undefined);
});
