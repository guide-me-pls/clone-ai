/**
 * Gateway usage enrichment: cache, expiry and the bounded optional wait.
 *
 * The audit list treats gateway usage as optional enrichment. These tests pin
 * that repeated audit opens reuse the cached rows, the cache expires, a hanging
 * gateway is cut off by the timeout, and a failed gateway is cached as empty so
 * it cannot make every open wait.
 *
 * 网关用量补充：缓存、过期与有界的可选等待。
 *
 * 审计列表把网关用量当作可选补充。这些测试钉住：重复打开审计复用缓存行、缓存会过期、
 * 悬挂的网关被超时切断、失败的网关缓存为空，因此不会让每次打开都等待。
 */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { fetchGatewayRows, resetGatewayUsageCache } from "../src/integrations/magpie-usage.ts";

const row = { t: new Date().toISOString(), agent: "claude", status: 200 };

test("repeated audit opens reuse the cached gateway rows", async () => {
  resetGatewayUsageCache();
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ rows: [row] }), { status: 200 });
  }) as typeof fetch;
  const first = await fetchGatewayRows({ endpoint: "http://127.0.0.1:9", fetchImpl, cacheTtlMs: 1_000 });
  const second = await fetchGatewayRows({ endpoint: "http://127.0.0.1:9", fetchImpl, cacheTtlMs: 1_000 });
  assert.equal(calls, 1);
  assert.deepEqual(second, first);
  assert.equal(second.length, 1);
});

test("the gateway row cache expires", async () => {
  resetGatewayUsageCache();
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ rows: [row] }), { status: 200 });
  }) as typeof fetch;
  await fetchGatewayRows({ endpoint: "http://127.0.0.1:9", fetchImpl, cacheTtlMs: 1 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await fetchGatewayRows({ endpoint: "http://127.0.0.1:9", fetchImpl, cacheTtlMs: 1 });
  assert.equal(calls, 2);
});

test("a hanging gateway is cut off by the bounded optional wait", async () => {
  resetGatewayUsageCache();
  const fetchImpl = ((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (signal === null || signal === undefined) return;
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  })) as typeof fetch;
  const started = performance.now();
  const rows = await fetchGatewayRows({
    endpoint: "http://127.0.0.1:9",
    fetchImpl,
    timeoutMs: 30,
    cacheTtlMs: 0,
  });
  assert.deepEqual(rows, []);
  assert.ok(performance.now() - started < 500, "the timeout must not wait for the full gateway");
});

test("a failed gateway is cached as empty so repeated opens do not wait", async () => {
  resetGatewayUsageCache();
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    throw new Error("gateway down");
  }) as typeof fetch;
  assert.deepEqual(await fetchGatewayRows({ endpoint: "http://127.0.0.1:9", fetchImpl, cacheTtlMs: 1_000 }), []);
  assert.deepEqual(await fetchGatewayRows({ endpoint: "http://127.0.0.1:9", fetchImpl, cacheTtlMs: 1_000 }), []);
  assert.equal(calls, 1);
});