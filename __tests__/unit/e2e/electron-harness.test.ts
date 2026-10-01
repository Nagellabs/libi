import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `npm run test:electron` used to assume a studio was already running on
 * LIBI_PORT (default 3456). Without one, every launch sat out the unpackaged
 * shell's 60 s poll and then put a modal "did not respond" dialog on the
 * owner's screen — once per test. And on a fresh home the first-launch
 * redirect raced topbar.spec.ts (suites report E1). The harness now starts its
 * own studio, answers the persona like the web fixture, and refuses to launch
 * a shell into a modal.
 */

const pw = vi.hoisted(() => ({
  order: [] as string[],
  launch: vi.fn(),
  newContext: vi.fn(),
}));

vi.mock("@playwright/test", async () => {
  const vitest = await import("vitest");
  return {
    _electron: { launch: pw.launch },
    request: { newContext: pw.newContext },
    expect: vitest.expect,
    test: { extend: () => ({}) },
    defineConfig: <T>(c: T) => c,
  };
});

const saved = { ...process.env };
/** The config now creates its scratch home (and `home/` inside it) at load. */
function cleanupHome(home: string): void {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(`${home}-fake-cli`, { recursive: true, force: true });
}
function restoreEnv(): void {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
}

describe("playwright.electron.config.ts", () => {
  type ElectronConfig = {
    webServer: { command: string; url: string; reuseExistingServer: boolean; env: Record<string, string> };
    globalTeardown?: string;
  };
  async function load(): Promise<ElectronConfig> {
    vi.resetModules();
    return (await import("../../../playwright.electron.config")).default as unknown as ElectronConfig;
  }
  beforeEach(() => {
    for (const k of [
      "LIBI_E2E_OWNED_SCRATCH",
      "LIBI_E2E_RUN",
      "LIBI_PORT",
      "LIBI_HOME",
      "LIBI_MCP_PORT",
      "LIBI_ELECTRON_E2E_OWNS_SERVER",
      "LIBI_ELECTRON_E2E_PORT",
      "LIBI_ELECTRON_E2E_HOME",
      "LIBI_NO_DEVTOOLS",
    ]) {
      delete process.env[k];
    }
    // Pose as a re-load after the runner checked the default pair: no port probe.
    process.env.LIBI_ELECTRON_E2E_PORTS_CHECKED = "3477,3478";
  });
  afterEach(restoreEnv);

  it("starts its own studio: node bin/libi.js, test mode, a /tmp/ scratch home, its own Next dir", async () => {
    const config = await load();
    cleanupHome(config.webServer.env.LIBI_HOME);
    expect(config.webServer.command).toBe("node bin/libi.js");
    expect(config.webServer.reuseExistingServer).toBe(false);
    expect(config.webServer.env.LIBI_TEST_MODE).toBe("1");
    expect(config.webServer.env.LIBI_HOME.startsWith("/tmp/")).toBe(true);
    expect(config.webServer.env.LIBI_NEXT_DIST_DIR).toBe(".next-electron-e2e");
    expect(config.webServer.env.LIBI_PORT).toBe("3477");
    expect(config.webServer.env.LIBI_MCP_PORT).toBe("3478");
    expect(config.webServer.url).toBe("http://127.0.0.1:3477/editor");
    expect(config.globalTeardown).toBe("./e2e/support/global-teardown.ts");
  });

  it("hands the specs, and every shell they launch, the same port and home, with no DevTools window", async () => {
    const config = await load();
    cleanupHome(config.webServer.env.LIBI_HOME);
    expect(process.env.LIBI_PORT).toBe("3477");
    expect(process.env.LIBI_HOME).toBe(config.webServer.env.LIBI_HOME);
    expect(process.env.LIBI_NO_DEVTOOLS).toBe("1");
  });

  it("an explicit LIBI_PORT + LIBI_HOME attaches to that studio and never starts one", async () => {
    process.env.LIBI_PORT = "3790";
    process.env.LIBI_HOME = "/tmp/libi-some-dev-home";
    const config = await load();
    // No webServer at all: with Playwright's reuse-or-start, a studio that had died would be
    // replaced by a test-mode one inside the home named here. launchLibi's refusal says so instead.
    expect(config.webServer).toBeUndefined();
    expect(process.env.LIBI_PORT).toBe("3790");
    expect(process.env.LIBI_HOME).toBe("/tmp/libi-some-dev-home");
    expect(process.env.LIBI_E2E_OWNED_SCRATCH).toBeUndefined();
  });

  it("gives its studio a scratch HOME, CLAUDE_CONFIG_DIR and CLI folder (never the owner's ~/.libi/worktrees)", async () => {
    const config = await load();
    const env = config.webServer.env;
    try {
      expect(env.HOME).toBe(path.join(env.LIBI_HOME, "home"));
      expect(env.CLAUDE_CONFIG_DIR).toBe(path.join(env.LIBI_HOME, "claude-config"));
      expect(env.LIBI_TEST_AGENT_CLI_DIRS).toBe(`${env.LIBI_HOME}-fake-cli`);
      expect(env.LIBI_ENABLE_TEST_ROUTES).toBe("1");
      expect(env.PLAYWRIGHT_BROWSERS_PATH).toBeTruthy();
      // …and lists what it made for the teardown to remove.
      expect(JSON.parse(process.env.LIBI_E2E_OWNED_SCRATCH!)).toMatchObject({
        port: "3477",
        paths: [env.LIBI_HOME, `${env.LIBI_HOME}-fake-cli`],
      });
    } finally {
      fs.rmSync(env.LIBI_HOME, { recursive: true, force: true });
      fs.rmSync(`${env.LIBI_HOME}-fake-cli`, { recursive: true, force: true });
    }
  });

  it("keeps a home the caller named (LIBI_ELECTRON_E2E_HOME) out of the teardown's list", async () => {
    const named = fs.mkdtempSync(path.join(os.tmpdir(), "libi-named-home-"));
    process.env.LIBI_ELECTRON_E2E_HOME = named;
    try {
      await load();
      // Its `-fake-cli` sibling did not exist, so the config created it: that one is listed.
      expect(JSON.parse(process.env.LIBI_E2E_OWNED_SCRATCH!)).toMatchObject({ port: "3477", paths: [`${named}-fake-cli`] });
    } finally {
      fs.rmSync(named, { recursive: true, force: true });
      fs.rmSync(`${named}-fake-cli`, { recursive: true, force: true });
    }
  });

  it("refuses an explicit LIBI_PORT without the LIBI_HOME its studio runs on", async () => {
    process.env.LIBI_PORT = "3790";
    await expect(load()).rejects.toThrow(/LIBI_HOME is not/);
  });
});

