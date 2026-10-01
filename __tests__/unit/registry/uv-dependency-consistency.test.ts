/**
 * Every extension that needs `uv` declares the SAME uv dependency, and it is
 * one the Settings chip offers to download.
 *
 * 0.1.16 full verification, F6 (FAIL L1b): the Whisper install plan told the
 * agent to have the user "press Download next to `uv`" on the Whisper card,
 * but only the Video download card's uv dep carried `manualInstall: true`. On
 * Whisper (and Kokoro, ACE-Step, tracking) the chip rendered "queued… will
 * start automatically" with no button, nothing ever started, and "Set up with
 * agent" opened a chat that repeated the same instruction — a loop.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BUNDLED_MCP_SERVERS, UV_DEPENDENCY } from "@/mcp/registry/bundled";

// The route reads the live bin folder; point it at an empty one so a uv on
// the developer's machine can't change what the chip is told.
let tempBinDir: string;
vi.mock("@/lib/libi-home", async () => {
  const actual = await vi.importActual<typeof import("@/lib/libi-home")>("@/lib/libi-home");
  return { ...actual, getLibiBinDir: () => tempBinDir };
});
// …and a uv on PATH likewise.
vi.mock("child_process", async () => {
  const actual = await vi.importActual<typeof import("child_process")>("child_process");
  return {
    ...actual,
    execSync: (cmd: string, ...rest: unknown[]) => {
      if (typeof cmd === "string" && /^(which|where)\s/.test(cmd)) throw new Error("not found");
      return (actual.execSync as unknown as (...args: unknown[]) => Buffer)(cmd, ...rest);
    },
  };
});
// yt-dlp and tracking-pyenv (custom installers) read persisted transitions.
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("../../helpers/test-db");
  const db = createTestDb();
  return { getDb: () => db };
});
// The model/env chips are not what this file is about, and inspecting them
// reaches the job manager.
vi.mock("@/lib/mcp-virtual-deps/registry", () => ({
  ensureBootstrapped: () => {},
  getVirtualDepsForMcp: () => [],
}));

import { GET } from "@/app/api/settings/mcp-servers/[id]/dependencies/route";

const defsWithUv = BUNDLED_MCP_SERVERS.filter((d) =>
  d.dependencies.some((dep) => dep.binary === "uv"),
);

describe("the uv dependency", () => {
  it("is declared by every extension that runs something through uv", () => {
    expect(defsWithUv.map((d) => d.id).sort()).toEqual(
      ["libi-tracking", "local-music", "local-tts", "whisper", "youtube-download"].sort(),
    );
  });

  it("is the identical object on every extension that declares it", () => {
    for (const def of defsWithUv) {
      const uv = def.dependencies.find((dep) => dep.binary === "uv");
      expect(uv, def.id).toEqual(UV_DEPENDENCY);
    }
  });

  it("is on-demand (manualInstall), tier-2 and token-pinned", () => {
    expect(UV_DEPENDENCY.manualInstall).toBe(true);
    expect(UV_DEPENDENCY.installFlow).toBe("tier-2");
    expect(UV_DEPENDENCY.pinnedInstallToken).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("GET /api/settings/mcp-servers/whisper/dependencies", () => {
  beforeEach(() => {
    tempBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-uv-dep-"));
  });
  afterEach(() => {
    fs.rmSync(tempBinDir, { recursive: true, force: true });
  });

  it("tells the chip uv is manualInstall, so the card offers Download", async () => {
    const res = await GET(new Request("http://localhost/api/settings/mcp-servers/whisper/dependencies"), {
      params: Promise.resolve({ id: "whisper" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      dependencies: Array<{ binary: string; runtimeStatus?: string; manualInstall?: boolean }>;
    };
    const uv = body.dependencies.find((d) => d.binary === "uv");
    expect(uv).toMatchObject({ runtimeStatus: "pending", manualInstall: true });
  });

  // M-1: the chip's copy is per extension. Whisper, Kokoro and ACE-Step never
  // ensureDep uv (their plans send the user to Download); video download and
  // tracking fetch it inside their jobs.
  it.each([
    ["whisper", true],
    ["local-tts", true],
    ["local-music", true],
    ["youtube-download", false],
    ["libi-tracking", false],
  ])("%s: uv buttonOnly = %s", async (id, buttonOnly) => {
    const res = await GET(new Request(`http://localhost/api/settings/mcp-servers/${id}/dependencies`), {
      params: Promise.resolve({ id }),
    });
    const body = (await res.json()) as { dependencies: Array<{ binary: string; buttonOnly?: boolean }> };
    const uv = body.dependencies.find((d) => d.binary === "uv")!;
    expect(uv.buttonOnly === true).toBe(buttonOnly);
  });
});
