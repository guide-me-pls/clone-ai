import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { DailyReportRunner, localDayKey } from "../src/reporting/daily-report-runner.ts";
import { buildDailyReport } from "../src/reporting/daily-report.ts";
import { sendEmail } from "../src/reporting/smtp-sender.ts";
import { JsonlJournalStore } from "../src/core/journal.ts";

/** A scripted SMTP server that records the conversation for assertions. 记录对话的脚本化 SMTP 服务器。 */
async function fakeSmtp(t: TestContext, options: { advertiseStartTls?: boolean; rejectMail?: boolean } = {}): Promise<{ port: number; transcript: string[] }> {
  const transcript: string[] = [];
  const server = createServer((socket: Socket) => {
    socket.write("220 fake.local ESMTP\r\n");
    let inData = false;
    let dataLines: string[] = [];
    socket.on("data", (chunk) => {
      for (const line of chunk.toString("utf8").split("\r\n")) {
        if (line.length === 0) continue;
        transcript.push(line);
        if (inData) {
          if (line === ".") {
            inData = false;
            socket.write("250 OK queued\r\n");
          } else {
            dataLines.push(line);
          }
          continue;
        }
        if (line.startsWith("EHLO")) socket.write(`250-fake.local\r\n${options.advertiseStartTls ? "250-STARTTLS\r\n" : ""}250 AUTH LOGIN\r\n`);
        else if (line === "STARTTLS") socket.write("454 TLS temporarily unavailable\r\n");
        else if (line === "AUTH LOGIN") socket.write("334 VXNlcm5hbWU6\r\n");
        else if (line === "dXNlcg==") socket.write("334 UGFzc3dvcmQ6\r\n");
        else if (line === "cGFzcw==") socket.write("235 authenticated\r\n");
        else if (line.startsWith("MAIL FROM") && options.rejectMail) setTimeout(() => socket.write("550 sender rejected\r\n"), 10);
        else if (line.startsWith("MAIL FROM") || line.startsWith("RCPT TO")) socket.write("250 OK\r\n");
        else if (line === "DATA") { inData = true; socket.write("354 End data\r\n"); }
        else if (line === "QUIT") socket.write("221 bye\r\n");
        else socket.write("250 OK\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  return { port: address.port, transcript };
}

const smtpFor = (port: number) => ({
  host: "127.0.0.1",
  port,
  from: "clone-ai@local",
  to: "owner@example.com",
});

test("sendEmail completes the full SMTP conversation", async (t) => {
  const { port, transcript } = await fakeSmtp(t);

  await sendEmail(smtpFor(port), { subject: "主题", text: "正文" });

  assert.ok(transcript.some((line) => line.startsWith("EHLO")));
  assert.ok(!transcript.includes("AUTH LOGIN"));
  assert.ok(transcript.some((line) => line.startsWith("MAIL FROM:<clone-ai@local>")));
  assert.ok(transcript.some((line) => line.startsWith("RCPT TO:<owner@example.com>")));
  assert.ok(transcript.some((line) => line === "QUIT"));
  const dataStart = transcript.indexOf("DATA");
  assert.ok(dataStart >= 0);
  const data = transcript.slice(dataStart + 1).join("\n");
  assert.match(data, /From: clone-ai@local/);
  assert.match(data, /To: owner@example.com/);
  assert.match(data, /Subject: 主题/);
  assert.match(data, /正文/);
});

test("SMTP never sends credentials over a plaintext connection", async (t) => {
  const { port, transcript } = await fakeSmtp(t);
  await assert.rejects(sendEmail({ ...smtpFor(port), user: "user", pass: "pass" }, { subject: "test", text: "test" }), /TLS/i);
  assert.equal(transcript.includes("AUTH LOGIN"), false);
});

test("SMTP rejects remote plaintext and newline injection before opening a connection", async () => {
  await assert.rejects(sendEmail({ ...smtpFor(25), host: "example.com" }, { subject: "test", text: "test" }), /TLS/i);
  await assert.rejects(sendEmail({ ...smtpFor(1), from: "a@local\r\nRCPT TO:b@local" }, { subject: "test", text: "test" }), /control characters/i);
  await assert.rejects(sendEmail(smtpFor(1), { subject: "test\r\nBcc: b@local", text: "test" }), /control characters/i);
});

test("a requested STARTTLS upgrade fails closed if the server omits it", async (t) => {
  const { port, transcript } = await fakeSmtp(t);
  await assert.rejects(sendEmail({ ...smtpFor(port), startTls: true, user: "user", pass: "pass" }, { subject: "test", text: "test" }), /STARTTLS/i);
  assert.equal(transcript.includes("AUTH LOGIN"), false);
  assert.equal(transcript.some((line) => line.startsWith("MAIL FROM")), false);
});

test("STARTTLS advertised on an intermediate EHLO line is attempted", async (t) => {
  const { port, transcript } = await fakeSmtp(t, { advertiseStartTls: true });
  await assert.rejects(sendEmail({ ...smtpFor(port), startTls: true }, { subject: "test", text: "test" }), /454|TLS/i);
  assert.ok(transcript.includes("STARTTLS"));
  assert.equal(transcript.some((line) => line.startsWith("MAIL FROM")), false);
});

test("an asynchronously received SMTP error is not mistaken for success", async (t) => {
  const { port, transcript } = await fakeSmtp(t, { rejectMail: true });
  await assert.rejects(sendEmail(smtpFor(port), { subject: "test", text: "test" }), /550/);
  assert.equal(transcript.some((line) => line.startsWith("RCPT TO")), false);
});

test("buildDailyReport lists yesterday's bad cases with journal sequences", () => {
  const report = buildDailyReport({
    date: new Date("2026-08-19T09:00:00.000Z"),
    events: [
      { id: "a", sequence: 12, type: "run.status_changed", occurredAt: "2026-08-18T10:00:00.000Z", runId: "r1", payload: { status: "failed", reason: "Worker exhausted its budget." } },
      { id: "b", sequence: 13, type: "dispatch.blocked", occurredAt: "2026-08-18T11:00:00.000Z", payload: { reason: "codex not installed" } },
      { id: "c", sequence: 14, type: "run.status_changed", occurredAt: "2026-08-18T12:00:00.000Z", runId: "r2", payload: { status: "completed" } },
    ],
    opportunities: [{ title: "承诺即将到期：提交季度报告", whyNow: "24 小时内", source: "deadline" }],
  });

  assert.equal(report.counts.badCases, 2);
  assert.match(report.text, /\[seq 12\] run.status_changed \(run r1\)/);
  assert.match(report.text, /\[seq 13\] dispatch.blocked/);
  assert.doesNotMatch(report.text, /seq 14/);
  assert.match(report.text, /承诺即将到期/);
});

test("DailyReportRunner sends once per local day and skips afterwards", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-report-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const { port, transcript } = await fakeSmtp(t);
  const journal = new JsonlJournalStore(join(directory, "journal.jsonl"));
  let now = new Date("2026-08-19T09:00:00.000Z");
  const runner = new DailyReportRunner({
    journal,
    dataDirectory: directory,
    settings: { enabled: true, smtp: smtpFor(port) },
    opportunities: async () => [],
    now: () => now,
  });

  assert.equal(await runner.maybeSend(), "sent");
  assert.equal(await runner.maybeSend(), "skipped");
  const before = transcript.length;

  // A second day sends again.
  // 第二天会再次发送。
  now = new Date("2026-08-20T09:00:00.000Z");
  assert.equal(await runner.maybeSend(), "sent");
  assert.ok(transcript.length > before);
});

test("disabled reporting never sends and does not write a marker", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-report-off-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const journal = new JsonlJournalStore(join(directory, "journal.jsonl"));
  const runner = new DailyReportRunner({
    journal,
    dataDirectory: directory,
    settings: { enabled: false, smtp: { host: "127.0.0.1", port: 1, from: "a@b", to: "c@d" } },
    opportunities: async () => [],
    now: () => new Date("2026-08-19T09:00:00.000Z"),
  });

  assert.equal(await runner.maybeSend(), "disabled");
  const fs = await import("node:fs/promises");
  await assert.rejects(fs.readFile(join(directory, "reporting", "last-sent.json")));
});

test("DailyReportRunner waits until the configured local hour", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-report-hour-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const { port, transcript } = await fakeSmtp(t);
  const journal = new JsonlJournalStore(join(directory, "journal.jsonl"));
  let now = new Date(2026, 7, 19, 8, 0, 0);
  const runner = new DailyReportRunner({
    journal,
    dataDirectory: directory,
    settings: { enabled: true, hour: 9, smtp: smtpFor(port) },
    opportunities: async () => [],
    now: () => now,
  });

  assert.equal(await runner.maybeSend(), "skipped");
  assert.equal(transcript.filter((line) => line.startsWith("MAIL FROM")).length, 0);

  now = new Date(2026, 7, 19, 9, 0, 0);
  assert.equal(await runner.maybeSend(), "sent");
  assert.ok(transcript.some((line) => line.startsWith("MAIL FROM")));
});

test("two report runners cannot send the same daily report concurrently", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-report-race-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const { port, transcript } = await fakeSmtp(t);
  const journal = new JsonlJournalStore(join(directory, "journal.jsonl"));
  const options = { journal, dataDirectory: directory, settings: { enabled: true, smtp: smtpFor(port) }, opportunities: async () => [], now: () => new Date(2030, 0, 2, 9, 0) };
  const results = await Promise.all([new DailyReportRunner(options).maybeSend(), new DailyReportRunner(options).maybeSend()]);
  assert.deepEqual([...results].sort(), ["sent", "skipped"]);
  assert.equal(transcript.filter((line) => line.startsWith("MAIL FROM")).length, 1);
});

test("an interrupted report remains unknown instead of being sent again", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-report-unknown-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "reporting"), { recursive: true });
  await writeFile(join(directory, "reporting", "last-sent.json"), JSON.stringify({ day: "2030-01-02", status: "dispatching" }));
  const journal = new JsonlJournalStore(join(directory, "journal.jsonl"));
  const runner = new DailyReportRunner({ journal, dataDirectory: directory, settings: { enabled: true, smtp: smtpFor(1) }, opportunities: async () => [], now: () => new Date(2030, 0, 2, 9, 0) });
  assert.equal(await runner.maybeSend(), "unknown");
  assert.deepEqual(await runner.unknownDeliveries(), [{ day: "2030-01-02", status: "unknown" }]);
  await runner.resolveDelivery("2030-01-02", "dismiss");
  assert.equal(await runner.maybeSend(), "skipped");
  assert.deepEqual(await runner.unknownDeliveries(), []);
});