describe("e2e/support/harness.ts listeningPorts", () => {
  it("reports a port something listens on, and not one nothing does", async () => {
    const { listeningPorts } = await import("../../../e2e/support/harness");
    const busy = http.createServer();
    await new Promise<void>((r) => busy.listen(0, "127.0.0.1", r));
    const free = http.createServer();
    await new Promise<void>((r) => free.listen(0, "127.0.0.1", r));
    const freePort = String((free.address() as AddressInfo).port);
    await new Promise<void>((r) => free.close(() => r()));
    try {
      const busyPort = String((busy.address() as AddressInfo).port);
      expect(listeningPorts([busyPort, freePort])).toEqual([busyPort]);
    } finally {
      await new Promise<void>((r) => busy.close(() => r()));
    }
  });
});

describe("launchLibi()", () => {
  let studio: http.Server | null = null;

  beforeEach(() => {
    pw.order.length = 0;
    pw.launch.mockReset();
    pw.newContext.mockReset();
    pw.newContext.mockImplementation(async (opts: { baseURL: string; extraHTTPHeaders: Record<string, string> }) => ({
      put: vi.fn(async (url: string, init: { data: unknown }) => {
        pw.order.push(`put ${url} ${JSON.stringify(init.data)} via ${opts.baseURL} ${JSON.stringify(opts.extraHTTPHeaders)}`);
        return { ok: () => true };
      }),
      dispose: vi.fn(async () => {}),
    }));
    const page = { url: () => `http://127.0.0.1:${process.env.LIBI_PORT}/editor`, waitForLoadState: vi.fn(async () => {}) };
    pw.launch.mockImplementation(async () => {
      pw.order.push("launch");
      return { windows: () => [page] };
    });
  });
  afterEach(async () => {
    restoreEnv();
    vi.restoreAllMocks();
    if (studio) await new Promise<void>((r) => studio!.close(() => r()));
    studio = null;
  });

  async function startStudio(): Promise<string> {
    studio = http.createServer((_req, res) => res.end("ok"));
    await new Promise<void>((r) => studio!.listen(0, "127.0.0.1", r));
    return String((studio.address() as AddressInfo).port);
  }

  async function loadHelpers() {
    vi.resetModules();
    const fs = (await import("node:fs")).default;
    const realExists = fs.existsSync;
    // The compiled shell need not exist for these: nothing is really launched.
    vi.spyOn(fs, "existsSync").mockImplementation((p) => String(p).endsWith("main.js") || realExists(p));
    return import("../../../e2e/electron/helpers");
  }

  it("answers the persona on the studio, as libi's own page, before it launches the shell", async () => {
    const port = await startStudio();
    process.env.LIBI_PORT = port;
    const { launchLibi } = await loadHelpers();
    await launchLibi();
    const origin = `http://127.0.0.1:${port}`;
    expect(pw.order).toEqual([
      `put /api/onboarding/persona {"persona":"developer"} via ${origin} {"origin":"${origin}","sec-fetch-site":"same-origin"}`,
      "launch",
    ]);
    const env = (pw.launch.mock.calls[0][0] as { env: Record<string, string> }).env;
    expect(env.LIBI_PORT).toBe(port);
    expect(env.LIBI_NO_DEVTOOLS).toBe("1");
  });

  it("waits for a studio that is still binding its port instead of refusing at once", async () => {
    const port = await startStudio();
    await new Promise<void>((r) => studio!.close(() => r()));
    process.env.LIBI_PORT = port;
    const { launchLibi } = await loadHelpers();
    const launched = launchLibi({ studioWaitMs: 10_000 });
    await new Promise((r) => setTimeout(r, 700));
    studio = http.createServer((_req, res) => res.end("ok"));
    await new Promise<void>((r) => studio!.listen(Number(port), "127.0.0.1", r));
    await launched;
    expect(pw.order).toContain("launch");
  });

  it("leaves the persona unanswered for a spec of the first-launch path", async () => {
    process.env.LIBI_PORT = await startStudio();
    const { launchLibi } = await loadHelpers();
    await launchLibi({ firstLaunch: true });
    expect(pw.newContext).not.toHaveBeenCalled();
    expect(pw.order).toEqual(["launch"]);
  });

  it("refuses to launch a shell when nothing answers on LIBI_PORT (it would end in a modal dialog)", async () => {
    const port = await startStudio();
    await new Promise<void>((r) => studio!.close(() => r()));
    studio = null;
    process.env.LIBI_PORT = port;
    const { launchLibi } = await loadHelpers();
    await expect(launchLibi({ studioWaitMs: 300 })).rejects.toThrow(new RegExp(`no studio on :${port}`));
    expect(pw.launch).not.toHaveBeenCalled();
    expect(pw.newContext).not.toHaveBeenCalled();
  });
});

