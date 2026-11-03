import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectMagpieGateway,
  normalizeLoopbackEndpoint,
} from "../src/integrations/magpie-gateway.ts";

test("Magpie detection reads only the public local status and model routes", async () => {
  const requested: string[] = [];
  const fetchImpl = async (input: string | URL | globalThis.Request): Promise<Response> => {
    const url = String(input);
    requested.push(url);
    if (url === "http://127.0.0.1:3425/") {
      return Response.json({
        name: "magpie",
        version: "0.1.2173",
        models: 2,
        apis: ["/v1/responses", "/v1/messages"],
      });
    }
    if (url === "http://127.0.0.1:3425/v1/models") {
      return Response.json({
        data: [
          { id: "360/vendor/model-a", display_name: "Model A", owned_by: "360", reasoning: true },
          { id: "360/vendor/model-b", display_name: "Model B", modalities: { input: ["text", "image"] } },
        ],
      });
    }
    return new Response("not found", { status: 404 });
  };

  const status = await inspectMagpieGateway({
    endpoint: "http://127.0.0.1:3425",
    fetchImpl: fetchImpl as typeof fetch,
  });

  assert.equal(status.running, true);
  assert.equal(status.version, "0.1.2173");
  assert.equal(status.modelCount, 2);
  assert.deepEqual(status.models.map((model) => model.id), ["360/vendor/model-a", "360/vendor/model-b"]);
  assert.deepEqual(requested, ["http://127.0.0.1:3425/", "http://127.0.0.1:3425/v1/models"]);
  assert.doesNotMatch(JSON.stringify(status), /api.?key|sk-/i);
});

test("Magpie detection reports an unreachable gateway without failing the API", async () => {
  const fetchImpl = async (): Promise<Response> => {
    throw new Error("connection refused");
  };
  const status = await inspectMagpieGateway({
    fetchImpl: fetchImpl as typeof fetch,
    timeoutMs: 20,
  });
  assert.equal(status.running, false);
  assert.match(status.error ?? "", /connection refused/);
});

test("gateway endpoint overrides cannot escape loopback", () => {
  assert.equal(normalizeLoopbackEndpoint("https://example.com/v1"), "http://127.0.0.1:3425");
  assert.equal(normalizeLoopbackEndpoint("http://localhost:4000/v1"), "http://localhost:4000");
  assert.equal(normalizeLoopbackEndpoint("http://[::1]:4000/v1"), "http://[::1]:4000");
});
