/**
 * Integration: GET /api/settings/mcp-servers/[id]/dependencies
 *
 * Returns the live per-binary status for a bundled MCP. We mock both the
 * binary-on-PATH check and the ~/.libi/bin filesystem to exercise the
 * three states (system / bundled / missing) without touching the real
 * environment.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";

/**
 * The ffmpeg `BundledDependency` on the core `libi` def, read from the live
 * registry.
 *
 * Deliberately THROWS rather than returning undefined: if ffmpeg is ever
 * renamed or moved off the core def, this test must fail loudly on the lookup
 * instead of quietly writing an empty token and asserting against whatever
 * `resolveStatus` happens to return. A test that can silently stop testing the
 * thing it names is worse than no test.
 */
function ffmpegDependency() {
  const libi = BUNDLED_MCP_SERVERS.find((m) => m.id === "libi");
  if (!libi) throw new Error("no bundled MCP def with id 'libi' — registry changed?");
  const dep = libi.dependencies?.find((d) => d.binary === "ffmpeg");
  if (!dep) {
    throw new Error(
      "the core 'libi' def declares no ffmpeg dependency — registry changed? " +
        `Found: ${(libi.dependencies ?? []).map((d) => d.binary).join(", ") || "(none)"}`,
    );
  }
  return dep;
}

let tempBinDir: string;
vi.mock("@/lib/libi-home", async () => {
  const actual = await vi.importActual<typeof import("@/lib/libi-home")>(
    "@/lib/libi-home",
  );
  return {
    ...actual,
    getLibiBinDir: () => tempBinDir,
  };
});

// Mock `which`/`where` so the test is not affected by tools installed on the
// developer's PATH (e.g. a system-wide ffmpeg). This forces resolveStatus to
// fall through to the ~/.libi/bin filesystem check, which is what we want to
// exercise.
vi.mock("child_process", async () => {
  const actual = await vi.importActual<typeof import("child_process")>("child_process");
  return {
    ...actual,
    execSync: (cmd: string, ...rest: unknown[]) => {
      if (typeof cmd === "string" && /^(which|where)\s/.test(cmd)) {
        throw new Error("not found");
      }
      return (actual.execSync as unknown as (...args: unknown[]) => Buffer)(
        cmd,
        ...rest,
      );
    },
  };
});

import { GET } from "@/app/api/settings/mcp-servers/[id]/dependencies/route";

function req(id: string): Request {
  return new Request(`http://localhost/api/settings/mcp-servers/${id}/dependencies`);
}

describe("GET /api/settings/mcp-servers/[id]/dependencies", () => {
  beforeEach(() => {
    tempBinDir = createTempStorageDir();
  });

  afterEach(() => {
    cleanupTempDir(tempBinDir);
  });

  it("reports 'bundled' for a binary present in ~/.libi/bin/", async () => {
    const binName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
    // A REAL, EXECUTABLE stub — not the 1-byte `Buffer.from([0])` this used to
    // write. ffmpeg's dep declares `runCheck: ["-version"]`, and `resolveStatus`
    // honours it by actually EXECUTING the binary (see dependency-manager.ts:
    // "an existing binary that can't run (wrong CPU arch) is treated as
    // not-installed"). A one-byte file fails with ENOEXEC, so the status was
    // correctly downgraded to installed:false and the test failed with a bare
    // `expected false to be true` that read like a product regression.
    //
    // It must also ANSWER `-filters` with drawtext. ffmpeg now declares a
    // `capabilityCheck` (F5, 2026-08-16: the Linux build ran fine but had no
    // drawtext, so every text-overlay export failed), and a stub that merely
    // exits 0 is exactly the "runs but cannot do the job" case that check
    // exists to reject — it would fail here in precisely the same misleading
    // way as the ENOEXEC stub above.
    fs.writeFileSync(
      path.join(tempBinDir, binName),
      process.platform === "win32"
        ? '@echo off\r\nif "%1"=="-filters" echo  TS. drawtext V->V Draw text on top of video frames.\r\nexit 0\r\n'
        : '#!/bin/sh\ncase "$1" in -filters) echo " TS. drawtext V->V Draw text on top of video frames." ;; esac\nexit 0\n',
      { mode: 0o755 },
    );
    // `resolveStatus` only reports installed once the on-disk marker matches
    // the dep's declared `pinnedInstallToken`, so this test has to write a
    // matching marker.
    //
    // Read that token FROM THE REGISTRY rather than hardcoding it. Bumping a
    // pinnedInstallToken is a routine, documented operation (see CLAUDE.md —
    // it is the force-re-fetch lever for binaries whose download URL is a
    // "latest" alias), and a hardcoded copy silently rots the moment anyone
    // uses it: this test asserted "2026-05-23" while ffmpeg had long since
    // moved to "2026-07-24", so it failed with a bare `expected false to be
    // true` that looked like a product regression rather than a stale
    // fixture. Deriving it means a future bump can never break this test.
    const ffmpegDep = ffmpegDependency();
    fs.writeFileSync(
      path.join(tempBinDir, `${binName}.install-token`),
      ffmpegDep.pinnedInstallToken ?? "",
    );

    const res = await GET(req("libi"), { params: Promise.resolve({ id: "libi" }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      dependencies: Array<{ binary: string; installed: boolean; source: string | null }>;
    };
    const ffmpeg = body.dependencies.find((d) => d.binary === "ffmpeg");
    expect(ffmpeg).toBeDefined();
    expect(ffmpeg?.installed).toBe(true);
    expect(ffmpeg?.source).toBe("bundled");
  });

  it("returns installed: true or false depending on actual presence (shape check)", async () => {
    const res = await GET(req("libi"), { params: Promise.resolve({ id: "libi" }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      dependencies: Array<{ binary: string; installed: boolean }>;
    };
    const ffprobe = body.dependencies.find((d) => d.binary === "ffprobe");
    expect(ffprobe).toBeDefined();
    expect(typeof ffprobe?.installed).toBe("boolean");
  });

  it("returns an empty list for an unknown MCP id", async () => {
    const res = await GET(req("does-not-exist"), {
      params: Promise.resolve({ id: "does-not-exist" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dependencies: unknown[] };
    expect(body.dependencies).toEqual([]);
  });
});
