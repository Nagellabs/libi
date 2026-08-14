import { describe, expect, it, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  lstatSync,
  realpathSync,
  existsSync,
  readlinkSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  ensureNextExternalSymlinks,
  farmHasResolvableEntries,
  findPackageDir,
  NextExternalsError,
  readBuildId,
  readExternalsManifest,
} from "@/lib/install/next-externals";

function makeTmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), "next-externals-test-"));
}

/** A package name guaranteed not to exist anywhere on disk — the "missing"
 *  test cases must not depend on the ambient `os.tmpdir()` ancestor chain
 *  being clean (on this machine it genuinely wasn't: a stray
 *  `<tmpdir>/node_modules/pino` from an unrelated prior tool run made a
 *  hardcoded "pino"/"does-not-exist" name flaky). */
function neverInstalledPackageName(): string {
  return `does-not-exist-${randomUUID()}`;
}

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop()!;
    rmSync(d, { recursive: true, force: true });
  }
});

const BUILD_ID = "test-build-id";

function writeBuildId(nextDir: string, id: string = BUILD_ID): void {
  writeFileSync(path.join(nextDir, "BUILD_ID"), `${id}\n`);
}

function writeManifest(nextDir: string, manifest: unknown): void {
  writeFileSync(path.join(nextDir, "externals-manifest.json"), JSON.stringify(manifest));
}

/** The healthy shape: a stamped manifest next to a matching BUILD_ID. */
function writeStamped(
  nextDir: string,
  links: Array<{ link: string; package: string }>,
  buildId: string = BUILD_ID,
): void {
  writeBuildId(nextDir, buildId);
  writeManifest(nextDir, { buildId, links });
}

describe("readExternalsManifest", () => {
  it("returns null when the manifest file is absent", () => {
    const nextDir = makeTmpDir();
    dirs.push(nextDir);
    expect(readExternalsManifest(nextDir)).toBeNull();
  });

  it("returns null when the manifest is malformed JSON", () => {
    const nextDir = makeTmpDir();
    dirs.push(nextDir);
    writeFileSync(path.join(nextDir, "externals-manifest.json"), "{not json");
    expect(readExternalsManifest(nextDir)).toBeNull();
  });

  it("returns null for the legacy UNSTAMPED array shape (no buildId to verify)", () => {
    const nextDir = makeTmpDir();
    dirs.push(nextDir);
    writeManifest(nextDir, [{ link: "pino-abc123", package: "pino" }]);
    expect(readExternalsManifest(nextDir)).toBeNull();
  });

  it("returns null when buildId is missing or empty", () => {
    const nextDir = makeTmpDir();
    dirs.push(nextDir);
    writeManifest(nextDir, { links: [] });
    expect(readExternalsManifest(nextDir)).toBeNull();
    writeManifest(nextDir, { buildId: "", links: [] });
    expect(readExternalsManifest(nextDir)).toBeNull();
  });

  it("filters out malformed link entries but keeps well-formed ones", () => {
    const nextDir = makeTmpDir();
    dirs.push(nextDir);
    writeManifest(nextDir, {
      buildId: BUILD_ID,
      links: [
        { link: "pino-abc123", package: "pino" },
        { link: 42, package: "bad" },
        { package: "missing-link-field" },
        { link: "missing-package-field" },
        null,
      ],
    });
    expect(readExternalsManifest(nextDir)).toEqual({
      buildId: BUILD_ID,
      links: [{ link: "pino-abc123", package: "pino" }],
    });
  });

  it("parses a well-formed multi-entry manifest, including scoped packages", () => {
    const nextDir = makeTmpDir();
    dirs.push(nextDir);
    const links = [
      { link: "pino-abc123", package: "pino" },
      { link: path.join("@napi-rs", "canvas-def456"), package: "@napi-rs/canvas" },
    ];
    writeManifest(nextDir, { buildId: BUILD_ID, links });
    expect(readExternalsManifest(nextDir)).toEqual({ buildId: BUILD_ID, links });
  });
});

