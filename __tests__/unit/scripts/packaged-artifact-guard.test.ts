import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  scanForProprietaryCode,
  formatViolations,
} from "../../../scripts/packaged-artifact-guard.js";

/**
 * The two gates this guard backstops both have blind spots:
 *   - check-licenses.sh scans `--production`, but the artifact ships
 *     devDependencies too.
 *   - electron-builder's `!node_modules/@anthropic-ai/**` is TOP-LEVEL and
 *     does not match `node_modules/<x>/node_modules/@anthropic-ai/**`, which
 *     npm creates whenever hoisting is blocked.
 * So the nesting case below is the whole reason this exists.
 */

const roots: string[] = [];
function makeTree(): string {
  const root = mkdtempSync(path.join(tmpdir(), "libi-pack-"));
  roots.push(root);
  return root;
}

function seedPkg(root: string, relDir: string, files: Record<string, string> = {}): string {
  const dir = path.join(root, ...relDir.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: relDir }));
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), contents);
  }
  return dir;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("scanForProprietaryCode", () => {
  it("passes a clean tree", () => {
    const root = makeTree();
    seedPkg(root, "@zed-industries/codex-acp", { "LICENSE": "Apache License 2.0" });
    seedPkg(root, "react");
    expect(scanForProprietaryCode(root)).toEqual([]);
  });

  it("flags a TOP-LEVEL @anthropic-ai directory", () => {
    const root = makeTree();
    seedPkg(root, "@anthropic-ai/claude-agent-sdk");
    const violations = scanForProprietaryCode(root);
    expect(violations).toHaveLength(1);
    expect(violations[0].path).toContain(path.join("@anthropic-ai"));
  });

  it("flags a NESTED @anthropic-ai directory the electron-builder glob misses", () => {
    const root = makeTree();
    seedPkg(root, "some-dev-dep/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64");
    const violations = scanForProprietaryCode(root);
    expect(violations).toHaveLength(1);
    // The message must name the offending path so the fix is obvious.
    expect(violations[0].path).toContain(
      path.join("some-dev-dep", "node_modules", "@anthropic-ai"),
    );
    expect(violations[0].reason).toContain("packed into the artifact");
  });

  it("flags the adapter itself, nested or not", () => {
    const root = makeTree();
    seedPkg(root, "x/node_modules/@agentclientprotocol/claude-agent-acp");
    const violations = scanForProprietaryCode(root);
    expect(violations).toHaveLength(1);
    expect(violations[0].path).toContain("claude-agent-acp");
  });

  it("flags the Anthropic copyright string in a licence file of an innocently-named package", () => {
    const root = makeTree();
    seedPkg(root, "vendored-thing", {
      "LICENSE.md": "© Anthropic PBC. All rights reserved.",
    });
    const violations = scanForProprietaryCode(root);
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toContain("Anthropic PBC");
  });

  it("returns no violations for a missing tree rather than throwing", () => {
    // The caller decides whether absence is fatal (afterpack-license-guard.js
    // treats it as a hard failure — a guard that can't find the tree must not
    // report green).
    expect(scanForProprietaryCode(path.join(tmpdir(), "definitely-not-here-libi"))).toEqual([]);
  });
});

describe("afterPack hook", () => {
  /** Lay out what electron-builder produces for macOS with `asar: false`. */
  function macBundle(): { context: { appOutDir: string; packager: unknown }; appDir: string } {
    const appOutDir = makeTree();
    const appDir = path.join(appOutDir, "Libi.app", "Contents", "Resources", "app");
    mkdirSync(path.join(appDir, "node_modules"), { recursive: true });
    return {
      context: { appOutDir, packager: { appInfo: { productFilename: "Libi" } } },
      appDir,
    };
  }

  it("passes a clean packed tree", async () => {
    const { context, appDir } = macBundle();
    seedPkg(path.join(appDir, "node_modules"), "react");
    const guard = await import("../../../scripts/afterpack-license-guard.js");
    await expect(guard.afterPackLicenseGuard(context)).resolves.toBeUndefined();
  });

  it("FAILS the build and names the path when proprietary code was packed", async () => {
    const { context, appDir } = macBundle();
    seedPkg(
      path.join(appDir, "node_modules"),
      "some-dev-dep/node_modules/@anthropic-ai/claude-agent-sdk",
    );
    const guard = await import("../../../scripts/afterpack-license-guard.js");
    await expect(guard.afterPackLicenseGuard(context)).rejects.toThrow(/@anthropic-ai/);
  });

  it("FAILS rather than silently passing when the packed tree can't be located", async () => {
    // An electron-builder layout change must break the build loudly, not turn
    // the guard into a no-op that goes green forever.
    const guard = await import("../../../scripts/afterpack-license-guard.js");
    await expect(
      guard.afterPackLicenseGuard({
        appOutDir: makeTree(),
        packager: { appInfo: { productFilename: "Libi" } },
      }),
    ).rejects.toThrow(/could not locate the packed app directory/);
  });

  // Since the shell was thinned, `Resources/app` usually has NO node_modules at
  // all — every dependency lives in the runtime snapshot next door. A guard
  // that only looked at the old path would have gone green while checking
  // nothing, which is the exact failure mode this whole file exists to prevent.
  it("scans the runtime bundle, which is where the dependencies actually are now", async () => {
    const appOutDir = makeTree();
    const resources = path.join(appOutDir, "Libi.app", "Contents", "Resources");
    mkdirSync(path.join(resources, "app", "dist-electron"), { recursive: true });
    const bundleModules = path.join(resources, "libi-bundle", "node_modules");
    mkdirSync(bundleModules, { recursive: true });
    seedPkg(bundleModules, "@anthropic-ai/claude-agent-sdk");
    const guard = await import("../../../scripts/afterpack-license-guard.js");
    await expect(
      guard.afterPackLicenseGuard({
        appOutDir,
        packager: { appInfo: { productFilename: "Libi" } },
      }),
    ).rejects.toThrow(/@anthropic-ai/);
  });

  it("FAILS when neither node_modules tree is present — a thin shell with no bundle is broken", async () => {
    const appOutDir = makeTree();
    mkdirSync(path.join(appOutDir, "Libi.app", "Contents", "Resources", "app"), {
      recursive: true,
    });
    const guard = await import("../../../scripts/afterpack-license-guard.js");
    await expect(
      guard.afterPackLicenseGuard({
        appOutDir,
        packager: { appInfo: { productFilename: "Libi" } },
      }),
    ).rejects.toThrow(/no node_modules tree found/);
  });

  it("finds the Windows/Linux resources layout too", async () => {
    const appOutDir = makeTree();
    const appDir = path.join(appOutDir, "resources", "app");
    mkdirSync(path.join(appDir, "node_modules"), { recursive: true });
    const guard = await import("../../../scripts/afterpack-license-guard.js");
    expect(
      guard.resolvePackedAppDir({
        appOutDir,
        packager: { appInfo: { productFilename: "Libi" } },
      }),
    ).toBe(appDir);
  });
});

describe("formatViolations", () => {
  it("names every offending path in an actionable block", () => {
    const out = formatViolations([
      { path: "/a/node_modules/@anthropic-ai", reason: "proprietary" },
      { path: "/b/LICENSE.md", reason: "Anthropic PBC" },
    ]);
    expect(out).toContain("/a/node_modules/@anthropic-ai");
    expect(out).toContain("/b/LICENSE.md");
    expect(out).toContain("devDependency");
  });
});
