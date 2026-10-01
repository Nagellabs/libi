/**
 * EL-4 (Windows verification F5): the Windows payload ships no externals farm.
 *
 * The runtime bundle materialises `.next/node_modules` (the Turbopack externals
 * farm) at build time and verifies it — on the Windows runner as junctions.
 * electron-builder copies those junctions into the unpacked app as DEREFERENCED
 * real directories (9 packages, 883 files on 0.1.16), NSIS installs them, and
 * the first boot `rmSync`s every one to put a junction in its place: the
 * installer carried, and Defender scanned, a tree whose only fate was deletion.
 *
 * The afterPack hook now strips the farm from a win32 pack only — the dmg keeps
 * its relative symlinks, which boot merely verifies inside the signed .app. The
 * manifest boot rebuilds from stays. The farm lives in the RUNTIME ROOT,
 * `resources/libi-bundle/node_modules/@nagellabs/libi/.next/node_modules`
 * (`runtimeRootFor`); the first version looked at `libi-bundle/.next/…`, which
 * never exists, and passed silently (review C1) — so a win32 pack with no farm
 * where the runtime keeps it now FAILS the build.
 * Platform comes from electron-builder's `context.electronPlatformName`, never
 * the host's `process.platform` (CI is ubuntu).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const strip = require("../../../scripts/afterpack-windows-externals.js") as {
  stripWindowsExternalsFarm: (context: { appOutDir: string; electronPlatformName: string }) => {
    stripped: boolean;
    entries?: number;
    dir?: string;
    reason?: string;
  };
  bundleExternalsFarmDir: (context: { appOutDir: string; electronPlatformName: string }) => string;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { runtimeRootFor } = require("../../../scripts/build-runtime-bundle.js") as { runtimeRootFor: (prefix: string) => string };

const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/**
 * An unpacked Windows app laid out as electron-builder writes it: the bundle's
 * `extraResources` copy at resources/libi-bundle, the runtime installed under
 * it (`runtimeRootFor`), and the farm — dereferenced copies — in that runtime's
 * `.next/node_modules`.
 */
function winUnpacked(): { appOutDir: string; bundle: string; root: string; farm: string } {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-afterpack-win-"));
  roots.push(appOutDir);
  const bundle = path.join(appOutDir, "resources", "libi-bundle");
  const root = runtimeRootFor(bundle);
  for (const rel of [
    ".next/node_modules/better-sqlite3-abc123/package.json",
    ".next/node_modules/@napi-rs/canvas-def456/index.js",
    ".next/node_modules/pino-0a1b2c/lib/pino.js",
    ".next/externals-manifest.json",
    ".next/BUILD_ID",
    "package.json",
  ]) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), "{}");
  }
  for (const rel of ["node_modules/better-sqlite3/package.json", ".libi-runtime.json", "package.json"]) {
    fs.mkdirSync(path.dirname(path.join(bundle, rel)), { recursive: true });
    fs.writeFileSync(path.join(bundle, rel), "{}");
  }
  fs.mkdirSync(path.join(appOutDir, "resources", "app"), { recursive: true });
  return { appOutDir, bundle, root, farm: path.join(root, ".next", "node_modules") };
}

describe("stripWindowsExternalsFarm", () => {
  it("the farm it targets is the runtime root's, never libi-bundle/.next (which does not exist)", () => {
    const { appOutDir, bundle, farm } = winUnpacked();
    expect(strip.bundleExternalsFarmDir({ appOutDir, electronPlatformName: "win32" })).toBe(farm);
    expect(fs.existsSync(path.join(bundle, ".next"))).toBe(false);
  });

  it("win32: removes the runtime's .next/node_modules and nothing else", () => {
    const { appOutDir, bundle, root, farm } = winUnpacked();
    const r = strip.stripWindowsExternalsFarm({ appOutDir, electronPlatformName: "win32" });
    expect(r).toMatchObject({ stripped: true, entries: 3, dir: farm });
    expect(fs.existsSync(farm)).toBe(false);
    // What first boot rebuilds the farm FROM, and the runtime it points into, stay.
    for (const rel of [".next/externals-manifest.json", ".next/BUILD_ID", "package.json"]) {
      expect(fs.existsSync(path.join(root, rel)), rel).toBe(true);
    }
    for (const rel of ["node_modules/better-sqlite3/package.json", ".libi-runtime.json"]) {
      expect(fs.existsSync(path.join(bundle, rel)), rel).toBe(true);
    }
  });

  it.each(["darwin", "linux"])("%s: leaves the farm alone (it ships as relative symlinks boot only verifies)", (electronPlatformName) => {
    const { appOutDir, farm } = winUnpacked();
    const r = strip.stripWindowsExternalsFarm({ appOutDir, electronPlatformName });
    expect(r).toMatchObject({ stripped: false });
    expect(fs.existsSync(path.join(farm, "pino-0a1b2c", "lib", "pino.js"))).toBe(true);
  });

  it("win32 with no farm where the runtime keeps it FAILS the build — the bundle always has one, so its absence means the path drifted", () => {
    const { appOutDir, farm } = winUnpacked();
    fs.rmSync(farm, { recursive: true });
    expect(() => strip.stripWindowsExternalsFarm({ appOutDir, electronPlatformName: "win32" })).toThrow(/no externals farm/);
  });

  it("win32 with no runtime at all FAILS the build too", () => {
    const { appOutDir, bundle } = winUnpacked();
    fs.rmSync(path.join(bundle, "node_modules"), { recursive: true });
    expect(() => strip.stripWindowsExternalsFarm({ appOutDir, electronPlatformName: "win32" })).toThrow(/no externals farm/);
  });

  it("win32: a farm entry that is still a link is unlinked, never followed into the runtime it points at", () => {
    const { appOutDir, bundle, farm } = winUnpacked();
    const target = path.join(bundle, "node_modules", "better-sqlite3");
    fs.symlinkSync(target, path.join(farm, "better-sqlite3-linked"), "junction");
    strip.stripWindowsExternalsFarm({ appOutDir, electronPlatformName: "win32" });
    expect(fs.existsSync(path.join(target, "package.json"))).toBe(true);
    expect(fs.existsSync(farm)).toBe(false);
  });
});

describe("the afterPack hook electron-builder runs", () => {
  it("electron-builder.yml points afterPack at scripts/afterpack.js", () => {
    const cfg = yaml.load(fs.readFileSync(path.resolve(__dirname, "../../../electron-builder.yml"), "utf8")) as { afterPack: string };
    expect(cfg.afterPack).toBe("scripts/afterpack.js");
  });

  it("strips the Windows farm, then runs the licence guard over what is left", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const guard = require("../../../scripts/afterpack-license-guard.js");
    const order: string[] = [];
    const guardSpy = vi.spyOn(guard, "afterPackLicenseGuard").mockImplementation(async () => {
      order.push("guard");
    });
    const stripSpy = vi.spyOn(strip, "stripWindowsExternalsFarm").mockImplementation(() => {
      order.push("strip");
      return { stripped: false, reason: "test" };
    });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const afterPack = require("../../../scripts/afterpack.js") as (ctx: unknown) => Promise<void>;
    const ctx = { appOutDir: "/x", electronPlatformName: "win32" };
    await afterPack(ctx);
    expect(order).toEqual(["strip", "guard"]);
    expect(stripSpy).toHaveBeenCalledWith(ctx);
    expect(guardSpy).toHaveBeenCalledWith(ctx);
  });
});
