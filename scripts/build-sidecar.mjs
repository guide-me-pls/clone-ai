import { execFileSync, spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { build } from "esbuild";

const workspace = resolve(import.meta.dirname, "..");
const rustc = join(process.env.USERPROFILE ?? "", ".cargo", "bin", "rustc.exe");
const targetFlagIndex = process.argv.indexOf("--target");
const targetTriple = targetFlagIndex === -1
  ? execFileSync(rustc, ["--print", "host-tuple"], { encoding: "utf8" }).trim()
  : process.argv[targetFlagIndex + 1];
if (targetTriple === undefined || targetTriple.length === 0) {
  throw new Error("A desktop target triple is required after --target.");
}
const output = join(workspace, "apps", "desktop", "src-tauri", "binaries", `clone-ai-daemon-${targetTriple}.exe`);
const pkgCli = join(workspace, "node_modules", "@yao-pkg", "pkg", "lib-es5", "bin.js");
const bundledEntry = join(workspace, "apps", "desktop", ".build", "desktop-sidecar.cjs");

await mkdir(dirname(output), { recursive: true });
await mkdir(dirname(bundledEntry), { recursive: true });
await build({
  entryPoints: [join(workspace, "src", "desktop-sidecar.ts")],
  outfile: bundledEntry,
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node22",
});

const result = spawnSync(
  process.execPath,
  [
    pkgCli,
    bundledEntry,
    "--config",
    "pkg.desktop.config.json",
    "--target",
    "node22-win-x64",
    "--output",
    output,
    "--public-packages",
    "*",
  ],
  { cwd: workspace, stdio: "inherit" },
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

// pkg emits a console-subsystem executable on Windows. The daemon is a child
// of the desktop shell, so that console is only noise for a desktop user.
// Tauri still captures the sidecar's stdout pipe, which carries CLONE_AI_READY.
if (process.platform === "win32") {
  const subsystem = spawnSync("editbin.exe", ["/nologo", "/subsystem:windows", output], { cwd: workspace, stdio: "inherit" });
  if (subsystem.status !== 0) {
    throw new Error("Unable to mark the packaged Clone AI daemon as a windowless Windows sidecar.");
  }
}

console.log(`Prepared packaged local daemon: ${output}`);
