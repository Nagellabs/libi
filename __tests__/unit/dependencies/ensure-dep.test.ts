import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createTestDb } from "../../helpers/test-db";
import { mcpServers } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";

// `ensureDep` is the on-demand entry point (the tracker calls it before every
// Chromium launch). Unlike `retryDep` — the Settings "Retry" button, which
// always re-installs — it must be a no-op when the dep is already on disk:
// no download, no `runtimeStatus: "installing"` transition. Before it
// existed the tracker went through `retryDep`, which re-fetched all 33 MB of
// MediaPipe assets on every tracker start and failed outright offline.

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
const trackServerEvent = vi.fn();
vi.mock("@/lib/analytics/server", () => ({
  trackServerEvent: (name: string, params?: Record<string, unknown>) => trackServerEvent(name, params),
}));

const { BODY_A, BODY_B, SHA_A, SHA_B } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const c = require("node:crypto") as typeof import("node:crypto");
  const BODY_A = "alpha-model-bytes";
  const BODY_B = "beta-wasm-bytes";
  return {
    BODY_A,
    BODY_B,
    SHA_A: c.createHash("sha256").update(BODY_A).digest("hex"),
    SHA_B: c.createHash("sha256").update(BODY_B).digest("hex"),
  };
});
const TOKEN = "2026-09-08";
const STD_TOKEN = "std-2026-09-08";

vi.mock("@/mcp/registry/bundled", () => ({
  BUNDLED_MCP_SERVERS: [
    {
      id: "fake-tracking",
      name: "Fake Tracking",
      description: "test",
      npmUrl: null,
      type: "stdio",
      command: "",
      args: [],
      requireApproval: false,
      installFlow: "tier-2",
      dependencies: [
        {
          binary: "fake-vision",
          destination: "models",
          pinnedInstallToken: "2026-09-08",
          files: [
            {
              url: "https://x/a.bin",
              relPath: "models/a.bin",
              sha256: SHA_A,
            },
            {
              url: "https://x/b.bin",
              relPath: "wasm/b.bin",
              sha256: SHA_B,
            },
          ],
        },
        {
          binary: "fake-std",
          requireBundled: true,
          pinnedInstallToken: "std-2026-09-08",
          downloadUrl: {
            darwin: "https://x/fake-std",
            linux: "https://x/fake-std",
            win32: "https://x/fake-std",
          },
        },
        {
          binary: "fake-custom",
          customInstallerId: "fake-custom-installer",
        },
      ],
    },
  ],
}));

const customInstall = vi.fn();
vi.mock("@/mcp/registry/installers", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/mcp/registry/installers")>();
  return {
    ...actual,
    getCustomInstaller: (id: string) =>
      id === "fake-custom-installer"
        ? {
            verify: async () => "/already/installed/fake-custom",
            // Never reached when verify() reports installed; if it is, the
            // test fails on the spy below rather than spawning anything.
            install: { command: "__NEVER_RUN__", args: [] },
          }
        : actual.getCustomInstaller(id),
  };
});

// Block PATH lookups so the filesystem is the sole source of truth.
vi.mock("child_process", async () => {
  const actual = await vi.importActual<typeof import("child_process")>("child_process");
  return {
    ...actual,
    execSync: (cmd: string, opts?: unknown) => {
      if (/^(which|where)\s/.test(cmd)) throw new Error("blocked for test");
      return actual.execSync(cmd, opts as never);
    },
    execFile: (...args: unknown[]) => {
      customInstall(args);
      const cb = args[args.length - 1];
      if (typeof cb === "function") (cb as (e: Error | null) => void)(null);
    },
  };
});

