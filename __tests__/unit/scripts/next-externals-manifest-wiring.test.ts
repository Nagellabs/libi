import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Regression guard for the "C1" finding this repo already fixed once
// (task-5-report.md): the manifest writer (`scripts/write-next-externals-manifest.js`)
// wasn't wired into the RELEASE build path (`build:electron` ->
// `scripts/next-build-release.js`), so a shipped `.next` had no manifest and
// the installed server bound its port and 500'd every route — with a fully
// green test suite, because nothing asserted the wiring itself.
//
// This test doesn't re-verify the writer's OWN behavior (that's
// __tests__/unit/lib/install/next-externals.test.ts) — it asserts the two
// build entry points still actually CALL it, so a future edit to
// package.json#scripts.build or scripts/next-build-release.js that silently
// drops the call fails a test instead of only failing at boot, on some
// consumer's machine, after a release.

const ROOT = path.resolve(__dirname, "..", "..", "..");

function readPackageJson(): { scripts?: Record<string, string> } {
  return JSON.parse(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"),
  );
}

describe("Next externals manifest writer stays wired into every build path", () => {
  it("package.json#scripts.build chains `next build` with the manifest writer", () => {
    const pkg = readPackageJson();
    const buildScript = pkg.scripts?.build;
    expect(
      buildScript,
      "package.json is missing a `build` script entirely",
    ).toBeTruthy();
    expect(buildScript).toMatch(/\bnext build\b/);
    expect(
      buildScript,
      `scripts.build ("${buildScript}") no longer chains write-next-externals-manifest.js — ` +
        "a .next produced by `npm run build` would ship without the manifest, and the " +
        "installed server would bind its port and 500 every route.",
    ).toMatch(/write-next-externals-manifest\.js/);
    // Must run AFTER `next build` (the writer reads `.next/BUILD_ID`, which
    // only exists once the build has completed), not merely be present.
    const nextBuildIdx = buildScript!.indexOf("next build");
    const writerIdx = buildScript!.indexOf("write-next-externals-manifest.js");
    expect(nextBuildIdx).toBeGreaterThanOrEqual(0);
    expect(writerIdx).toBeGreaterThan(nextBuildIdx);
  });

  it("scripts/next-build-release.js (the release path invoked by build:electron) calls writeExternalsManifest()", () => {
    const source = fs.readFileSync(
      path.join(ROOT, "scripts", "next-build-release.js"),
      "utf-8",
    );
    expect(
      source,
      "next-build-release.js no longer requires write-next-externals-manifest.js",
    ).toMatch(/require\(["']\.\/write-next-externals-manifest\.js["']\)/);
    expect(
      source,
      "next-build-release.js no longer calls writeExternalsManifest() — the release .next " +
        "would ship without the manifest.",
    ).toMatch(/writeExternalsManifest\s*\(/);

    // Must be invoked, not merely imported — guard against a destructure with
    // no call site (e.g. accidentally deleted during a refactor).
    const callSites = source.match(/writeExternalsManifest\s*\(\s*\)/g) ?? [];
    expect(callSites.length).toBeGreaterThan(0);
  });

  it("build:electron chains through next-build-release.js, the script that calls the writer", () => {
    const pkg = readPackageJson();
    const buildElectron = pkg.scripts?.["build:electron"];
    expect(
      buildElectron,
      "package.json is missing a `build:electron` script entirely",
    ).toBeTruthy();
    expect(
      buildElectron,
      `scripts["build:electron"] ("${buildElectron}") no longer invokes scripts/next-build-release.js — ` +
        "the release path would use a plain `next build` with no externals manifest.",
    ).toMatch(/next-build-release\.js/);
  });
});
