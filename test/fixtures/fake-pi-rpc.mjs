let buffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const line = buffer.slice(0, newline).replace(/\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (line.length === 0) continue;
    const command = JSON.parse(line);
    if (command.type === "abort") {
      process.stdout.write(`${JSON.stringify({ type: "response", command: "abort", success: true })}\n`);
      continue;
    }
    if (command.type !== "prompt") continue;
    process.stdout.write(`${JSON.stringify({ type: "response", command: "prompt", success: true, id: command.id })}\n`);
    process.stdout.write(`${JSON.stringify({ type: "agent_start" })}\n`);
    process.stdout.write(`${JSON.stringify({ type: "turn_start" })}\n`);
    process.stdout.write(`${JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Fixture Pi completed." },
    })}\n`);
    process.stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
  }
});
