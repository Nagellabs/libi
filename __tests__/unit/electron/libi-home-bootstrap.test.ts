import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * `electron/libi-home-bootstrap.ts` pins the packaged app's on-disk identity.
 *
 * The real incident: the npm rename `libi` → `@nagellabs/libi` moved the
 * packaged app's userData from `…/Application Support/libi` to
 * `…/Application Support/@nagellabs/libi`, because Electron derives userData
 * from `app.getName()`, which for a packaged build reads
 * `Resources/app/package.json#name`. Everything a packaged install owns —
 * SQLite DB, pieces, agent workspace, runtime-installed binaries — moved with
 * it. These tests pin the identity to a literal so a future package rename
 * cannot repeat that.
 *
 * The `app` double below deliberately reproduces the caching semantics
 * MEASURED against Electron 36, not idealised ones:
 *   - `getPath("userData")` resolves `join(appData, name)` on FIRST read and
 *     caches it,
 *   - `setName` afterwards does NOT retroactively move it,
 *   - `setPath("userData", …)` overrides it unconditionally.
 * A faithful double is what makes the ordering test below meaningful; against
 * an idealised one (recompute-on-every-read) the ordering bug would be
 * invisible.
 */

const APP_DATA = "/Users/test/Library/Application Support";
const REGISTRY_NAME = "@nagellabs/libi";

interface FakeApp {
  isPackaged: boolean;
  getName(): string;
  setName(n: string): void;
  getPath(k: string): string;
  setPath(k: string, v: string): void;
  calls: string[];
}

let fakeApp: FakeApp;

function makeApp(isPackaged: boolean): FakeApp {
  let name = REGISTRY_NAME;
  let userDataCache: string | null = null;
  const calls: string[] = [];
  return {
    isPackaged,
    calls,
    getName: () => name,
    setName(n: string) {
      calls.push(`setName:${n}`);
      name = n;
    },
    getPath(k: string) {
      if (k === "appData") {
        calls.push("getPath:appData");
        return APP_DATA;
      }
      if (k === "userData") {
        calls.push("getPath:userData");
        // First read wins and is cached — the measured Electron behaviour.
        userDataCache ??= path.join(APP_DATA, name);
        return userDataCache;
      }
      throw new Error(`unexpected getPath(${k})`);
    },
    setPath(k: string, v: string) {
      calls.push(`setPath:${k}`);
      if (k === "userData") userDataCache = v;
    },
  };
}

vi.mock("electron", () => ({
  get app() {
    return fakeApp;
  },
}));

const syncLog = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock("@/electron/sync-log", () => ({
  mainSyncLog: (line: string) => {
    syncLog.lines.push(line);
  },
}));

async function loadBootstrap() {
  vi.resetModules();
  return import("@/electron/libi-home-bootstrap");
}

