import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Regression guard: the RELEASE path must self-repair the Electron binary.
//
// npm can leave `node_modules/electron` with a populated `dist/` but no
// `path.txt` — the file `electron/index.js` reads to locate the binary. Every
// consumer then fails with the same unhelpful line:
//
//   ❌ Electron failed to install correctly, please delete node_modules/electron
//
// `scripts/ensure-electron-binary.js` exists precisely to repair that, and it
// was wired into `predev:electron`. It was NOT wired into the build. So the
// DEV path self-healed while the RELEASE path died — and it died late, after
// paying for @electron/rebuild, the Next production build and the CLI compile,
// with an error message that blames the user's node_modules rather than naming
// the missing file.
//
// Measured on a clean clone of this repo: `npm install && npm run build:electron`
// failed here, on the very first packaged build anyone would attempt.
//
// This is the same shape as the stale-lockfile blocker fixed in 4469b881: a
// guard that exists and works, exercised only on the path developers already
// run, absent from the path that actually ships.

const ROOT = path.resolve(__dirname, "..", "..", "..");

function scripts(): Record<string, string> {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8")).scripts ?? {};
}

describe("the release build repairs the Electron binary", () => {
  it("runs ensure-electron-binary before packaging", () => {
    const s = scripts();
    const releaseChain = `${s["prebuild:electron"] ?? ""} ${s["build:electron"] ?? ""}`;
    expect(
      releaseChain,
      "neither prebuild:electron nor build:electron runs scripts/ensure-electron-binary.js. " +
        "A fresh `npm install` can leave node_modules/electron without path.txt, and " +
        "electron-builder then fails with 'Electron failed to install correctly' AFTER the " +
        "full Next + CLI build has already run.",
    ).toContain("ensure-electron-binary");
  });

  it("keeps the repair script on disk", () => {
    expect(fs.existsSync(path.join(ROOT, "scripts", "ensure-electron-binary.js"))).toBe(true);
  });

  it("does NOT run ensure-native-modules in the release chain", () => {
    // ensure-native-modules.js restores better-sqlite3 to the SYSTEM NODE ABI
    // (137) so vitest workers survive. `build:electron` opens with
    // rebuild-for-electron.js, which deliberately puts it on ELECTRON's ABI
    // (135) because that is what the packaged app loads. Running both in one
    // chain means the last writer wins and the artifact's ABI depends on
    // script order — so the release path must never invoke the Node-side one.
    const s = scripts();
    const releaseChain = `${s["prebuild:electron"] ?? ""} ${s["build:electron"] ?? ""}`;
    expect(
      releaseChain,
      "the release chain must not run ensure-native-modules.js — it would fight " +
        "rebuild-for-electron.js over better-sqlite3's ABI.",
    ).not.toContain("ensure-native-modules");
  });
});
