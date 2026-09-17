import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The parts of `lib/server/lifecycle/housekeeping.ts` that need the platform
 * and the home directory PINNED rather than inherited: `playwrightCacheDir()`'s
 * three branches, the marker gate, and `runBootHousekeeping`'s options.
 *
 * Pinned, not inherited, because CI is ubuntu-only: a `playwrightCacheDir()`
 * assertion that reads the host's real platform passes on a developer's Mac
 * (`~/Library/Caches/ms-playwright`) and fails on CI (`~/.cache/ms-playwright`).
 * `@/lib/platform` is the seam the module itself goes through — see its
 * docblock on why `process.platform === "…"` is not a runtime check here — so
 * that is what gets mocked, and `node:os`'s `homedir` with it.
 */
const env = vi.hoisted(() => ({ platform: "linux" as NodeJS.Platform, home: "/home/pinned" }));

vi.mock("@/lib/platform", () => ({
  isMac: () => env.platform === "darwin",
  isWindows: () => env.platform === "win32",
  isLinux: () => env.platform === "linux",
  exeSuffix: () => (env.platform === "win32" ? ".exe" : ""),
}));

vi.mock("node:os", async (orig) => {
  const real = await orig<typeof import("node:os")>();
  return { ...real, default: { ...real, homedir: () => env.home }, homedir: () => env.home };
});