describe("e2e/support/harness.ts scratch cleanup: owned by construction", () => {
  const made: string[] = [];
  beforeEach(() => {
    delete process.env.LIBI_E2E_OWNED_SCRATCH;
    delete process.env.LIBI_E2E_RUN;
  });
  afterEach(() => {
    restoreEnv();
    for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  /** A port nothing listens on (the studio has stopped). */
  async function closedPort(): Promise<string> {
    const s = http.createServer();
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const port = String((s.address() as AddressInfo).port);
    await new Promise<void>((r) => s.close(() => r()));
    return port;
  }
  async function gone(dir: string, ms = 15_000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (fs.existsSync(dir) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    return !fs.existsSync(dir);
  }
  /** Long enough for the detached cleanup to have acted on everything it would. */
  const settle = () => new Promise((r) => setTimeout(r, 4_000));

  it("removes only libi-* dirs directly under /tmp or the OS temp dir (a last filter, not a proof)", async () => {
    const { isRemovableScratch } = await import("../../../e2e/support/harness");
    expect(isRemovableScratch("/tmp/libi-electron-e2e-1")).toBe(true);
    expect(isRemovableScratch(path.join(os.tmpdir(), "libi-e2e-1"))).toBe(true);
    expect(isRemovableScratch("/tmp/other-dir")).toBe(false);
    expect(isRemovableScratch("/tmp/a/libi-nested")).toBe(false);
    expect(isRemovableScratch(path.join(os.homedir(), ".libi"))).toBe(false);
  });

  it("a TMPDIR at (or above) $HOME can't widen scratch to a home-rooted dir", async () => {
    process.env.TMPDIR = os.homedir();
    const { isRemovableScratch } = await import("../../../e2e/support/harness");
    expect(isRemovableScratch(path.join(os.homedir(), "libi-home"))).toBe(false);
    // /tmp itself is untouched by the TMPDIR override, so it still works normally.
    expect(isRemovableScratch("/tmp/libi-still-fine")).toBe(true);
  });

  it("makes each scratch home with mkdtemp: two in the same millisecond never share a name, and each carries this run's marker", async () => {
    const { makeOwnedTempDir, e2eRunId, SCRATCH_MARKER } = await import("../../../e2e/support/harness");
    const a = makeOwnedTempDir(os.tmpdir(), "libi-mkdtemp-test");
    const b = makeOwnedTempDir(os.tmpdir(), "libi-mkdtemp-test");
    made.push(a, b);
    expect(a).not.toBe(b);
    expect(fs.readFileSync(path.join(a, SCRATCH_MARKER), "utf8")).toBe(e2eRunId());
  });

  it("removes what the run created once the studio port is closed", async () => {
    const { claimScratch, makeOwnedTempDir, scheduleScratchCleanup } = await import("../../../e2e/support/harness");
    const dir = makeOwnedTempDir(os.tmpdir(), "libi-cleanup-test");
    made.push(dir);
    fs.writeFileSync(path.join(dir, "libi.log"), "x");
    const port = await closedPort();
    claimScratch(port, [dir]);
    // A worker re-loading the config keeps the runner's list.
    claimScratch(port, ["/tmp/libi-a-worker-must-not-overwrite"]);
    expect(JSON.parse(process.env.LIBI_E2E_OWNED_SCRATCH!).paths).toEqual([dir]);
    scheduleScratchCleanup();
    expect(await gone(dir)).toBe(true);
  }, 20_000);

  it("never deletes a claimed dir that lacks this run's marker", async () => {
    const { claimScratch, scheduleScratchCleanup } = await import("../../../e2e/support/harness");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-unmarked-"));
    made.push(dir);
    const port = await closedPort();
    claimScratch(port, [dir]);
    scheduleScratchCleanup();
    await settle();
    expect(fs.existsSync(dir)).toBe(true);
  }, 20_000);

  it("ignores a claim list inherited from another run, and replaces it with its own", async () => {
    const { claimScratch, makeOwnedTempDir, scheduleScratchCleanup } = await import("../../../e2e/support/harness");
    const outer = makeOwnedTempDir(os.tmpdir(), "libi-outer-run");
    made.push(outer);
    const port = await closedPort();
    // As if inherited from an outer run's environment: another pid's run id.
    process.env.LIBI_E2E_RUN = "1:feedface";
    process.env.LIBI_E2E_OWNED_SCRATCH = JSON.stringify({ run: "1:feedface", port, paths: [outer] });
    scheduleScratchCleanup();
    await settle();
    expect(fs.existsSync(outer)).toBe(true);
    claimScratch(port, []);
    const mine = JSON.parse(process.env.LIBI_E2E_OWNED_SCRATCH!) as { run: string; paths: string[] };
    expect(mine.run).not.toBe("1:feedface");
    expect(mine.run.startsWith(`${process.pid}:`)).toBe(true);
    expect(mine.paths).toEqual([]);
  }, 20_000);

  // Review R-I1: a CLI dir the caller named is theirs, even under /tmp/libi-*.
  it("web config: a LIBI_TEST_AGENT_CLI_DIRS the caller named is never claimed, and survives the cleanup", async () => {
    const callerClis = fs.mkdtempSync("/tmp/libi-clis-");
    made.push(callerClis);
    fs.writeFileSync(path.join(callerClis, "claude"), "#!/bin/sh\n");
    process.env.LIBI_TEST_AGENT_CLI_DIRS = callerClis;
    process.env.LIBI_E2E_PORT = await closedPort();
    process.env.LIBI_E2E_PORTS_CHECKED = `${process.env.LIBI_E2E_PORT},${Number(process.env.LIBI_E2E_PORT) + 1}`;
    for (const k of ["LIBI_E2E_HOME", "LIBI_E2E_USER_HOME", "LIBI_FAKE_ZERNIO_CONFIG"]) delete process.env[k];
    vi.resetModules();
    await import("../../../playwright.config");
    const home = process.env.LIBI_E2E_HOME!;
    made.push(home);
    const claim = JSON.parse(process.env.LIBI_E2E_OWNED_SCRATCH!) as { paths: string[] };
    expect(claim.paths).toEqual([home]);
    const { scheduleScratchCleanup } = await import("../../../e2e/support/harness");
    scheduleScratchCleanup();
    expect(await gone(home)).toBe(true);
    await settle();
    expect(fs.existsSync(path.join(callerClis, "claude"))).toBe(true);
  }, 30_000);

  it("an existing dir at a derived path (not created by this run) is never claimed", async () => {
    const { createDirIfAbsent } = await import("../../../e2e/support/harness");
    const existing = fs.mkdtempSync(path.join(os.tmpdir(), "libi-existing-"));
    made.push(existing);
    expect(createDirIfAbsent(existing)).toBe(false);
    const fresh = `${existing}-fresh`;
    made.push(fresh);
    expect(createDirIfAbsent(fresh)).toBe(true);
  });
});
