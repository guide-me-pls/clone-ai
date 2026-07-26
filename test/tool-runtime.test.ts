import assert from "node:assert/strict";
import test from "node:test";

import { ToolRegistry } from "../src/loop/tools.ts";
import { ToolRuntime } from "../src/loop/tool-runtime.ts";

test("the tool runtime cancels a cooperative tool by its stable operation ID", async () => {
  const runtime = new ToolRuntime(new ToolRegistry([
    {
      schema: {
        type: "function",
        name: "wait_forever",
        description: "Wait until the runtime cancels it.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        strict: true,
      },
      risk: "read_only",
      async execute(_arguments, context) {
        return new Promise((_, reject) => {
          context?.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
        });
      },
    },
  ]));
  const operationId = runtime.createOperationId();
  const pending = runtime.execute({
    runId: "00000000-0000-0000-0000-000000000004",
    call: { id: "wait-call", name: "wait_forever", arguments: {} },
    operationId,
  });

  assert.equal(await runtime.cancel(operationId), true);
  const outcome = await pending;
  assert.equal(outcome.result.ok, false);
  assert.match(outcome.result.content, /cancelled/i);
});
