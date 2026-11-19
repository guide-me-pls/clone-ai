/**
 * Audit usage-enrichment benchmark (no provider).
 *
 * Measures the optional Magpie usage fetch on the audit path: the first call
 * (cold gateway + 499 KB payload) and a second call inside the cache TTL. The
 * gateway is optional, so an offline machine returns an empty row set quickly;
 * the result is still meaningful as "the audit never blocks on a missing
 * gateway". Run it with the local gateway up for the cold/warm comparison.
 *
 * 审计用量补充基准（无 Provider）。
 *
 * 测量审计路径上可选的 Magpie 用量拉取：第一次（冷网关 + 499KB 载荷）与缓存 TTL 内的
 * 第二次。网关是可选的，离线机器会快速返回空行；结果仍能说明"审计从不因缺少网关而阻塞"。
 * 在本机网关运行时执行，才能得到冷/热对比。
 */
import { performance } from "node:perf_hooks";

import { fetchGatewayRows, resetGatewayUsageCache } from "../src/integrations/magpie-usage.ts";

resetGatewayUsageCache();
const started = performance.now();
const first = await fetchGatewayRows();
const firstMs = performance.now() - started;
const cachedStart = performance.now();
const second = await fetchGatewayRows();
const secondMs = performance.now() - cachedStart;

console.log(JSON.stringify({
  kind: "audit-usage-benchmark",
  date: new Date().toISOString(),
  provider: "none",
  machine: {
    platform: process.platform,
    node: process.version,
  },
  parameters: {
    limit: 500,
    cacheTtlMs: 15_000,
    timeoutMs: 1_000,
  },
  metrics: {
    firstMs: Math.round(firstMs),
    secondMs: Math.round(secondMs),
    rows: first.length,
    cachedRows: second.length,
  },
  notes: [
    "This measures the gateway usage fetch, not the full /api/audit projection (~60 ms on the live journal).",
    "The gateway is optional; without it the first call returns an empty row set and the cache keeps repeats fast.",
  ],
}, null, 2));