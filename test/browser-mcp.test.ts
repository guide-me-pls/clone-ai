import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  BROWSER_MCP_POLICY_ID,
  BROWSER_MCP_SERVER_ID,
  browserMcpInstructions,
  browserMcpPolicy,
  browserMcpServer,
  browserMcpTools,
  isLocalPreviewUrl,
  mergeAuthority,
  mergeMcpConfig,
} from "../src/integrations/browser-mcp.ts";

describe("browser MCP declaration", () => {
  test("the server is local, enabled and rooted at the workspace", () => {
    const server = browserMcpServer("/tmp/project", 8135);
    assert.equal(server.id, BROWSER_MCP_SERVER_ID);
    assert.equal(server.enabled, true);
    assert.equal(server.transport, "stdio");
    assert.equal(server.command, "npx");
    assert.equal(server.cwd, "/tmp/project");
    assert.ok(server.args?.includes("--headless"));
    assert.ok(server.args?.includes("chrome"));
    assert.ok(server.args?.includes("http://127.0.0.1:8135"));
    assert.ok(server.args?.includes("--isolated"));
    assert.ok(server.args?.includes("--ignore-roots"));
    assert.ok(server.args?.includes("--output-dir"));
  });

  test("only the observation subset is declared", () => {
    const names = browserMcpTools(8135).map((tool) => tool.name);
    for (const required of ["browser_navigate", "browser_console_messages", "browser_snapshot", "browser_evaluate", "browser_take_screenshot", "browser_press_key"]) {
      assert.ok(names.includes(required), `${required} missing`);
    }
    assert.equal(names.includes("browser_run_code_unsafe"), false, "RCE-equivalent tool must stay undeclared");
    assert.equal(names.includes("browser_file_upload"), false, "file upload must stay undeclared");
    assert.equal(names.includes("browser_drop"), false, "drop must stay undeclared");
  });

  test("every tool has a risk and every description names its arguments", () => {
    for (const tool of browserMcpTools(8135)) {
      assert.ok(tool.risk === "read" || tool.risk === "write", `${tool.name} has risk ${tool.risk}`);
      assert.ok((tool.description ?? "").length > 30, `${tool.name} description too short`);
    }
    const screenshot = browserMcpTools(8135).find((tool) => tool.name === "browser_take_screenshot");
    assert.equal(screenshot?.risk, "write");
    assert.equal(screenshot?.pathField, "filename");
    const navigate = browserMcpTools(8135).find((tool) => tool.name === "browser_navigate");
    assert.equal(navigate?.risk, "read");
  });

  test("the policy is one local host, read, act_auto, and stable by id", () => {
    const policy = browserMcpPolicy(new Date("2026-01-01T00:00:00Z"));
    assert.equal(policy.id, BROWSER_MCP_POLICY_ID);
    assert.equal(policy.maxAutonomy, "act_auto");
    assert.deepEqual(policy.scopes, [{ domain: "network", resource: "127.0.0.1", access: "read" }]);
    assert.equal(policy.createdAt, "2026-01-01T00:00:00.000Z");
  });

  test("mergeMcpConfig preserves other servers and replaces this one", () => {
    const existing = {
      servers: [
        { id: "other", enabled: true, command: "foo" },
        { id: BROWSER_MCP_SERVER_ID, enabled: false, command: "old" },
      ],
    };
    const merged = mergeMcpConfig(existing, browserMcpServer("/w", 9000));
    assert.equal(merged.servers.length, 2);
    assert.ok(merged.servers.some((server) => server.id === "other"));
    const browser = merged.servers.find((server) => server.id === BROWSER_MCP_SERVER_ID);
    assert.equal(browser?.enabled, true);
    assert.equal(browser?.cwd, "/w");
    assert.deepEqual(mergeMcpConfig(merged, browserMcpServer("/w", 9000)), merged, "idempotent");
    assert.deepEqual(mergeMcpConfig(undefined, browserMcpServer("/w", 9000)).servers.length, 1);
  });

  test("mergeAuthority preserves domains and other policies and is idempotent", () => {
    const existing = {
      version: 1,
      domains: { files: "act_auto" },
      policies: [{ id: "keep", label: "keep", scopes: [], maxAutonomy: "observe", createdAt: "2026-01-01T00:00:00.000Z" }],
    };
    const policy = browserMcpPolicy(new Date("2026-01-02T00:00:00Z"));
    const merged = mergeAuthority(existing, policy);
    assert.equal(merged.domains.files, "act_auto");
    assert.ok(merged.policies.some((entry) => entry.id === "keep"));
    assert.equal(merged.policies.filter((entry) => entry.id === BROWSER_MCP_POLICY_ID).length, 1);
    assert.deepEqual(mergeAuthority(merged, policy), merged);
  });

  test("only the exact local preview URL is accepted", () => {
    assert.equal(isLocalPreviewUrl("http://127.0.0.1:8135/", 8135), true);
    assert.equal(isLocalPreviewUrl("http://127.0.0.1:8135/index.html", 8135), true);
    assert.equal(isLocalPreviewUrl("http://127.0.0.1:8136/", 8135), false);
    assert.equal(isLocalPreviewUrl("http://localhost:8135/", 8135), false);
    assert.equal(isLocalPreviewUrl("https://127.0.0.1:8135/", 8135), false);
    assert.equal(isLocalPreviewUrl("file:///etc/passwd", 8135), false);
    assert.equal(isLocalPreviewUrl("not a url", 8135), false);
  });

  test("workspace instructions are one short paragraph and name the URL", () => {
    const text = browserMcpInstructions(8135);
    assert.match(text, /127\.0\.0\.1:8135/);
    assert.match(text, /browser_navigate/);
    assert.match(text, /browser_console_messages/);
    assert.match(text, /browser_evaluate/);
    assert.ok(text.length < 900);
  });
});
