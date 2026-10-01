/**
 * EL-5 (Windows verification F7): the CLI studio (`node bin/libi.js`, i.e.
 * `npx @nagellabs/libi`) writes server.log like the desktop one.
 *
 * `server.log` is next-logger's file. The packaged path loads next-logger
 * before constructing Next (lib/server/next-server.ts); the CLI's production
 * server (`lib/cli/studio.ts#runProductionServer`) did not, so only
 * `instrumentation.ts#register()` loaded it — after Next's own startup output,
 * which went to stdout. Reproduced on macOS with the published 0.1.16
 * (fresh LIBI_HOME, `--no-open`, requests served): server.log 0 bytes, and the
 * `@sentry/nextjs` "withSentryConfig … deprecated" warning on stdout.
 *
 * What is under test: on the production path, next-logger is imported BEFORE
 * `next({...})` is called, and a next-logger that fails to load does not stop
 * the server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const h = vi.hoisted(() => ({ order: [] as string[] }));
vi.mock("next-logger", () => {
  h.order.push("next-logger");
  return {};
});
vi.mock("next", () => ({
  default: () => {
    h.order.push("next()");
    return { getRequestHandler: () => () => {}, prepare: async () => {} };
  },
}));
vi.mock("@/lib/install/next-externals", () => ({
  ensureNextExternalSymlinks: vi.fn(() => ({ created: [], verified: [] })),
}));
vi.mock("node:http", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:http")>();
  const createServer = (() => ({ once: vi.fn(), off: vi.fn(), listen: (_p: number, _h: string, cb: () => void) => cb() })) as unknown as typeof real.createServer;
  return { ...real, default: { ...real, createServer }, createServer };
});
vi.mock("@/lib/server/lifecycle", () => ({ runInstallPhase: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/server/lifecycle/adapters/cli", () => ({ cliAdapter: vi.fn(() => ({})) }));
vi.mock("@/lib/runtime/node-runtime", () => ({ resolveNodeCommand: () => "/fake/libi/bin/node" }));
vi.mock("@/lib/cli/open-browser", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cli/open-browser")>()),
  openStudioInBrowser: vi.fn(async () => ({ opened: true })),
  openStudioWhenReady: vi.fn(async () => ({ opened: true })),
}));

const originalCwd = process.cwd();
let stdout: ReturnType<typeof vi.spyOn>;
let stderr: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  h.order.length = 0;
  vi.resetModules();
  vi.stubEnv("PORT", "");
  vi.stubEnv("LIBI_PORT", "");
  vi.stubEnv("CI", "");
  vi.stubEnv("LIBI_OPEN", "");
  stdout = vi.spyOn(process.stdout, "write").mockImplementation((() => true) as never);
  stderr = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
});
afterEach(() => {
  stdout.mockRestore();
  stderr.mockRestore();
  vi.unstubAllEnvs();
  try {
    process.chdir(originalCwd);
  } catch {
    /* ignore */
  }
});

/** A published-package root (no .git): startStudio takes the production path. */
async function bootProduction(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "libi-el5-"));
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  const { startStudio } = await import("@/lib/cli/studio");
  await startStudio("3493", { dirname: path.join(root, "lib", "cli"), open: false });
}

describe("CLI production server and server.log", () => {
  it("loads next-logger BEFORE Next is constructed", async () => {
    await bootProduction();
    expect(h.order).toEqual(["next-logger", "next()"]);
  });

  it("a next-logger that fails to load is said on stderr and the server still starts", async () => {
    vi.doMock("next-logger", () => {
      h.order.push("next-logger");
      throw new Error("next-logger exploded");
    });
    await bootProduction();
    expect(h.order).toEqual(["next-logger", "next()"]);
    const said = stderr.mock.calls.map((call: unknown[]) => String(call[0])).join("");
    // (vitest wraps a throwing mock factory in its own error; the reason is appended after the colon)
    expect(said).toMatch(/\[libi\] next-logger failed to load — server\.log will not be written: \S/);
  });
});
