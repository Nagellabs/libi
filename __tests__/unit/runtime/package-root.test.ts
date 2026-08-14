/**
 * `lib/runtime/package-root.ts` — depth-independent package-root resolution.
 *
 * `findPackageRoot()`/`packageRoot()` decide the production server's chdir
 * target (`lib/cli/studio.ts`'s `projectRoot`) and are relied on by every
 * `__dirname`-relative sidecar-script resolver (`lib/whisper/transcribe.ts`,
 * `lib/tts/synthesize.ts`, `lib/music/{analyze,generate}.ts`,
 * `mcp/bundled-mcps/install-tools.ts`'s `REPO_ROOT`) — yet had zero direct
 * unit tests before this file. Table-tests the walk-up: found in the starting
 * dir, found in an ancestor, and the no-package.json-anywhere case that must
 * return `null` rather than guess.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { findPackageRoot, packageRoot } from "@/lib/runtime/package-root";

describe("findPackageRoot", () => {
  it("finds package.json in the starting directory itself", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-pkgroot-"));
    try {
      fs.writeFileSync(path.join(dir, "package.json"), "{}");
      expect(findPackageRoot(dir)).toBe(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("walks up multiple ancestors to find package.json (the dist-cli/lib/mcp shape)", () => {
    // Mirrors the real layout this exists for: <pkgRoot>/dist-cli/lib/foo.js
    // walking up to <pkgRoot>/package.json, two levels above dist-cli/.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "libi-pkgroot-"));
    try {
      fs.writeFileSync(path.join(root, "package.json"), "{}");
      const nested = path.join(root, "dist-cli", "lib");
      fs.mkdirSync(nested, { recursive: true });
      expect(findPackageRoot(nested)).toBe(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns the nearest package.json, not a farther ancestor's", () => {
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), "libi-pkgroot-outer-"));
    try {
      fs.writeFileSync(path.join(outer, "package.json"), "{}");
      const inner = path.join(outer, "nested-pkg");
      fs.mkdirSync(inner, { recursive: true });
      fs.writeFileSync(path.join(inner, "package.json"), "{}");
      const leaf = path.join(inner, "a", "b");
      fs.mkdirSync(leaf, { recursive: true });
      expect(findPackageRoot(leaf)).toBe(inner);
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  });

  it("returns null when no ancestor has a package.json", () => {
    // A fresh temp dir's ancestry (os.tmpdir() and above) has no package.json
    // in any normal environment — this is exactly the "nothing found" case
    // findPackageRoot must not guess at.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-pkgroot-none-"));
    try {
      expect(findPackageRoot(dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("packageRoot", () => {
  it("returns the resolved root when one exists", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-pkgroot-"));
    try {
      fs.writeFileSync(path.join(dir, "package.json"), "{}");
      expect(packageRoot(dir)).toBe(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to process.cwd() when no package.json is found (Turbopack placeholder case)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-pkgroot-none-"));
    try {
      expect(packageRoot(dir)).toBe(process.cwd());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
