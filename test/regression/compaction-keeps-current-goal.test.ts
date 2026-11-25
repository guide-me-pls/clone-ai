import assert from "node:assert/strict";
import test from "node:test";

import type { AgentMessage } from "../../src/agent/loop.ts";
import { compactTranscript } from "../../src/main-agent/context-window.ts";

// A transcript that ends in a tool result used to be compacted into nothing:
// the backward tail loop broke at the trailing `tool` message, so `keep` stayed
// empty, and the summary was sliced from the front of the dropped messages, so
// the newest user request was cut off. The current goal must survive.
// 以工具结果结尾的转录曾经被压成空：反向尾部循环在末尾的 `tool` 消息处直接中断，
// `keep` 为空；摘要又从被丢消息的前端截取，最新的用户请求被切掉。当前目标必须保留。

const CURRENT_REQUEST = "你来改代码：只把初始相机参数改成低视角斜望太和殿，其余不要动。";

test("compaction keeps the current user request when the transcript ends in a tool result", () => {
  const messages: AgentMessage[] = [
    { role: "system", content: "You are the Main Agent of Clone AI." },
  ];
  for (let index = 0; index < 149; index += 1) {
    messages.push({
      role: "user",
      content: `任务 ${String(index).padStart(2, "0")}：补完故宫页面的真实浏览器验收，实测首帧太和殿屏占比并记录三视角截图。`.repeat(3),
    });
    messages.push({
      role: "assistant",
      content: `任务 07 已完成：故宫页面首帧截图已保存，占比记录见 verify/selftest.json。`.repeat(3),
    });
  }
  messages.push({ role: "user", content: CURRENT_REQUEST });
  messages.push({
    role: "assistant",
    content: "",
    toolCalls: [{ id: "call-current", name: "read_file", arguments: JSON.stringify({ path: "src/main.js" }) }],
  });
  messages.push({ role: "tool", toolCallId: "call-current", content: "export const camera = { angle: 0 };" });

  const outcome = compactTranscript(messages, { estimatedTokens: 86_643 });

  assert.ok(outcome.keptMessages > 0, "a transcript ending in a tool result must keep a verbatim tail");
  const keptText = outcome.messages
    .map((message) => typeof message.content === "string" ? message.content : "")
    .join("\n");
  assert.ok(
    keptText.includes(CURRENT_REQUEST) || outcome.summary.includes(CURRENT_REQUEST),
    "the current user request must survive compaction verbatim, in the kept tail or in the summary",
  );
});