describe("readBuildId", () => {
  it("returns the trimmed BUILD_ID", () => {
    const nextDir = makeTmpDir();
    dirs.push(nextDir);
    writeBuildId(nextDir, "abc123");
    expect(readBuildId(nextDir)).toBe("abc123");
  });

  it("returns null when BUILD_ID is absent or empty", () => {
    const nextDir = makeTmpDir();
    dirs.push(nextDir);
    expect(readBuildId(nextDir)).toBeNull();
    writeFileSync(path.join(nextDir, "BUILD_ID"), "\n");
    expect(readBuildId(nextDir)).toBeNull();
  });
});

describe("findPackageDir", () => {
  it("finds a package in the immediate node_modules sibling", () => {
    const root = makeTmpDir();
    dirs.push(root);
    const pkgDir = path.join(root, "node_modules", "pino");
    mkdirSync(pkgDir, { recursive: true });
    const startDir = path.join(root, "some", "nested", "dir");
    mkdirSync(startDir, { recursive: true });

    expect(findPackageDir(startDir, "pino")).toBe(pkgDir);
  });

  it("walks up multiple ancestor levels to find a hoisted package (the real npm-install case)", () => {
    const root = makeTmpDir();
    dirs.push(root);
    // Simulates: <root>/node_modules/pino  (hoisted)
    //            <root>/node_modules/libi/.next/  (where .next actually is)
    const pkgDir = path.join(root, "node_modules", "pino");
    mkdirSync(pkgDir, { recursive: true });
    const nextDir = path.join(root, "node_modules", "libi", ".next");
    mkdirSync(nextDir, { recursive: true });

    expect(findPackageDir(nextDir, "pino")).toBe(pkgDir);
  });

  it("finds a scoped package", () => {
    const root = makeTmpDir();
    dirs.push(root);
    const pkgDir = path.join(root, "node_modules", "@napi-rs", "canvas");
    mkdirSync(pkgDir, { recursive: true });

    expect(findPackageDir(root, "@napi-rs/canvas")).toBe(pkgDir);
  });

  it("returns null when the package is nowhere in the ancestor chain", () => {
    const root = makeTmpDir();
    dirs.push(root);
    const startDir = path.join(root, "a", "b", "c");
    mkdirSync(startDir, { recursive: true });

    expect(findPackageDir(startDir, neverInstalledPackageName())).toBeNull();
  });
});

describe("farmHasResolvableEntries", () => {
  it("false when the directory doesn't exist", () => {
    const root = makeTmpDir();
    dirs.push(root);
    expect(farmHasResolvableEntries(path.join(root, "nope"))).toBe(false);
  });

  it("false when the only symlink DANGLES (the lstat-only false positive)", () => {
    const root = makeTmpDir();
    dirs.push(root);
    const farm = path.join(root, ".next", "node_modules");
    mkdirSync(farm, { recursive: true });
    symlinkSync(path.join(root, "node_modules", "gone"), path.join(farm, "gone-abc123"));

    expect(lstatSync(path.join(farm, "gone-abc123")).isSymbolicLink()).toBe(true);
    expect(farmHasResolvableEntries(farm)).toBe(false);
  });

  it("true for a resolvable symlink, including one nested under a scope dir", () => {
    const root = makeTmpDir();
    dirs.push(root);
    const pkgDir = path.join(root, "node_modules", "@napi-rs", "canvas");
    mkdirSync(pkgDir, { recursive: true });
    const farm = path.join(root, ".next", "node_modules", "@napi-rs");
    mkdirSync(farm, { recursive: true });
    symlinkSync(pkgDir, path.join(farm, "canvas-def456"));

    expect(farmHasResolvableEntries(path.join(root, ".next", "node_modules"))).toBe(true);
  });

  it("false for a PARTIALLY populated farm — one resolvable symlink is not enough when a sibling entry dangles", () => {
    // Regression: this used to return `true` on the FIRST resolvable symlink
    // it found, so a farm with 1 of 2 entries resolving and the other
    // dangling was accepted as fully healthy ("farm-already-present"),
    // silently skipping a rebuild it actually needed.
    const root = makeTmpDir();
    dirs.push(root);
    const pkgDir = path.join(root, "node_modules", "pino");
    mkdirSync(pkgDir, { recursive: true });
    const farm = path.join(root, ".next", "node_modules");
    mkdirSync(farm, { recursive: true });
    // Resolvable entry, created first so a "return true on first resolvable
    // symlink" implementation would short-circuit before ever seeing the
    // dangling one below.
    symlinkSync(pkgDir, path.join(farm, "pino-abc123"));
    // Dangling entry.
    symlinkSync(
      path.join(root, "node_modules", "gone"),
      path.join(farm, "gone-def456"),
    );

    expect(farmHasResolvableEntries(farm)).toBe(false);
  });
});

