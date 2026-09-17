import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createTestDb } from "../../../helpers/test-db";
import { mcpServers } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";

// A custom installer may shell out to a STANDARD dep of the same def:
// `yt-dlp` (custom, `uv tool install`) needs `uv` (standard, a raw download)
// on `youtube-download`, and `tracking-pyenv` needs `uv` on
// `libi-tracking` — both defs declare it (the second describe below pins
// that). Until 2026-09-08 `uv` was flagged tier-1 and so was on disk from
// Category A before any custom installer ran; with that flag gone,
// `ensureMcp` itself must install the standard deps of a def BEFORE its
// custom ones, or the first on-demand install of youtube-download dies with
// "uv not found" on any machine without a system uv. The loop order covers
// everything that installs through `ensureMcp`; the tracking_engine_install
// job (lib/jobs/runners/tracking-engine-install.ts) bypasses that loop by
// calling `retryDep` on the pyenv dep directly, so it `ensureDep`s uv
// explicitly first — its own runner test pins that.

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));

vi.mock("@/mcp/registry/bundled", () => ({
  BUNDLED_MCP_SERVERS: [
    {
      id: "order-test",
      name: "Order Test",
      description: "test",
      npmUrl: null,
      type: "stdio",
      command: "",
      args: [],
      requireApproval: false,
      installFlow: "tier-2",
      dependencies: [
        // Declared FIRST on purpose: the order that matters is the install
        // loop's, not the declaration's.
        {
          binary: "needs-stdbin",
          customInstallerId: "order-test-needs-stdbin",
        },
        {
          binary: "stdbin",
          requireBundled: true,
          pinnedInstallToken: "2026-09-08",
          downloadUrl: {
            darwin: "https://x/stdbin",
            linux: "https://x/stdbin",
            win32: "https://x/stdbin",
          },
        },
      ],
    },
  ],
}));

// The custom installer spawns a real child (this very node binary) that
// records whether the standard dep's binary existed at install time. Paths
// travel through env vars because vi.mock factories are hoisted above the
// per-test temp dir.
vi.mock("@/mcp/registry/installers", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/mcp/registry/installers")>();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require("node:fs") as typeof import("node:fs");
  const script =
    'const fs = require("node:fs");' +
    'fs.writeFileSync(process.env.ORDER_TEST_MARKER, ' +
    'fs.existsSync(process.env.ORDER_TEST_STDBIN) ? "present" : "missing");';
  return {
    ...actual,
    getCustomInstaller: (id: string) =>
      id === "order-test-needs-stdbin"
        ? {
            verify: async () => {
              const marker = process.env.ORDER_TEST_MARKER!;
              return nodeFs.existsSync(marker) ? marker : null;
            },
            install: { command: process.execPath, args: ["-e", script] },
          }
        : actual.getCustomInstaller(id),
  };
});

// Block PATH lookups so the temp dir is the sole source of truth.
vi.mock("child_process", async () => {
  const actual = await vi.importActual<typeof import("child_process")>("child_process");
  return {
    ...actual,
    execSync: (cmd: string, opts?: unknown) => {
      if (/^(which|where)\s/.test(cmd)) throw new Error("blocked for test");
      return actual.execSync(cmd, opts as never);
    },
  };
});

import { getDb } from "@/lib/db/client";
import { seedDatabase } from "@/lib/db/init";
import { DependencyManager } from "@/mcp/registry/dependency-manager";

