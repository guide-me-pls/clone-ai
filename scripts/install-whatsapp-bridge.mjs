#!/usr/bin/env node
import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Install the phone bridge as a per-user LaunchAgent.
 *
 * Secrets live in a separate 0600 env file, never in the plist or this repo.
 * The installer creates the env template once and refuses to overwrite it.
 *
 * 把手机桥安装为当前用户的 LaunchAgent。
 *
 * 密钥放在独立的 0600 环境文件里，不进入 plist 或仓库。安装器只创建一次模板，
 * 不会覆盖已有内容。
 */
const root = resolve(import.meta.dirname, "..");
const home = homedir();
const cloneHome = join(home, ".clone");
const envFile = join(cloneHome, "whatsapp.env");
const launchAgents = join(home, "Library", "LaunchAgents");
const plist = join(launchAgents, "ai.clone.whatsapp.plist");
await mkdir(cloneHome, { recursive: true });
await mkdir(launchAgents, { recursive: true });

if (!(await exists(envFile))) {
  await writeFile(envFile, [
    "# Clone AI WhatsApp bridge secrets",
    "# Fill these values, save the file, then run:",
    "#   launchctl kickstart -k gui/$(id -u)/ai.clone.whatsapp",
    "WHATSAPP_ACCESS_TOKEN=",
    "WHATSAPP_PHONE_NUMBER_ID=",
    "WHATSAPP_VERIFY_TOKEN=",
    "WHATSAPP_APP_SECRET=",
    "WHATSAPP_ALLOWED_NUMBERS=",
    "WHATSAPP_GRAPH_VERSION=v23.0",
    "CLONE_AI_WHATSAPP_PORT=4318",
    "",
  ].join("\n"), { mode: 0o600 });
}
await chmod(envFile, 0o600);

const source = join(root, "src", "mobile", "whatsapp-main.ts");
await access(source);
await writeFile(plist, plistXml({
  label: "ai.clone.whatsapp",
  node: process.execPath,
  source,
  root,
  envFile,
  log: join(cloneHome, "whatsapp.log"),
}), { mode: 0o644 });

console.log(`LaunchAgent: ${plist}`);
console.log(`Environment: ${envFile}`);
console.log("Fill the env file, then run:");
console.log("  launchctl bootout gui/$(id -u)/ai.clone.whatsapp 2>/dev/null || true");
console.log("  launchctl bootstrap gui/$(id -u) " + plist);
console.log("  launchctl enable gui/$(id -u)/ai.clone.whatsapp");

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function xml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function plistXml(input) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${input.label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(input.node)}</string>
    <string>--experimental-strip-types</string>
    <string>${xml(input.source)}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(input.root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CLONE_AI_WHATSAPP_ENV_FILE</key><string>${xml(input.envFile)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${xml(input.log)}</string>
  <key>StandardErrorPath</key><string>${xml(input.log)}</string>
</dict>
</plist>
`;
}