describe("ensureNextExternalSymlinks — loud failures", () => {
  it("THROWS MANIFEST_MISSING when there is no manifest and no usable symlink farm", () => {
    // This is the shipped-a-.next-without-the-manifest case. It used to be a
    // silent no-op, which produced a server that binds its port and 500s
    // every route — indistinguishable, at boot, from a healthy start.
    const nextDir = makeTmpDir();
    dirs.push(nextDir);
    writeBuildId(nextDir);

    expect(() => ensureNextExternalSymlinks(nextDir)).toThrowError(NextExternalsError);
    try {
      ensureNextExternalSymlinks(nextDir);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as NextExternalsError).code).toBe("MANIFEST_MISSING");
      expect((err as Error).message).toMatch(/500/);
    }
    expect(existsSync(path.join(nextDir, "node_modules"))).toBe(false);
  });

  it("THROWS MANIFEST_MISSING for an unparsable manifest with no usable farm", () => {
    const nextDir = makeTmpDir();
    dirs.push(nextDir);
    writeBuildId(nextDir);
    writeFileSync(path.join(nextDir, "externals-manifest.json"), "{not json");

    expect(() => ensureNextExternalSymlinks(nextDir)).toThrowError(/MANIFEST|missing or unreadable/i);
  });

  it("does NOT throw with no manifest when the real symlink farm is present and resolves (dev checkout / packaged Electron)", () => {
    const root = makeTmpDir();
    dirs.push(root);
    const pkgDir = path.join(root, "node_modules", "pino");
    mkdirSync(pkgDir, { recursive: true });
    const nextDir = path.join(root, ".next");
    const farm = path.join(nextDir, "node_modules");
    mkdirSync(farm, { recursive: true });
    symlinkSync(path.join("..", "..", "node_modules", "pino"), path.join(farm, "pino-abc123"));

    expect(ensureNextExternalSymlinks(nextDir)).toEqual({
      created: [],
      verified: [],
      skipped: "farm-already-present",
    });
  });

  it("THROWS MANIFEST_STALE when the manifest's buildId doesn't match .next/BUILD_ID", () => {
    // Verified empirically that a normal `next build` DOES clear stray files
    // at the `.next` root (a planted probe file was deleted), so this isn't
    // the common bad path — a MISSING manifest (case: build script wiring
    // didn't chain the writer) is. This check is defense-in-depth for what
    // that deletion doesn't cover: an interrupted/partial build, a
    // hand-copied or restored `.next`, or a future Next version that stops
    // clearing — any of which could leave a previous build's manifest
    // describing hashed names that no longer exist.
    const root = makeTmpDir();
    dirs.push(root);
    const pkgDir = path.join(root, "node_modules", "pino");
    mkdirSync(pkgDir, { recursive: true });
    const nextDir = path.join(root, ".next");
    mkdirSync(nextDir, { recursive: true });
    writeBuildId(nextDir, "current-build");
    writeManifest(nextDir, {
      buildId: "previous-build",
      links: [{ link: "pino-oldhash", package: "pino" }],
    });

    try {
      ensureNextExternalSymlinks(nextDir);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as NextExternalsError).code).toBe("MANIFEST_STALE");
      expect((err as Error).message).toContain("previous-build");
      expect((err as Error).message).toContain("current-build");
    }
    // And it must NOT have created the stale-named symlink.
    expect(existsSync(path.join(nextDir, "node_modules", "pino-oldhash"))).toBe(false);
  });

  it("THROWS MANIFEST_STALE when BUILD_ID is absent (nothing to verify against)", () => {
    const nextDir = makeTmpDir();
    dirs.push(nextDir);
    writeManifest(nextDir, { buildId: BUILD_ID, links: [] });

    try {
      ensureNextExternalSymlinks(nextDir);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as NextExternalsError).code).toBe("MANIFEST_STALE");
    }
  });

  it("THROWS PACKAGES_MISSING when a recorded external isn't installed anywhere", () => {
    const nextDir = makeTmpDir();
    dirs.push(nextDir);
    const pkg = neverInstalledPackageName();
    writeStamped(nextDir, [{ link: "ghost-abc123", package: pkg }]);

    try {
      ensureNextExternalSymlinks(nextDir);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as NextExternalsError).code).toBe("PACKAGES_MISSING");
      expect((err as Error).message).toContain(pkg);
    }
  });

  it("no-ops (no throw) for a current manifest that legitimately records zero externals", () => {
    const nextDir = makeTmpDir();
    dirs.push(nextDir);
    writeStamped(nextDir, []);

    expect(ensureNextExternalSymlinks(nextDir)).toEqual({
      created: [],
      verified: [],
      skipped: "no-externals",
    });
  });
});