describe("libi-home-bootstrap app identity pin", () => {
  beforeEach(() => {
    delete process.env.LIBI_HOME;
    delete process.env.LIBI_USER_DATA_DIR;
    syncLog.lines.length = 0;
  });

  it("pins userData to the literal app name, not the npm package name", async () => {
    fakeApp = makeApp(true);
    const mod = await loadBootstrap();

    expect(mod.LIBI_APP_NAME).toBe("libi");
    expect(fakeApp.getPath("userData")).toBe(path.join(APP_DATA, "libi"));
    // The regression itself: never the scoped registry identity.
    expect(fakeApp.getPath("userData")).not.toContain("@nagellabs");
  });

  it("makes app.getName() honest too, so menus/notifications/crash reports agree", async () => {
    fakeApp = makeApp(true);
    await loadBootstrap();
    expect(fakeApp.getName()).toBe("libi");
  });

  it("publishes LIBI_HOME as the pinned path", async () => {
    fakeApp = makeApp(true);
    await loadBootstrap();
    expect(process.env.LIBI_HOME).toBe(path.join(APP_DATA, "libi"));
  });

  it("fixes the identity BEFORE any userData read (ordering is load-bearing)", async () => {
    fakeApp = makeApp(true);
    await loadBootstrap();

    const firstRead = fakeApp.calls.indexOf("getPath:userData");
    expect(firstRead).toBeGreaterThanOrEqual(0);
    // Both pin calls must precede the first read. Reordering the module so it
    // reads userData first is exactly the bug this guards.
    expect(fakeApp.calls.indexOf("setName:libi")).toBeLessThan(firstRead);
    expect(fakeApp.calls.indexOf("setPath:userData")).toBeLessThan(firstRead);
  });

  it("still corrects userData when something already resolved it first", async () => {
    // The belt to setName's braces: simulate a future earlier import having
    // already read (and thus cached) userData under the registry name. setName
    // alone cannot recover from this — only the explicit setPath can.
    fakeApp = makeApp(true);
    expect(fakeApp.getPath("userData")).toBe(path.join(APP_DATA, REGISTRY_NAME));

    await loadBootstrap();

    expect(fakeApp.getPath("userData")).toBe(path.join(APP_DATA, "libi"));
    expect(process.env.LIBI_HOME).toBe(path.join(APP_DATA, "libi"));
  });

  it("does not overwrite an explicitly provided LIBI_HOME, but still pins the profile", async () => {
    fakeApp = makeApp(true);
    process.env.LIBI_HOME = "/custom/home";
    await loadBootstrap();

    expect(process.env.LIBI_HOME).toBe("/custom/home");
    // userData is also Chromium's profile root, so it is pinned regardless.
    expect(fakeApp.getPath("userData")).toBe(path.join(APP_DATA, "libi"));
  });

  it("leaves dev alone — a bare `electron .` must not land in the packaged home", async () => {
    fakeApp = makeApp(false);
    await loadBootstrap();

    expect(fakeApp.calls).not.toContain("setName:libi");
    expect(fakeApp.calls).not.toContain("setPath:userData");
    expect(process.env.LIBI_HOME).toBeUndefined();
  });
});

/**
 * `LIBI_USER_DATA_DIR` — the QA opt-in that lets a second packaged Libi run
 * beside the operator's. userData is what Electron keys the single-instance
 * lock on, and LIBI_HOME defaults from it, so moving it gives the second copy
 * its own lock AND its own data.
 */
