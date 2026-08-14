import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Regression guard modelled on next-externals-manifest-wiring.test.ts, for the
// same failure shape it exists to prevent.
//
// This repo already shipped a silent-build-step-skip in this exact pipeline:
// `scripts/write-next-externals-manifest.js` was chained as an npm `postbuild`
// hook, and npm only fires pre/post hooks for scripts it runs BY NAME —
// `build:electron` invokes the release script BY PATH, so the hook never fired
// and a release shipped a `.next` that 500'd every route, with a fully green
// suite (a test had even encoded the no-op as correct).
//
// `scripts/build-cli.js` is load-bearing in the same way: without `dist-cli/`,
// `npx @nagellabs/libi` cannot start at all — tsx refuses to apply tsconfig
// `paths` to any file under a `node_modules` segment, so every `@/…` import in
// an installed copy throws MODULE_NOT_FOUND. These tests assert the WIRING, so
// dropping the call fails here rather than on a consumer's machine.

const ROOT = path.resolve(__dirname, "..", "..", "..");

function readPackageJson(): { scripts?: Record<string, string>; files?: string[] } {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
}

describe("the CLI compile step stays wired into every path that produces a shipped artifact", () => {
  it("prepack (the npm-tarball path, fired BY NAME so it reliably runs) invokes build-cli.js", () => {
    const prepack = readPackageJson().scripts?.prepack;
    expect(prepack, "package.json is missing a `prepack` script entirely").toBeTruthy();
    expect(
      prepack,
      `scripts.prepack ("${prepack}") no longer invokes scripts/build-cli.js — ` +
        "`npm pack`/`npm publish` would ship a tarball whose CLI cannot launch.",
    ).toMatch(/build-cli\.js/);
  });

  it("scripts/next-build-release.js (the release path invoked by build:electron) calls buildCli() explicitly", () => {
    const source = fs.readFileSync(path.join(ROOT, "scripts", "next-build-release.js"), "utf-8");
    expect(source, "next-build-release.js no longer requires build-cli.js").toMatch(
      /require\(["']\.\/build-cli\.js["']\)/,
    );
    // Invoked, not merely imported.
    expect((source.match(/buildCli\s*\(/g) ?? []).length).toBeGreaterThan(0);
    expect(
      source,
      "next-build-release.js no longer asserts the bundle is fresh after building it",
    ).toMatch(/assertCliBundleFresh\s*\(/);
  });

  it("does NOT rely on an npm lifecycle hook that would silently not fire", () => {
    const scripts = readPackageJson().scripts ?? {};
    for (const hook of ["postbuild", "postbuild:cli", "prebuild:cli"]) {
      expect(
        scripts[hook] ?? "",
        `scripts.${hook} chains build-cli.js — npm only fires pre/post hooks for scripts it runs BY NAME, ` +
          "and the release path invokes its scripts by path. Call the function explicitly instead.",
      ).not.toMatch(/build-cli\.js/);
    }
  });

  it("ships dist-cli/ in the npm tarball allowlist", () => {
    const files = readPackageJson().files ?? [];
    expect(
      files.some((f) => f.startsWith("dist-cli")),
      "package.json#files has no dist-cli entry — the compiled CLI would be built and then not packed.",
    ).toBe(true);
  });

  it("exposes a plain `npm run build:cli` so the step is runnable on its own", () => {
    expect(readPackageJson().scripts?.["build:cli"]).toMatch(/build-cli\.js/);
  });
});

describe("both spawn paths agree on how an installed copy resolves its entry points", () => {
  it("bin/libi.js launches the compiled entry when it lives under node_modules", () => {
    const source = fs.readFileSync(path.join(ROOT, "bin", "libi.js"), "utf-8");
    expect(source).toMatch(/dist-cli/);
    expect(
      source,
      "bin/libi.js no longer branches on being installed under node_modules — an `npx` launch " +
        "would go through tsx, which cannot resolve a single @/ import there.",
    ).toMatch(/node_modules/);
    expect(
      source,
      "bin/libi.js should hard-fail (not silently fall back to tsx) when the compiled entry is absent",
    ).toMatch(/process\.exit\(1\)/);
  });

  it("lib/mcp-config.ts and mcp/registry/local-bin-resolver.ts both go through resolveEntrySpawn", () => {
    for (const rel of ["lib/mcp-config.ts", "mcp/registry/local-bin-resolver.ts"]) {
      const source = fs.readFileSync(path.join(ROOT, rel), "utf-8");
      expect(source, `${rel} no longer uses the shared dual-mode resolver`).toMatch(
        /resolveEntrySpawn\s*\(/,
      );
    }
  });

  it("neither spawn path reintroduces an `npx libi …` fallback", () => {
    // `libi` on the public registry belongs to an unrelated third party, and
    // buildSpawnEnv() hands an MCP child the ENTIRE process env.
    for (const rel of [
      "lib/mcp-config.ts",
      "mcp/registry/local-bin-resolver.ts",
      "lib/runtime/compiled-entry.ts",
    ]) {
      const source = fs.readFileSync(path.join(ROOT, rel), "utf-8");
      const code = source
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("*") && !l.trimStart().startsWith("//"))
        .join("\n");
      expect(code, `${rel} reintroduced an npx fallback`).not.toMatch(
        /["']npx["']\s*,\s*\[?\s*["']libi/,
      );
    }
  });
});