import { getDb } from "@/lib/db/client";
import { BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";
import { seedDatabase } from "@/lib/db/init";
import { DependencyManager } from "@/mcp/registry/dependency-manager";

const visionDep = BUNDLED_MCP_SERVERS[0].dependencies[0];

type Transition = { runtimeStatus?: string; error?: string | null };

function depStatus(binary: string): Transition | undefined {
  const db = vi.mocked(getDb)();
  const row = db.select().from(mcpServers).where(eq(mcpServers.id, "fake-tracking")).all()[0];
  const list = JSON.parse(row.dependencyStatus ?? "[]") as Array<Transition & { binary: string }>;
  return list.find((e) => e.binary === binary);
}

describe("DependencyManager.ensureDep", () => {
  let tmp: string;
  let prevHome: string | undefined;
  let visionDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-ensure-dep-"));
    prevHome = process.env.LIBI_HOME;
    process.env.LIBI_HOME = tmp;
    visionDir = path.join(tmp, "models", "fake-vision");
    const db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    seedDatabase(db as never);
    global.fetch = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/a.bin")) return new Response(BODY_A, { status: 200 });
      if (u.endsWith("/b.bin")) return new Response(BODY_B, { status: 200 });
      return new Response("std-binary-bytes", { status: 200 });
    }) as unknown as typeof fetch;
    customInstall.mockClear();
    trackServerEvent.mockClear();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.LIBI_HOME;
    else process.env.LIBI_HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function writeInstalledVisionAssets(): void {
    fs.mkdirSync(path.join(visionDir, "models"), { recursive: true });
    fs.mkdirSync(path.join(visionDir, "wasm"), { recursive: true });
    fs.writeFileSync(path.join(visionDir, "models", "a.bin"), BODY_A);
    fs.writeFileSync(path.join(visionDir, "wasm", "b.bin"), BODY_B);
    fs.writeFileSync(path.join(visionDir, ".install-token"), TOKEN);
  }

  it("multi-file dep with every file present and sha256-matching: no download, no status transition", async () => {
    writeInstalledVisionAssets();
    for (const f of visionDep.files!) {
      const onDisk = crypto
        .createHash("sha256")
        .update(fs.readFileSync(path.join(visionDir, f.relPath)))
        .digest("hex");
      expect(onDisk).toBe(f.sha256);
    }
    const before = depStatus("fake-vision");

    await new DependencyManager().ensureDep("fake-tracking", "fake-vision");

    expect(global.fetch).not.toHaveBeenCalled();
    expect(depStatus("fake-vision")).toEqual(before);
    // Nothing was installed, so nothing is counted as installed.
    expect(trackServerEvent).not.toHaveBeenCalled();
  });

  it("multi-file dep with assets missing: downloads once and lands on runtimeStatus installed", async () => {
    await new DependencyManager().ensureDep("fake-tracking", "fake-vision");

    expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(path.join(visionDir, "models", "a.bin"), "utf8")).toBe(BODY_A);
    expect(fs.readFileSync(path.join(visionDir, ".install-token"), "utf8")).toBe(TOKEN);
    expect(depStatus("fake-vision")?.runtimeStatus).toBe("installed");
    // Counted once, after the install was VERIFIED, with the registry's own
    // ids and nothing else (no URL, no path, no size).
    expect(trackServerEvent.mock.calls).toEqual([["dependency_installed", { extension: "fake-tracking", dep: "fake-vision" }]]);

    // And the very next call is the no-op path.
    vi.mocked(global.fetch).mockClear();
    trackServerEvent.mockClear();
    await new DependencyManager().ensureDep("fake-tracking", "fake-vision");
    expect(global.fetch).not.toHaveBeenCalled();
    expect(trackServerEvent).not.toHaveBeenCalled();
  });

  it("token-bearing standard dep already in bin/ with a matching token: no download", async () => {
    const binDir = path.join(tmp, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const exe = process.platform === "win32" ? "fake-std.exe" : "fake-std";
    fs.writeFileSync(path.join(binDir, exe), "std-binary-bytes");
    fs.writeFileSync(path.join(binDir, `${exe}.install-token`), STD_TOKEN);

    await new DependencyManager().ensureDep("fake-tracking", "fake-std");

    expect(global.fetch).not.toHaveBeenCalled();
    expect(depStatus("fake-std")).toBeUndefined();
  });

  it("custom-installer dep whose verify() reports installed: installer never runs", async () => {
    await new DependencyManager().ensureDep("fake-tracking", "fake-custom");

    expect(customInstall).not.toHaveBeenCalled();
    expect(depStatus("fake-custom")).toBeUndefined();
  });

  it("rejects an unknown mcpId / binary like retryDep does", async () => {
    const mgr = new DependencyManager();
    await expect(mgr.ensureDep("nope", "fake-vision")).rejects.toThrow(/No bundled MCP/);
    await expect(mgr.ensureDep("fake-tracking", "nope")).rejects.toThrow(/No dep/);
  });
});
