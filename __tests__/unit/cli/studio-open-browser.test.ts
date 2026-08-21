// The wiring between `startStudio` and the browser handoff: what the terminal
// says, and WHICH handoff runs.
//
// The two boot paths need different handoffs and it matters that they can't be
// swapped: the production server resolves only once OUR listener is up (open
// immediately — no polling, no chance of racing a foreign process that already
// holds the port), while `next dev` is a child process whose readiness can only
// be observed from outside (poll first). The printed URL is asserted here too,
// because it is the fallback the whole feature leans on.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("@/lib/server/lifecycle", () => ({
  runInstallPhase: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/server/lifecycle/adapters/cli", () => ({ cliAdapter: vi.fn(() => ({})) }));
vi.mock("@/lib/install/next-externals", () => ({ ensureNextExternalSymlinks: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(() => ({ on: vi.fn() })),
}));

// A production boot that binds nothing: `next()` and the HTTP listener are the
// only two things standing between this test and a real port.
vi.mock("next", () => ({
  default: () => ({
    getRequestHandler: () => () => {},
    prepare: async () => {},
  }),
}));
vi.mock("node:http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:http")>()),
  createServer: vi.fn(() => ({
    once: vi.fn(),
    off: vi.fn(),
    listen: (_port: number, _host: string, cb: () => void) => cb(),
  })),
}));

const openStudioInBrowser = vi.fn(async () => ({ opened: true }));
const openStudioWhenReady = vi.fn(async () => ({ opened: true }));
vi.mock("@/lib/cli/open-browser", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cli/open-browser")>()),
  openStudioInBrowser: (...args: unknown[]) => openStudioInBrowser(...(args as [])),
  openStudioWhenReady: (...args: unknown[]) => openStudioWhenReady(...(args as [])),
}));

import { startStudio } from "@/lib/cli/studio";

/** An installed package: no `.git`, a `package.json` marker to stop the walk. */
function installedLayout(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "libi-open-installed-"));
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  return path.join(root, "lib", "cli");
}

/** A dev checkout: a `.git` marker at the root. */
function devLayout(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "libi-open-dev-"));
  fs.writeFileSync(path.join(root, ".git"), "");
  return path.join(root, "lib", "cli");
}

describe("startStudio — the browser handoff", () => {
  const originalCwd = process.cwd();
  let printed: string;
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // The decision reads the ambient env; pin the two inputs that would
    // otherwise make this suite behave differently on a CI runner.
    vi.stubEnv("CI", "");
    vi.stubEnv("LIBI_OPEN", "");
    printed = "";
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
      printed += chunk;
      return true;
    }) as never);
  });

  afterEach(() => {
    writeSpy.mockRestore();
    vi.unstubAllEnvs();
    try {
      process.chdir(originalCwd);
    } catch {
      /* ignore */
    }
  });

  it("opens immediately after the production server is listening, and says so", async () => {
    await startStudio("3456", undefined, { dirname: installedLayout() });

    expect(printed).toContain("[libi] Opening http://localhost:3456 in your browser…");
    // The fallback the user acts on when nothing appears.
    expect(printed).toContain("If it doesn't open by itself, visit http://localhost:3456");
    expect(openStudioInBrowser).toHaveBeenCalledWith("http://localhost:3456");
    expect(openStudioWhenReady).not.toHaveBeenCalled();
  });

  it("prints the bare URL and launches nothing under --no-open", async () => {
    await startStudio("3456", undefined, { dirname: installedLayout(), open: false });

    expect(printed).toContain("[libi] Open http://localhost:3456");
    expect(printed).not.toContain("Opening http://localhost:3456");
    expect(openStudioInBrowser).not.toHaveBeenCalled();
    expect(openStudioWhenReady).not.toHaveBeenCalled();
  });

  it("leaves a dev checkout alone by default", async () => {
    await startStudio("3456", undefined, { dirname: devLayout() });

    expect(printed).toContain("[libi] Open http://localhost:3456");
    expect(openStudioInBrowser).not.toHaveBeenCalled();
    expect(openStudioWhenReady).not.toHaveBeenCalled();
  });

  it("waits for `next dev` to answer when a dev checkout opts in with --open", async () => {
    await startStudio("3456", undefined, { dirname: devLayout(), open: true });

    expect(openStudioWhenReady).toHaveBeenCalledWith("http://localhost:3456");
    // Never the immediate opener: the child hasn't compiled anything yet.
    expect(openStudioInBrowser).not.toHaveBeenCalled();
  });

  it("stays headless for --connect-agent, which is serving someone else's CLI", async () => {
    await startStudio("3456", "/tmp/some-project", { dirname: installedLayout() });

    expect(printed).toContain("connect-agent mode");
    expect(openStudioInBrowser).not.toHaveBeenCalled();
    expect(openStudioWhenReady).not.toHaveBeenCalled();
  });
});
