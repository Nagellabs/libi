import { describe, expect, it, vi, beforeEach } from "vitest";
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
      if (k === "appData") return APP_DATA;
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

async function loadBootstrap() {
  vi.resetModules();
  return import("@/electron/libi-home-bootstrap");
}

describe("libi-home-bootstrap app identity pin", () => {
  beforeEach(() => {
    delete process.env.LIBI_HOME;
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