describe("libi-home-bootstrap LIBI_USER_DATA_DIR", () => {
  let scratch: string;

  beforeEach(() => {
    delete process.env.LIBI_HOME;
    delete process.env.LIBI_USER_DATA_DIR;
    syncLog.lines.length = 0;
    scratch = mkdtempSync(path.join(os.tmpdir(), "libi-user-data-dir-"));
  });

  afterEach(() => {
    delete process.env.LIBI_HOME;
    delete process.env.LIBI_USER_DATA_DIR;
    rmSync(scratch, { recursive: true, force: true });
  });

  it("moves userData and LIBI_HOME to an absolute dir, creating it, before anything reads userData", async () => {
    const dir = path.join(scratch, "qa", "libi");
    process.env.LIBI_USER_DATA_DIR = dir;
    fakeApp = makeApp(true);
    await loadBootstrap();

    expect(fakeApp.getPath("userData")).toBe(dir);
    expect(process.env.LIBI_HOME).toBe(dir);
    expect(existsSync(dir)).toBe(true);
    // The identity pin is unchanged — only the directory moves.
    expect(fakeApp.getName()).toBe("libi");
    const firstRead = fakeApp.calls.indexOf("getPath:userData");
    expect(fakeApp.calls.lastIndexOf("setPath:userData")).toBeLessThan(firstRead);
    // Logged exactly once, naming the directory.
    const mentions = syncLog.lines.filter((l) => l.includes("LIBI_USER_DATA_DIR"));
    expect(mentions).toHaveLength(1);
    expect(mentions[0]).toContain(dir);
  });

  it("normalizes the path it applies", async () => {
    process.env.LIBI_USER_DATA_DIR = `${scratch}/a/../b/`;
    fakeApp = makeApp(true);
    await loadBootstrap();
    expect(fakeApp.getPath("userData")).toBe(path.join(scratch, "b"));
  });

  it("an explicitly set LIBI_HOME still wins; the profile still moves", async () => {
    const dir = path.join(scratch, "profile");
    process.env.LIBI_USER_DATA_DIR = dir;
    process.env.LIBI_HOME = "/custom/home";
    fakeApp = makeApp(true);
    await loadBootstrap();

    expect(process.env.LIBI_HOME).toBe("/custom/home");
    expect(fakeApp.getPath("userData")).toBe(dir);
  });

  it.each([
    ["relative", "qa/libi"],
    ["dot-relative", "./qa"],
    ["empty", ""],
    ["whitespace", "   "],
  ])("ignores a %s value and logs that it did", async (_label, value) => {
    process.env.LIBI_USER_DATA_DIR = value;
    fakeApp = makeApp(true);
    await loadBootstrap();

    expect(fakeApp.getPath("userData")).toBe(path.join(APP_DATA, "libi"));
    expect(process.env.LIBI_HOME).toBe(path.join(APP_DATA, "libi"));
    const mentions = syncLog.lines.filter((l) => l.includes("LIBI_USER_DATA_DIR"));
    expect(mentions).toHaveLength(1);
    expect(mentions[0]).toMatch(/ignored/);
  });

  it("falls back to the default, and says so, when the dir cannot be created", async () => {
    const file = path.join(scratch, "a-file");
    writeFileSync(file, "");
    process.env.LIBI_USER_DATA_DIR = path.join(file, "under-a-file");
    fakeApp = makeApp(true);
    await loadBootstrap();

    expect(fakeApp.getPath("userData")).toBe(path.join(APP_DATA, "libi"));
    const mentions = syncLog.lines.filter((l) => l.includes("LIBI_USER_DATA_DIR"));
    expect(mentions).toHaveLength(1);
    expect(mentions[0]).toMatch(/ignored/);
  });

  it("unset: exactly today's calls, in order — appData is read first to build the default before the pin", async () => {
    fakeApp = makeApp(true);
    await loadBootstrap();
    expect(fakeApp.calls).toEqual(["getPath:appData", "setName:libi", "setPath:userData", "getPath:userData"]);
    expect(syncLog.lines).toEqual([]);
  });

  it("dev ignores it entirely — dev's profile is <LIBI_HOME>/electron-profile", async () => {
    process.env.LIBI_USER_DATA_DIR = path.join(scratch, "dev");
    fakeApp = makeApp(false);
    await loadBootstrap();
    expect(fakeApp.calls).toEqual([]);
    expect(process.env.LIBI_HOME).toBeUndefined();
    expect(existsSync(path.join(scratch, "dev"))).toBe(false);
  });
});

describe("resolveUserDataOverride: absoluteness is judged by the host platform", () => {
  const realPlatform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: realPlatform });
  });

  async function resolveOn(platform: NodeJS.Platform, value: string | undefined) {
    Object.defineProperty(process, "platform", { value: platform });
    fakeApp = makeApp(false);
    const mod = await loadBootstrap();
    return mod.resolveUserDataOverride(value);
  }

  it.each([
    ["C:\\QA\\libi", { dir: "C:\\QA\\libi" }],
    ["C:/QA/libi", { dir: "C:\\QA\\libi" }],
    ["\\\\server\\share\\libi", { dir: "\\\\server\\share\\libi" }],
    ["QA\\libi", { ignored: expect.stringMatching(/not an absolute path/) }],
    // Drive-relative: resolved against that drive's cwd — not a fixed place.
    ["C:QA", { ignored: expect.stringMatching(/not an absolute path/) }],
  ])("win32: %s", async (value, expected) => {
    expect(await resolveOn("win32", value)).toEqual(expected);
  });

  it.each([
    ["/tmp/qa-libi", { dir: "/tmp/qa-libi" }],
    ["C:\\QA\\libi", { ignored: expect.stringMatching(/not an absolute path/) }],
    ["qa", { ignored: expect.stringMatching(/not an absolute path/) }],
  ])("posix: %s", async (value, expected) => {
    expect(await resolveOn("linux", value)).toEqual(expected);
  });

  it("unset is no override and nothing to report", async () => {
    expect(await resolveOn("linux", undefined)).toBeNull();
    expect(await resolveOn("win32", undefined)).toBeNull();
  });
});
