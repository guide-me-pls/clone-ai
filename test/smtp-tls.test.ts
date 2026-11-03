import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { createSecureContext, TLSSocket } from "node:tls";
import { pathToFileURL } from "node:url";

async function tlsFixture(t: TestContext): Promise<{ port: number; certificatePath: string; transcript: string[] } | undefined> {
  const directory = await mkdtemp(join(tmpdir(), "clone-ai-smtp-tls-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const keyPath = join(directory, "test-key.pem");
  const certificatePath = join(directory, "test-cert.pem");
  const configPath = join(directory, "openssl.cnf");
  await writeFile(configPath, [
    "[req]", "distinguished_name=dn", "x509_extensions=v3", "prompt=no",
    "[dn]", "CN=localhost", "[v3]", "subjectAltName=@alt", "basicConstraints=critical,CA:TRUE",
    "keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign", "extendedKeyUsage=serverAuth",
    "[alt]", "DNS.1=localhost", "IP.1=127.0.0.1", "",
  ].join("\n"));
  const generated = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", keyPath, "-out", certificatePath, "-config", configPath], { stdio: "ignore" });
  if (generated.status !== 0) { t.skip("openssl is unavailable for the local TLS fixture"); return undefined; }
  const secureContext = createSecureContext({ key: await readFile(keyPath), cert: await readFile(certificatePath) });
  const transcript: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((plain) => {
    sockets.add(plain);
    plain.on("close", () => sockets.delete(plain));
    plain.on("error", () => undefined);
    plain.write("220 local test server\r\n");
    function listen(socket: Socket, secure: boolean): void {
      let buffer = "";
      let auth = 0;
      let data = false;
      const onData = (chunk: Buffer): void => {
        buffer += chunk.toString("utf8");
        let boundary: number;
        while ((boundary = buffer.indexOf("\r\n")) >= 0) {
          const line = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (!line) continue;
          transcript.push(`${secure ? "tls" : "plain"}:${line}`);
          if (data) {
            if (line === ".") { data = false; socket.write("250 accepted\r\n"); }
          } else if (line.startsWith("EHLO")) {
            socket.write(secure ? "250-local\r\n250 AUTH LOGIN\r\n" : "250-local\r\n250-STARTTLS\r\n250 AUTH LOGIN\r\n");
          } else if (line === "STARTTLS") {
            socket.off("data", onData);
            socket.write("220 ready\r\n", () => {
              const wrapped = new TLSSocket(plain, { isServer: true, secureContext });
              wrapped.on("error", () => undefined);
              listen(wrapped, true);
            });
            return;
          } else if (line === "AUTH LOGIN") { auth = 1; socket.write("334 username\r\n"); }
          else if (auth === 1) { auth = 2; socket.write("334 password\r\n"); }
          else if (auth === 2) { auth = 0; socket.write("235 authenticated\r\n"); }
          else if (line.startsWith("MAIL FROM") || line.startsWith("RCPT TO")) socket.write("250 accepted\r\n");
          else if (line === "DATA") { data = true; socket.write("354 send data\r\n"); }
          else if (line === "QUIT") socket.write("221 bye\r\n");
        }
      };
      socket.on("data", onData);
    }
    listen(plain, false);
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No SMTP test address.");
  return { port: address.port, certificatePath, transcript };
}

async function runClient(port: number, certificatePath?: string): Promise<{ code: number | null; stderr: string }> {
  const moduleUrl = pathToFileURL(resolve("src/reporting/smtp-sender.ts")).href;
  const script = `import { sendEmail } from ${JSON.stringify(moduleUrl)}; await sendEmail({ host: "127.0.0.1", port: ${port}, startTls: true, user: "test-user", pass: "test-pass", from: "a@local", to: "b@local" }, { subject: "test", text: "test" });`;
  const env = { ...process.env };
  if (certificatePath === undefined) delete env.NODE_EXTRA_CA_CERTS;
  else env.NODE_EXTRA_CA_CERTS = certificatePath;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const code = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", resolveExit);
  });
  return { code, stderr };
}

test("STARTTLS authenticates only after a verified TLS handshake", { timeout: 20_000 }, async (t) => {
  const fixture = await tlsFixture(t);
  if (fixture === undefined) return;
  const result = await runClient(fixture.port, fixture.certificatePath);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(fixture.transcript.includes("plain:STARTTLS"));
  assert.ok(fixture.transcript.includes("tls:AUTH LOGIN"));
  assert.equal(fixture.transcript.includes("plain:AUTH LOGIN"), false);
  assert.ok(fixture.transcript.includes("tls:QUIT"));
});

test("an untrusted STARTTLS certificate is rejected before authentication", { timeout: 20_000 }, async (t) => {
  const fixture = await tlsFixture(t);
  if (fixture === undefined) return;
  const result = await runClient(fixture.port);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /certificate|self.signed/i);
  assert.equal(fixture.transcript.some((line) => line.endsWith("AUTH LOGIN")), false);
});
