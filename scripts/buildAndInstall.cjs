#!/usr/bin/env node
/**
 * Build the 9Router CLI bundle from THIS source tree and install it globally so the
 * `9router` command runs our build from anywhere (tray + web UI + MITM).
 *
 * Steps:
 *   1. Ensure cli/ dev deps (esbuild for the MITM bundle, etc.)
 *   2. cli build  → Next standalone + src/mitm + open-sse changes copied into cli/app
 *   3. Global install (pnpm if available, else npm)  → `9router` on PATH
 *
 * Usage:  node scripts/buildAndInstall.cjs            (build + install)
 *         node scripts/buildAndInstall.cjs --build    (build only)
 *         INSTALLER=npm node scripts/buildAndInstall.cjs   (force npm)
 */
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const rootDir = path.resolve(__dirname, "..");
const cliDir = path.join(rootDir, "cli");
const buildOnly = process.argv.includes("--build");

function run(cmd, cwd) {
  console.log(`\n▶ ${cmd}\n   (cwd: ${cwd})`);
  execSync(cmd, { stdio: "inherit", cwd, env: process.env });
}

function has(cmd) {
  try { execSync(process.platform === "win32" ? `where ${cmd}` : `command -v ${cmd}`, { stdio: "ignore" }); return true; }
  catch { return false; }
}

// 1. cli dev/runtime deps (needed for buildMitm's esbuild + the bundled deps)
if (!fs.existsSync(path.join(cliDir, "node_modules"))) {
  console.log("\n=== [1/3] Installing cli/ dependencies ===");
  run("npm install", cliDir);
} else {
  console.log("\n=== [1/3] cli/ dependencies present ===");
}

// 2. Build the standalone CLI bundle (Next build + MITM bundle + src copy)
console.log("\n=== [2/3] Building CLI bundle (next build standalone + MITM) ===");
run("npm run build", cliDir);

if (buildOnly) {
  console.log("\n✅ Build complete (cli/app). Skipping global install (--build).");
  process.exit(0);
}

// 3. Global install via `npm link` — symlinks the package globally AND creates the
// `9router` bin shim (on the npm global prefix, which is on PATH). NOTE: `pnpm add -g
// <localdir>` does NOT create bin shims for a local directory ("9router has no binaries"),
// so npm link is the reliable choice for installing this local build globally. Bonus:
// it's a symlink, so a later `npm run build:cli` rebuild is reflected immediately.
console.log("\n=== [3/3] Installing globally (npm link) ===");
run("npm link", cliDir);

// Report the resolved bin
try {
  const where = process.platform === "win32" ? "where 9router" : "command -v 9router";
  const out = execSync(where, { encoding: "utf8" }).trim();
  console.log(`\n✅ Installed. \`9router\` resolves to:\n${out}`);
} catch {
  console.log("\n✅ Installed. (Could not resolve `9router` on PATH — open a new terminal.)");
}
console.log("\nRun it with:  9router        (dashboard at http://localhost:20128)");