describe("ensureMcp install order — standard deps before custom installers", () => {
  let tmp: string;
  let prevHome: string | undefined;
  let stdbinPath: string;
  let markerPath: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-install-order-"));
    prevHome = process.env.LIBI_HOME;
    process.env.LIBI_HOME = tmp;
    const exe = process.platform === "win32" ? "stdbin.exe" : "stdbin";
    stdbinPath = path.join(tmp, "bin", exe);
    markerPath = path.join(tmp, "needs-stdbin.marker");
    process.env.ORDER_TEST_STDBIN = stdbinPath;
    process.env.ORDER_TEST_MARKER = markerPath;
    const db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    seedDatabase(db as never);
    global.fetch = vi.fn(
      async () => new Response("#!/bin/sh\nexit 0\n", { status: 200 }),
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.LIBI_HOME;
    else process.env.LIBI_HOME = prevHome;
    delete process.env.ORDER_TEST_STDBIN;
    delete process.env.ORDER_TEST_MARKER;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("the custom installer finds the standard dep's binary already on disk", async () => {
    expect(fs.existsSync(stdbinPath)).toBe(false);

    await new DependencyManager().installBundledDeps();

    expect(fs.existsSync(stdbinPath)).toBe(true);
    expect(fs.readFileSync(markerPath, "utf8")).toBe("present");

    const db = vi.mocked(getDb)();
    const row = db.select().from(mcpServers).where(eq(mcpServers.id, "order-test")).all()[0];
    expect(row.installStatus).toBe("installed");
  });
});

// The invariant the loop order above depends on, checked against the REAL
// registry (this file mocks `@/mcp/registry/bundled` for the loop test, so
// the real defs come in through importActual). A custom installer that runs
// uv only benefits from "standard deps before custom installers" when its
// own def actually DECLARES uv; a def that forgets it has no route to uv on a
// fresh machine, and `uvPath()` (lib/tracking/engine-deps.ts) then falls
// back to a bare "uv" that dies ENOENT. That was libi-tracking until
// 2026-09-08: its installer ran `uv sync` and worked only because uv used to
// be installed at boot.
describe("every custom installer that runs uv sits on a def that declares the uv standard dep", () => {
  // Custom installers whose install path shells out to uv. Not derivable
  // from registry data — both hide behind runtime sentinels
  // (`__YT_DLP_UV_INSTALL__`, `__TRACKING_PYENV_INSTALL__`) — so the set is
  // named here, and the last test forces a decision for any new installer.
  const UV_BACKED_CUSTOM_INSTALLERS = new Set(["tracking-pyenv", "yt-dlp-uv"]);
  // playwright-chromium runs playwright-core's CLI under libi's own node —
  // no Python, no uv (`libi-export`).
  const NON_UV_CUSTOM_INSTALLERS = new Set<string>(["playwright-chromium"]);

  const loadRegistry = async () =>
    (await vi.importActual<typeof import("@/mcp/registry/bundled")>("@/mcp/registry/bundled"))
      .STATIC_BUNDLED_MCP_SERVERS;

  it("each def carrying a uv-backed custom installer also declares uv as a plain download dep", async () => {
    const defs = await loadRegistry();
    const carriers = defs.filter((def) =>
      def.dependencies.some(
        (d) => d.customInstallerId && UV_BACKED_CUSTOM_INSTALLERS.has(d.customInstallerId),
      ),
    );
    // Both known carriers must be present, or the assertion below is vacuous.
    expect(carriers.map((d) => d.id).sort()).toEqual(["libi-tracking", "youtube-download"]);
    for (const def of carriers) {
      const uv = def.dependencies.find((d) => d.binary === "uv");
      expect(uv, `${def.id} declares no uv dep`).toBeDefined();
      expect(uv!.customInstallerId, `${def.id}: uv must be a standard dep`).toBeUndefined();
      expect(uv!.files, `${def.id}: uv must be a standard dep`).toBeUndefined();
      expect(uv!.downloadUrl, `${def.id}: uv dep has no downloadUrl`).toBeDefined();
      expect(uv!.pinnedInstallToken, `${def.id}: uv dep has no install token`).toBeTruthy();
    }
  });

  it("every uv dep across the registry is spelled identically, so install-token dedup applies", async () => {
    const defs = await loadRegistry();
    const uvDeps = defs.flatMap((def) =>
      def.dependencies.filter((d) => d.binary === "uv").map((d) => ({ id: def.id, dep: d })),
    );
    expect(uvDeps.length).toBeGreaterThanOrEqual(2);
    const key = (d: (typeof uvDeps)[number]["dep"]) =>
      JSON.stringify({ token: d.pinnedInstallToken, url: d.downloadUrl, archive: d.archive });
    const first = key(uvDeps[0].dep);
    for (const { id, dep } of uvDeps) {
      expect(key(dep), `${id}'s uv dep differs from ${uvDeps[0].id}'s`).toBe(first);
    }
  });

  it("every custom installer in the registry is classified as uv-backed or not", async () => {
    const defs = await loadRegistry();
    const ids = new Set(
      defs.flatMap((def) =>
        def.dependencies.flatMap((d) => (d.customInstallerId ? [d.customInstallerId] : [])),
      ),
    );
    for (const id of ids) {
      expect(
        UV_BACKED_CUSTOM_INSTALLERS.has(id) || NON_UV_CUSTOM_INSTALLERS.has(id),
        `custom installer "${id}" is not classified — add it to one of the two sets above`,
      ).toBe(true);
    }
  });
});
