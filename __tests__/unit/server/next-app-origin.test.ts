/**
 * Both production servers tell Next the port and loopback hostname they serve
 * on (SOC-3).
 *
 * `next({...})` under a custom server binds nothing; its `port` / `hostname`
 * are what Next synthesizes every route handler's `request.url` (and
 * `nextUrl`, `x-forwarded-port`) from, and with neither given it synthesizes
 * `http://localhost:3000/...` whatever socket the request came in on. That is
 * how Social's "Connect libi" sent Zernio's callback to `127.0.0.1:3000` on
 * the packaged app and under npx. The start route no longer reads its port off
 * `request.url` (oauth-start-real-port.test.ts); this pins the second half, so
 * no other route can inherit the phantom port.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const nextOptions = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("next", () => ({
  default: (opts: Record<string, unknown>) => {
    nextOptions.push(opts);
    return { getRequestHandler: () => () => {}, prepare: async () => {} };
  },
}));
vi.mock("next-logger", () => ({}));
vi.mock("@/lib/install/next-externals", () => ({
  ensureNextExternalSymlinks: vi.fn(() => ({ created: [], verified: [] })),
}));
// The npx branch of startStudio fires these unconditionally (installed, not-dev-checkout):
// unmocked, `maybePrintUpdateNotice` makes a real request to registry.npmjs.org and
// `setRelaunchHandler` installs a real `process.exit(75)` handler in this worker.
vi.mock("@/lib/cli/update-notice", () => ({ maybePrintUpdateNotice: vi.fn(async () => {}) }));
vi.mock("@/lib/server/lifecycle/relaunch", () => ({ setRelaunchHandler: vi.fn() }));

// The npx case must bind nothing; the packaged case binds a real ephemeral
// port, because that bound port IS what is under test there.
const stubListen = vi.hoisted(() => ({ on: false }));
vi.mock("node:http", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:http")>();
  const createServer = ((...args: Parameters<typeof real.createServer>) =>
    stubListen.on
      ? { once: vi.fn(), off: vi.fn(), listen: (_p: number, _h: string, cb: () => void) => cb() }
      : real.createServer(...args)) as typeof real.createServer;
  return { ...real, default: { ...real, createServer }, createServer };
});

// startStudio's surroundings — the same stubs as studio-open-browser.test.ts.
vi.mock("@/lib/server/lifecycle", () => ({ runInstallPhase: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/server/lifecycle/adapters/cli", () => ({ cliAdapter: vi.fn(() => ({})) }));
vi.mock("@/lib/runtime/node-runtime", () => ({ resolveNodeCommand: () => "/fake/libi/bin/node" }));
vi.mock("@/lib/cli/open-browser", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cli/open-browser")>()),
  openStudioInBrowser: vi.fn(async () => ({ opened: true })),
  openStudioWhenReady: vi.fn(async () => ({ opened: true })),
}));

import { startNextServer } from "@/lib/server/next-server";

describe("next({...}) is told the real port and a loopback hostname", () => {
  const originalCwd = process.cwd();

  beforeEach(() => {
    nextOptions.length = 0;
    // Both servers write these into the environment; stubbing records the
    // originals so `unstubAllEnvs` puts them back.
    vi.stubEnv("PORT", "");
    vi.stubEnv("LIBI_PORT", "");
    vi.stubEnv("CI", "");
    vi.stubEnv("LIBI_OPEN", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    try { process.chdir(originalCwd); } catch { /* ignore */ }
  });

  it("packaged: the ephemeral port it actually bound", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-next-origin-"));
    const { port, server } = await startNextServer({ dir });
    try {
      expect(port).toBeGreaterThan(0);
      expect(port).not.toBe(3000);
      expect(nextOptions).toHaveLength(1);
      expect(nextOptions[0]).toMatchObject({ dev: false, dir, port, hostname: "127.0.0.1" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("npx: the port it was asked to serve on", async () => {
    stubListen.on = true;
    const write = vi.spyOn(process.stdout, "write").mockImplementation((() => true) as never);
    try {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "libi-next-origin-npx-"));
      fs.writeFileSync(path.join(root, "package.json"), "{}");
      const { startStudio } = await import("@/lib/cli/studio");
      await startStudio("3491", { dirname: path.join(root, "lib", "cli"), open: false });
      expect(nextOptions).toHaveLength(1);
      expect(nextOptions[0]).toMatchObject({ dev: false, port: 3491, hostname: "127.0.0.1" });
    } finally {
      stubListen.on = false;
      write.mockRestore();
    }
  });
});
