/**
 * chromium-render export was BROKEN in every packaged build.
 *
 * `lib/export/drivers/electron.ts` loaded Electron's main-process API with
 * `await import("electron")`. But `electron` is deliberately NOT in
 * `serverExternalPackages` (adding it breaks electron-builder's packaging step
 * — see the note in next.config.ts), so that statically visible import is not
 * a filesystem lookup after bundling: Turbopack inlines the npm `electron`
 * package's stub `index.js` into the server chunk. The stub only knows how to
 * read `path.txt` and locate a downloaded binary, which a packaged app has no
 * reason to contain, so it throws:
 *
 *   Electron failed to install correctly, please delete node_modules/electron
 *   and try installing again
 *
 * Measured on the packaged app 2026-08-02: the classifier routed correctly to
 * chromium-render and the export then failed 100% of the time with exactly
 * that message, leaving `.next/server/chunks/node_modules_electron_index_*.js`
 * in the artifact as the smoking gun. That takes out every composition the
 * ffmpeg fast paths cannot render — canvas scenes, multi-scene comps, code
 * overlays, rotated/flipped overlays — and the error's advice ("delete
 * node_modules/electron") is meaningless to someone holding a signed .app.
 *
 * The fix is the same runtime-`createRequire` trick `resolveVendoredNpmCli`
 * documents in lib/install/npm-root.ts. This test guards the SOURCE because
 * that is where the regression lives: the failure only reproduces after a
 * production bundle, which no unit test can cheaply build.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const DRIVER = path.resolve(__dirname, "../../../lib/export/drivers/electron.ts");

function source(): string {
  return fs.readFileSync(DRIVER, "utf-8");
}

describe("the Electron render driver resolves electron at RUNTIME", () => {
  it("uses createRequire, not a bundler-visible import/require of 'electron'", () => {
    const src = source();

    expect(
      src.includes("createRequire"),
      "the driver must resolve `electron` through a runtime createRequire so the " +
        "bundler cannot inline the npm stub",
    ).toBe(true);

    // A bare dynamic import or static require of "electron" is exactly what
    // Turbopack follows and inlines.
    expect(
      /await\s+import\(\s*["']electron["']\s*\)/.test(src),
      'found `await import("electron")` — Turbopack inlines the npm electron ' +
        "stub, which throws 'Electron failed to install correctly' in a packaged app",
    ).toBe(false);
    expect(
      /^\s*import\s+.*from\s+["']electron["']/m.test(src),
      "a static `import ... from \"electron\"` is bundled the same way",
    ).toBe(false);
    // `require("electron")` written literally is also statically visible.
    expect(
      /[^.\w]require\(\s*["']electron["']\s*\)/.test(src),
      "a literal require(\"electron\") is statically visible to the bundler — " +
        "go through the createRequire handle instead",
    ).toBe(false);
  });

  it("keeps the type-only import, which erases and is not a runtime edge", () => {
    // `typeof import("electron")` in a type position is fine — it disappears at
    // compile time and gives us the real API types.
    expect(source()).toContain('typeof import("electron")');
  });

  it("records why, so the next person does not 'simplify' it back", () => {
    const src = source();
    expect(src).toContain("serverExternalPackages");
    expect(src).toContain("Electron failed to install correctly");
  });
});
