import { execFileSync } from "node:child_process";
import { access, chmod, copyFile, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("The macOS desktop build currently requires an Apple Silicon Mac.");
}

const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
const runtime = findNodeRuntime();
const outputDirectory = join(root, "dist");
const replaceExisting = process.argv.includes("--replace");
const appOnly = process.argv.includes("--app-only");
const scratchParent = join(root, "apps", "desktop", ".build");
await mkdir(outputDirectory, { recursive: true });
await mkdir(scratchParent, { recursive: true });
const scratch = await mkdtemp(join(scratchParent, "macos-"));
try {
  const app = join(scratch, "Clone AI.app");
  const contents = join(app, "Contents");
  const resources = join(contents, "Resources");
  const bundledProject = join(resources, "runtime");
  await mkdir(join(contents, "MacOS"), { recursive: true });
  await mkdir(bundledProject, { recursive: true });

  await copyFile(runtime, join(resources, "node"));
  await chmod(join(resources, "node"), 0o755);
  await cp(join(root, "src"), join(bundledProject, "src"), { recursive: true });
  await cp(join(root, "apps", "desktop", "ui"), join(bundledProject, "apps", "desktop", "ui"), { recursive: true });
  await copyFile(join(root, "package.json"), join(bundledProject, "package.json"));
  await copyFile(join(root, "LICENSE"), join(resources, "CLONE-AI-LICENSE.txt"));
  await copyFile(join(root, "apps", "desktop", "src-tauri", "icons", "icon.icns"), join(resources, "AppIcon.icns"));

  const topLevelProductionPackages = Object.entries(lock.packages)
    .filter(([name, info]) => /^node_modules\/(?:@[^/]+\/[^/]+|[^/]+)$/.test(name) && !info.dev)
    .map(([name]) => name);
  for (const name of topLevelProductionPackages) {
    await cp(join(root, name), join(bundledProject, name), { recursive: true, verbatimSymlinks: true });
  }

  const executable = join(contents, "MacOS", "CloneAI");
  const moduleCache = join(tmpdir(), "clone-ai-macos-swift-cache");
  await mkdir(moduleCache, { recursive: true });
  execFileSync("/usr/bin/xcrun", [
    "swiftc", "-O", "-target", "arm64-apple-macos13.5",
    join(root, "apps", "desktop", "macos", "main.swift"),
    "-framework", "AppKit", "-framework", "WebKit", "-o", executable,
  ], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, CLANG_MODULE_CACHE_PATH: moduleCache, SWIFT_MODULE_CACHE_PATH: moduleCache },
  });
  await chmod(executable, 0o755);
  await writeFile(join(contents, "Info.plist"), plist(manifest.version));
  await writeFile(join(resources, "THIRD-PARTY-NOTICES.txt"), [
    "This app includes Node.js and its production npm dependencies.",
    "Node.js is available under the MIT license: https://github.com/nodejs/node/blob/main/LICENSE",
    "Dependency license files are included in the bundled node_modules directories.",
    "",
  ].join("\n"));

  execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", "--timestamp=none", app], { stdio: "inherit" });
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
  const finalApp = await availablePath(outputDirectory, "Clone AI", ".app", replaceExisting);
  if (replaceExisting) await rm(finalApp, { recursive: true, force: true });
  await rename(app, finalApp);
  console.log(`macOS app: ${finalApp}`);
  if (!appOnly) {
    const finalZip = await availablePath(outputDirectory, `${basename(finalApp, ".app")}-macOS-arm64`, ".zip", replaceExisting);
    if (replaceExisting) await rm(finalZip, { force: true });
    execFileSync("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", finalApp, finalZip], { stdio: "inherit" });
    const finalDmg = await availablePath(outputDirectory, `${basename(finalApp, ".app")}-macOS-arm64`, ".dmg", replaceExisting);
    if (replaceExisting) await rm(finalDmg, { force: true });
    execFileSync("/usr/bin/hdiutil", ["create", "-volname", "Clone AI", "-srcfolder", finalApp, "-ov", "-format", "UDZO", finalDmg], { stdio: "inherit" });
    execFileSync("/usr/bin/hdiutil", ["verify", finalDmg], { stdio: "inherit" });
    console.log(`macOS zip: ${finalZip}`);
    console.log(`macOS dmg: ${finalDmg}`);
  }
  console.log(`Bundled Node.js: ${runtime}`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}

function findNodeRuntime() {
  const candidates = [
    process.env.CLONE_AI_MAC_NODE,
    join(homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "node", "bin", "node"),
    process.execPath,
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const info = execFileSync(candidate, ["-p", "[process.platform,process.arch,process.versions.node].join(' ')"], { encoding: "utf8" }).trim().split(" ");
      if (info[0] !== "darwin" || info[1] !== "arm64" || Number(info[2]?.split(".")[0]) < 24) continue;
      const libraries = execFileSync("/usr/bin/otool", ["-L", candidate], { encoding: "utf8" }).split("\n").slice(1);
      if (libraries.some((line) => line.trim() && !line.trim().startsWith("/usr/lib/") && !line.trim().startsWith("/System/Library/"))) continue;
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error("A self-contained arm64 Node.js 24+ executable is required. Set CLONE_AI_MAC_NODE to its absolute path.");
}

async function availablePath(directory, name, extension, replace = false) {
  const primary = join(directory, `${name}${extension}`);
  try { await access(primary); } catch { return primary; }
  if (replace) return primary;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(directory, `${name}-${stamp}${extension}`);
}

function plist(version) {
  const safeVersion = String(version).replace(/[^0-9.]/g, "");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
  <key>CFBundleDisplayName</key><string>Clone AI</string>
  <key>CFBundleExecutable</key><string>CloneAI</string>
  <key>CFBundleIdentifier</key><string>ai.clone.desktop</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Clone AI</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${safeVersion}</string>
  <key>CFBundleVersion</key><string>${safeVersion}</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>13.5</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>\n`;
}