vi.mock("@/lib/logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mcpLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { serverLogger } from "@/lib/logger";

let tmp: string;
const savedEnv: Record<string, string | undefined> = {};

function saveEnv(...names: string[]): void {
  for (const n of names) savedEnv[n] = process.env[n];
}

beforeEach(() => {
  vi.mocked(serverLogger.info).mockClear();
  vi.mocked(serverLogger.warn).mockClear();
  vi.mocked(serverLogger.debug).mockClear();
  env.platform = "linux";
  env.home = "/home/pinned";
  // `os.tmpdir()` is mocked through to the real one; only `homedir` is pinned.
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-housekeeping-opts-"));
  saveEnv(
    "PLAYWRIGHT_BROWSERS_PATH",
    "LOCALAPPDATA",
    "XDG_CACHE_HOME",
    "LIBI_SKIP_HOUSEKEEPING",
  );
  delete process.env.PLAYWRIGHT_BROWSERS_PATH;
  delete process.env.LOCALAPPDATA;
  delete process.env.XDG_CACHE_HOME;
  delete process.env.LIBI_SKIP_HOUSEKEEPING;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("playwrightCacheDir", () => {
  it("mirrors Playwright's macOS registry directory", async () => {
    env.platform = "darwin";
    env.home = "/Users/pinned";
    const { playwrightCacheDir } = await import("@/lib/server/lifecycle/housekeeping");
    expect(playwrightCacheDir()).toBe(
      path.join("/Users/pinned", "Library", "Caches", "ms-playwright"),
    );
  });

  it("uses LOCALAPPDATA on Windows, falling back to <home>/AppData/Local", async () => {
    env.platform = "win32";
    env.home = "C:\\Users\\pinned";
    const { playwrightCacheDir } = await import("@/lib/server/lifecycle/housekeeping");
    expect(playwrightCacheDir()).toBe(
      path.join("C:\\Users\\pinned", "AppData", "Local", "ms-playwright"),
    );
    process.env.LOCALAPPDATA = "D:\\local";
    expect(playwrightCacheDir()).toBe(path.join("D:\\local", "ms-playwright"));
  });

  it("uses XDG_CACHE_HOME on Linux, falling back to <home>/.cache", async () => {
    env.platform = "linux";
    env.home = "/home/pinned";
    const { playwrightCacheDir } = await import("@/lib/server/lifecycle/housekeeping");
    expect(playwrightCacheDir()).toBe(path.join("/home/pinned", ".cache", "ms-playwright"));
    process.env.XDG_CACHE_HOME = "/var/cache";
    expect(playwrightCacheDir()).toBe(path.join("/var/cache", "ms-playwright"));
  });

  it("PLAYWRIGHT_BROWSERS_PATH wins on every platform, except the literal '0'", async () => {
    const { playwrightCacheDir } = await import("@/lib/server/lifecycle/housekeeping");
    process.env.PLAYWRIGHT_BROWSERS_PATH = "/scratch/pw";
    for (const p of ["darwin", "win32", "linux"] as const) {
      env.platform = p;
      expect(playwrightCacheDir()).toBe("/scratch/pw");
    }
    process.env.PLAYWRIGHT_BROWSERS_PATH = "0";
    env.platform = "linux";
    expect(playwrightCacheDir()).toBe(path.join("/home/pinned", ".cache", "ms-playwright"));
  });

  it("never builds a relative path when HOME and USERPROFILE are both unset", async () => {
    // The bug this replaces: `process.env.HOME ?? process.env.USERPROFILE ?? ""`
    // resolved to "" under a launchd/systemd unit, and every branch below it
    // became a path relative to `process.cwd()` — for a sweep that deletes.
    // `os.homedir()` answers from the passwd entry, so it is never "".
    saveEnv("HOME", "USERPROFILE");
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    const { playwrightCacheDir } = await import("@/lib/server/lifecycle/housekeeping");
    for (const p of ["darwin", "win32", "linux"] as const) {
      env.platform = p;
      expect(path.isAbsolute(playwrightCacheDir())).toBe(true);
    }
  });
});

describe("the .libi-installed marker gate", () => {
  it("does not accept a SYMLINK as the marker (the cache is shared)", async () => {
    const { pruneStalePlaywrightRevisions, LIBI_INSTALLED_MARKER } = await import(
      "@/lib/server/lifecycle/housekeeping"
    );
    // Another tool's revision, with a `.libi-installed` symlink pointing at a
    // file that does exist. `existsSync` follows it and would answer "libi's".
    const other = path.join(tmp, "chromium-1180");
    fs.mkdirSync(other, { recursive: true });
    const decoy = path.join(tmp, "decoy");
    fs.writeFileSync(decoy, "x");
    fs.symlinkSync(decoy, path.join(other, LIBI_INSTALLED_MARKER));

    const { removed, kept } = pruneStalePlaywrightRevisions({
      cacheDir: tmp,
      pinnedRevisions: ["1217"],
    });

    expect(removed).toEqual([]);
    expect(kept).toEqual([other]);
    expect(fs.existsSync(other)).toBe(true);
  });

  it("does not accept a DIRECTORY named .libi-installed as the marker", async () => {
    const { pruneStalePlaywrightRevisions, LIBI_INSTALLED_MARKER } = await import(
      "@/lib/server/lifecycle/housekeeping"
    );
    const other = path.join(tmp, "chromium-1180");
    fs.mkdirSync(path.join(other, LIBI_INSTALLED_MARKER), { recursive: true });
    expect(
      pruneStalePlaywrightRevisions({ cacheDir: tmp, pinnedRevisions: ["1217"] }).removed,
    ).toEqual([]);
    expect(fs.existsSync(other)).toBe(true);
  });

  it("still prunes a revision carrying a real marker file", async () => {
    const { pruneStalePlaywrightRevisions, markLibiInstalled } = await import(
      "@/lib/server/lifecycle/housekeeping"
    );
    const ours = path.join(tmp, "chromium-1180");
    fs.mkdirSync(ours, { recursive: true });
    markLibiInstalled(ours);
    expect(
      pruneStalePlaywrightRevisions({ cacheDir: tmp, pinnedRevisions: ["1217"] }).removed,
    ).toEqual([ours]);
  });
});

describe("pruneStalePlaywrightRevisions logging", () => {
  it("says WHY it read nothing when the cache directory cannot be read", async () => {
    const { pruneStalePlaywrightRevisions } = await import(
      "@/lib/server/lifecycle/housekeeping"
    );
    const missing = path.join(tmp, "not-there");
    expect(
      pruneStalePlaywrightRevisions({ cacheDir: missing, pinnedRevisions: ["1217"] }),
    ).toEqual({ removed: [], kept: [] });
    const debugs = vi.mocked(serverLogger.debug).mock.calls;
    expect(debugs).toHaveLength(1);
    expect(debugs[0]![0]).toMatchObject({ tag: "lifecycle", op: "prune", dir: missing });
    expect(debugs[0]![0]).toHaveProperty("err");
  });
});

describe("runBootHousekeeping", () => {
  it("runs both sweeps and reports what each reclaimed", async () => {
    const { runBootHousekeeping } = await import("@/lib/server/lifecycle/housekeeping");
    const calls: string[] = [];
    await runBootHousekeeping({
      sweeps: [
        ["a", () => (calls.push("a"), { removed: ["/x"], kept: [] })],
        ["b", () => (calls.push("b"), { removed: [], kept: ["/y"] })],
      ],
    });
    expect(calls).toEqual(["a", "b"]);
    const reclaimed = vi
      .mocked(serverLogger.info)
      .mock.calls.filter(([f]) => (f as { what?: string }).what === "a");
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]![0]).toMatchObject({ what: "a", count: 1, paths: ["/x"] });
  });

  it("isolates a throwing sweep so the next one still runs", async () => {
    const { runBootHousekeeping } = await import("@/lib/server/lifecycle/housekeeping");
    const calls: string[] = [];
    await expect(
      runBootHousekeeping({
        sweeps: [
          [
            "boom",
            () => {
              calls.push("boom");
              throw new Error("EACCES");
            },
          ],
          ["after", () => (calls.push("after"), { removed: [], kept: [] })],
        ],
      }),
    ).resolves.toBeUndefined();
    expect(calls).toEqual(["boom", "after"]);
    const warned = vi
      .mocked(serverLogger.warn)
      .mock.calls.filter(([f]) => (f as { what?: string }).what === "boom");
    expect(warned).toHaveLength(1);
  });

  it("threads cacheDir and modelsDir into the real sweeps, touching nothing else", async () => {
    const { runBootHousekeeping, markLibiInstalled } = await import(
      "@/lib/server/lifecycle/housekeeping"
    );
    // A stale, libi-marked revision under a scratch cache…
    const cacheDir = path.join(tmp, "cache");
    const stale = path.join(cacheDir, "chromium-1180");
    fs.mkdirSync(stale, { recursive: true });
    markLibiInstalled(stale);
    // …and a finished tracking export under a scratch models dir.
    const modelsDir = path.join(tmp, "models");
    fs.mkdirSync(path.join(modelsDir, ".build"), { recursive: true });
    fs.writeFileSync(path.join(modelsDir, "yoloe11.onnx"), "x");
    fs.writeFileSync(path.join(modelsDir, "yoloe11.onnx.build-info.json"), "{}");

    await runBootHousekeeping({ cacheDir, modelsDir });

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(path.join(modelsDir, ".build"))).toBe(false);
    expect(fs.existsSync(path.join(modelsDir, "yoloe11.onnx"))).toBe(true);
  });

  it("does nothing at all under LIBI_SKIP_HOUSEKEEPING=1", async () => {
    const { runBootHousekeeping, SKIP_HOUSEKEEPING_ENV } = await import(
      "@/lib/server/lifecycle/housekeeping"
    );
    expect(SKIP_HOUSEKEEPING_ENV).toBe("LIBI_SKIP_HOUSEKEEPING");
    process.env[SKIP_HOUSEKEEPING_ENV] = "1";
    const calls: string[] = [];
    await runBootHousekeeping({
      sweeps: [["a", () => (calls.push("a"), { removed: [], kept: [] })]],
    });
    expect(calls).toEqual([]);
    const skipped = vi
      .mocked(serverLogger.info)
      .mock.calls.filter(([f]) => (f as { skipped?: boolean }).skipped === true);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]![0]).toMatchObject({ env: "LIBI_SKIP_HOUSEKEEPING" });
  });

  it("only honours the exact value '1', so a stray empty string does not disable it", async () => {
    const { runBootHousekeeping } = await import("@/lib/server/lifecycle/housekeeping");
    const calls: string[] = [];
    for (const value of ["", "0", "true"]) {
      process.env.LIBI_SKIP_HOUSEKEEPING = value;
      await runBootHousekeeping({
        sweeps: [["a", () => (calls.push(value), { removed: [], kept: [] })]],
      });
    }
    expect(calls).toEqual(["", "0", "true"]);
  });
});