describe("ensureNextExternalSymlinks — restore", () => {
  it("creates a missing top-level symlink, resolved fresh against the real node_modules — not a baked-in relative path", () => {
    const root = makeTmpDir();
    dirs.push(root);
    // The exact real-world shape this regressed on: `.next` nested two
    // levels under the install root, package hoisted to the TOP level
    // (NOT nested under node_modules/libi/node_modules/ — npm doesn't
    // create that when hoisting succeeds).
    const pkgDir = path.join(root, "node_modules", "pino");
    mkdirSync(pkgDir, { recursive: true });
    const nextDir = path.join(root, "node_modules", "libi", ".next");
    mkdirSync(nextDir, { recursive: true });
    writeStamped(nextDir, [{ link: "pino-abc123", package: "pino" }]);

    const result = ensureNextExternalSymlinks(nextDir);

    expect(result.created).toEqual([{ link: "pino-abc123", package: "pino" }]);
    expect(result.verified).toEqual([]);
    const linkPath = path.join(nextDir, "node_modules", "pino-abc123");
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    // The load-bearing assertion: it actually RESOLVES to the real package,
    // not a dangling link math'd for a different nesting depth.
    expect(realpathSync(linkPath)).toBe(realpathSync(pkgDir));
  });

  it("creates a nested scoped-package symlink, making parent dirs as needed", () => {
    const root = makeTmpDir();
    dirs.push(root);
    const pkgDir = path.join(root, "node_modules", "@napi-rs", "canvas");
    mkdirSync(pkgDir, { recursive: true });
    const nextDir = path.join(root, ".next");
    mkdirSync(nextDir, { recursive: true });
    writeStamped(nextDir, [
      { link: path.join("@napi-rs", "canvas-def456"), package: "@napi-rs/canvas" },
    ]);

    ensureNextExternalSymlinks(nextDir);

    const linkPath = path.join(nextDir, "node_modules", "@napi-rs", "canvas-def456");
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(realpathSync(linkPath)).toBe(realpathSync(pkgDir));
  });

  it("is idempotent — a second call on an already-correct symlink recreates nothing", () => {
    const root = makeTmpDir();
    dirs.push(root);
    const pkgDir = path.join(root, "node_modules", "pino");
    mkdirSync(pkgDir, { recursive: true });
    const nextDir = path.join(root, ".next");
    mkdirSync(nextDir, { recursive: true });
    writeStamped(nextDir, [{ link: "pino-abc123", package: "pino" }]);

    const first = ensureNextExternalSymlinks(nextDir);
    expect(first.created).toHaveLength(1);

    const second = ensureNextExternalSymlinks(nextDir);
    expect(second.created).toEqual([]);
    expect(second.verified).toEqual([{ link: "pino-abc123", package: "pino" }]);
  });

  it("dev-checkout / Electron-build case: a real, already-correct RELATIVE symlink from Next's own build is left untouched", () => {
    const root = makeTmpDir();
    dirs.push(root);
    const pkgDir = path.join(root, "node_modules", "pino");
    mkdirSync(pkgDir, { recursive: true });
    const nextDir = path.join(root, ".next");
    const nodeModulesDir = path.join(nextDir, "node_modules");
    mkdirSync(nodeModulesDir, { recursive: true });
    // A real Turbopack build emits a RELATIVE symlink — realpath must still
    // match even though the on-disk link string differs from what this
    // module itself would have written (absolute).
    symlinkSync(path.join("..", "..", "node_modules", "pino"), path.join(nodeModulesDir, "pino-abc123"));
    writeStamped(nextDir, [{ link: "pino-abc123", package: "pino" }]);

    const result = ensureNextExternalSymlinks(nextDir);

    expect(result.created).toEqual([]);
    expect(result.verified).toEqual([{ link: "pino-abc123", package: "pino" }]);
  });

  it("replaces a stale/incorrect symlink (points at the wrong package) rather than leaving it wrong", () => {
    const root = makeTmpDir();
    dirs.push(root);
    const pkgDir = path.join(root, "node_modules", "pino");
    const wrongDir = path.join(root, "node_modules", "not-pino");
    mkdirSync(pkgDir, { recursive: true });
    mkdirSync(wrongDir, { recursive: true });
    const nextDir = path.join(root, ".next");
    const nodeModulesDir = path.join(nextDir, "node_modules");
    mkdirSync(nodeModulesDir, { recursive: true });
    symlinkSync(wrongDir, path.join(nodeModulesDir, "pino-abc123"));
    writeStamped(nextDir, [{ link: "pino-abc123", package: "pino" }]);

    const result = ensureNextExternalSymlinks(nextDir);

    expect(result.created).toEqual([{ link: "pino-abc123", package: "pino" }]);
    expect(realpathSync(path.join(nodeModulesDir, "pino-abc123"))).toBe(realpathSync(pkgDir));
  });

  it("replaces a plain file sitting where the symlink should be (defensive — should never happen, but must self-heal not throw)", () => {
    const root = makeTmpDir();
    dirs.push(root);
    const pkgDir = path.join(root, "node_modules", "pino");
    mkdirSync(pkgDir, { recursive: true });
    const nextDir = path.join(root, ".next");
    const nodeModulesDir = path.join(nextDir, "node_modules");
    mkdirSync(nodeModulesDir, { recursive: true });
    writeFileSync(path.join(nodeModulesDir, "pino-abc123"), "not a symlink");
    writeStamped(nextDir, [{ link: "pino-abc123", package: "pino" }]);

    expect(() => ensureNextExternalSymlinks(nextDir)).not.toThrow();
    expect(lstatSync(path.join(nodeModulesDir, "pino-abc123")).isSymbolicLink()).toBe(true);
  });

  it("handles multiple entries independently — one already correct, one needs creating", () => {
    const root = makeTmpDir();
    dirs.push(root);
    const pinoDir = path.join(root, "node_modules", "pino");
    const esbuildDir = path.join(root, "node_modules", "esbuild");
    mkdirSync(pinoDir, { recursive: true });
    mkdirSync(esbuildDir, { recursive: true });
    const nextDir = path.join(root, ".next");
    const nodeModulesDir = path.join(nextDir, "node_modules");
    mkdirSync(nodeModulesDir, { recursive: true });
    symlinkSync(pinoDir, path.join(nodeModulesDir, "pino-abc123"));
    writeStamped(nextDir, [
      { link: "pino-abc123", package: "pino" },
      { link: "esbuild-def456", package: "esbuild" },
    ]);

    const result = ensureNextExternalSymlinks(nextDir);

    expect(result.created).toEqual([{ link: "esbuild-def456", package: "esbuild" }]);
    expect(result.verified).toEqual([{ link: "pino-abc123", package: "pino" }]);
  });

  it("one unresolvable package among several still throws — no partial-silent-success", () => {
    const root = makeTmpDir();
    dirs.push(root);
    mkdirSync(path.join(root, "node_modules", "pino"), { recursive: true });
    const nextDir = path.join(root, ".next");
    mkdirSync(nextDir, { recursive: true });
    const ghostPkg = neverInstalledPackageName();
    writeStamped(nextDir, [
      { link: "pino-abc123", package: "pino" },
      { link: "ghost-999", package: ghostPkg },
    ]);

    expect(() => ensureNextExternalSymlinks(nextDir)).toThrowError(NextExternalsError);
  });
});

