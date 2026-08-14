"use strict";
/**
 * Ensure the Electron binary is actually installed and runnable.
 *
 * electron's own install.js can exit 0 while leaving dist/ broken: on
 * 2026-07-24 a first boot downloaded the 108 MB zip fine but the
 * extract-zip step silently failed, leaving only LICENSES.chromium.html
 * and no path.txt. Every later launch then died with "Electron failed to
 * install correctly, please delete node_modules/electron…".
 *
 * Repair ladder:
 *   1. validate  — path.txt exists AND the binary it points to exists
 *   2. reinstall — re-run node_modules/electron/install.js, re-validate
 *   3. extract   — unzip the already-downloaded cache zip ourselves with
 *                  the system `unzip` (the fix that actually worked) and
 *                  write path.txt
 *   4. give up   — throw with the exact manual fix
 *
 * Wired into `predev:electron` and run inline by scripts/dev-electron.js
 * (which .claude/launch.json invokes directly, bypassing npm pre-hooks).
 */
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const BINARY_REL = {
  darwin: "Electron.app/Contents/MacOS/Electron",
  linux: "electron",
  win32: "electron.exe",
};

function electronPkgDir(root) {
  return path.join(root, "node_modules", "electron");
}

function distOk(root) {
  const pkg = electronPkgDir(root);
  const pathTxt = path.join(pkg, "path.txt");
  if (!fs.existsSync(pathTxt)) return false;
  const rel = fs.readFileSync(pathTxt, "utf8").trim();
  if (!rel) return false;
  return fs.existsSync(path.join(pkg, "dist", rel));
}

function cacheDir(platform = process.platform) {
  if (platform === "darwin")
    return path.join(os.homedir(), "Library", "Caches", "electron");
  if (platform === "win32")
    return path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "electron",
      "Cache",
    );
  return path.join(
    process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
    "electron",
  );
}

/** The cache stores zips under a sha-named subdirectory:
 *  ~/Library/Caches/electron/<sha256>/electron-v36.9.5-darwin-arm64.zip */
function findCacheZip(version, platform = process.platform, arch = process.arch) {
  const name = `electron-v${version}-${platform}-${arch}.zip`;
  const rootDir = cacheDir(platform);
  if (!fs.existsSync(rootDir)) return null;
  for (const entry of fs.readdirSync(rootDir)) {
    if (entry === name) return path.join(rootDir, name);
    const candidate = path.join(rootDir, entry, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function ensureElectronBinary(root, deps = {}) {
  const pkg = electronPkgDir(root);
  const {
    runInstaller = () =>
      execFileSync(process.execPath, [path.join(pkg, "install.js")], {
        cwd: pkg,
        stdio: "inherit",
      }),
    extractZip = (zip, dest) =>
      execFileSync("unzip", ["-o", "-q", zip, "-d", dest], { stdio: "inherit" }),
    locateCacheZip = () => {
      const version = JSON.parse(
        fs.readFileSync(path.join(pkg, "package.json"), "utf8"),
      ).version;
      return findCacheZip(version);
    },
    log = (m) => console.log(`[ensure-electron] ${m}`),
  } = deps;

  if (distOk(root)) return "ok";

  log("Electron binary missing or incomplete — running electron's install.js…");
  try {
    runInstaller();
  } catch (err) {
    log(`install.js failed: ${err && err.message}`);
  }
  if (distOk(root)) return "reinstalled";

  const zip = locateCacheZip();
  if (zip) {
    log(`install.js left dist/ incomplete — extracting cached zip ${zip}`);
    const dist = path.join(pkg, "dist");
    fs.rmSync(dist, { recursive: true, force: true });
    fs.mkdirSync(dist, { recursive: true });
    try {
      extractZip(zip, dist);
    } catch (err) {
      log(`unzip failed: ${err && err.message}`);
    }
    const rel = BINARY_REL[process.platform];
    if (rel && fs.existsSync(path.join(dist, rel))) {
      fs.writeFileSync(path.join(pkg, "path.txt"), rel);
    }
  }
  if (distOk(root)) return "extracted";

  throw new Error(
    [
      "Electron binary is not installed and could not be repaired automatically.",
      "Fix manually:",
      "  rm -rf node_modules/electron && npm install",
      "(electron's install step can fail silently — see scripts/ensure-electron-binary.js)",
    ].join("\n"),
  );
}

if (require.main === module) {
  const root = path.resolve(__dirname, "..");
  try {
    const result = ensureElectronBinary(root);
    if (result !== "ok") console.log(`[ensure-electron] repaired (${result})`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { ensureElectronBinary, distOk, findCacheZip, cacheDir, BINARY_REL };