test("an uncertain report is sent only after an explicit owner retry", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-report-retry-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const { port, transcript } = await fakeSmtp(t);
  await mkdir(join(directory, "reporting"), { recursive: true });
  await writeFile(join(directory, "reporting", "last-sent.json"), JSON.stringify({ day: "2030-01-02", status: "dispatching" }));
  const journal = new JsonlJournalStore(join(directory, "journal.jsonl"));
  const runner = new DailyReportRunner({ journal, dataDirectory: directory, settings: { enabled: true, smtp: smtpFor(port) }, opportunities: async () => [], now: () => new Date(2030, 0, 2, 9, 0) });
  assert.equal(await runner.maybeSend(), "unknown");
  assert.equal(transcript.length, 0);
  await runner.resolveDelivery("2030-01-02", "retry");
  assert.equal(await runner.maybeSend(), "sent");
  assert.equal(await runner.maybeSend(), "skipped");
  assert.equal(transcript.filter((line) => line.startsWith("MAIL FROM")).length, 1);
});

test("a malformed delivery marker does not cause a blind resend", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-report-corrupt-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "reporting"), { recursive: true });
  await writeFile(join(directory, "reporting", "last-sent.json"), "not-json");
  const journal = new JsonlJournalStore(join(directory, "journal.jsonl"));
  const runner = new DailyReportRunner({ journal, dataDirectory: directory, settings: { enabled: true, smtp: smtpFor(1) }, opportunities: async () => [], now: () => new Date(2030, 0, 2, 9, 0) });
  await assert.rejects(runner.maybeSend(), /JSON|malformed/i);
});

test("localDayKey uses the local calendar day", () => {
  assert.equal(localDayKey(new Date(2026, 7, 19, 23, 59)), "2026-08-19");
  assert.equal(localDayKey(new Date(2026, 7, 20, 0, 1)), "2026-08-20");
});