// ── The property that lets a packaged boot avoid writing into the .app ──────
//
// The runtime bundle is materialised at `build/libi-bundle/` and then copied
// verbatim into `Libi.app/Contents/Resources/libi-bundle/`. So the farm has to
// be created at ONE path and used at ANOTHER — which absolute targets cannot
// survive. If these regress, the farm can only be built at first boot, i.e.
// inside a code-signed (and possibly read-only) app bundle.
describe("ensureNextExternalSymlinks — relocatable farm", () => {
  it("writes RELATIVE symlink targets, never absolute ones", () => {
    const root = makeTmpDir();
    dirs.push(root);
    mkdirSync(path.join(root, "node_modules", "pino"), { recursive: true });
    mkdirSync(path.join(root, "node_modules", "@napi-rs", "canvas"), { recursive: true });
    const nextDir = path.join(root, "node_modules", "libi", ".next");
    mkdirSync(nextDir, { recursive: true });
    writeStamped(nextDir, [
      { link: "pino-abc123", package: "pino" },
      { link: path.join("@napi-rs", "canvas-def456"), package: "@napi-rs/canvas" },
    ]);

    ensureNextExternalSymlinks(nextDir);

    for (const link of ["pino-abc123", path.join("@napi-rs", "canvas-def456")]) {
      const target = readlinkSync(path.join(nextDir, "node_modules", link));
      expect(path.isAbsolute(target)).toBe(false);
    }
  });

  it("the farm still resolves after the WHOLE tree is relocated", () => {
    const parent = makeTmpDir();
    dirs.push(parent);
    const root = path.join(parent, "build-machine-checkout");
    mkdirSync(path.join(root, "node_modules", "pino"), { recursive: true });
    mkdirSync(path.join(root, "node_modules", "@napi-rs", "canvas"), { recursive: true });
    const nextDir = path.join(root, "node_modules", "libi", ".next");
    mkdirSync(nextDir, { recursive: true });
    const links = [
      { link: "pino-abc123", package: "pino" },
      { link: path.join("@napi-rs", "canvas-def456"), package: "@napi-rs/canvas" },
    ];
    writeStamped(nextDir, links);

    expect(ensureNextExternalSymlinks(nextDir).created).toHaveLength(2);

    // The copy into Contents/Resources/.
    const moved = path.join(parent, "Resources", "libi-bundle");
    mkdirSync(path.dirname(moved), { recursive: true });
    renameSync(root, moved);
    const movedNext = path.join(moved, "node_modules", "libi", ".next");

    expect(farmHasResolvableEntries(path.join(movedNext, "node_modules"))).toBe(true);
    expect(realpathSync(path.join(movedNext, "node_modules", "pino-abc123"))).toBe(
      realpathSync(path.join(moved, "node_modules", "pino")),
    );
  });

  it("a relocated farm makes boot a pure verify — it writes nothing", () => {
    const parent = makeTmpDir();
    dirs.push(parent);
    const root = path.join(parent, "build-machine-checkout");
    mkdirSync(path.join(root, "node_modules", "pino"), { recursive: true });
    const nextDir = path.join(root, "node_modules", "libi", ".next");
    mkdirSync(nextDir, { recursive: true });
    writeStamped(nextDir, [{ link: "pino-abc123", package: "pino" }]);
    ensureNextExternalSymlinks(nextDir);

    const moved = path.join(parent, "Resources", "libi-bundle");
    mkdirSync(path.dirname(moved), { recursive: true });
    renameSync(root, moved);
    const movedNext = path.join(moved, "node_modules", "libi", ".next");

    // This is what `lib/server/next-server.ts` does on every packaged boot.
    // `created` MUST be empty: anything else is a write inside the signed .app.
    const atBoot = ensureNextExternalSymlinks(movedNext);
    expect(atBoot.created).toEqual([]);
    expect(atBoot.verified).toEqual([{ link: "pino-abc123", package: "pino" }]);
  });
});
