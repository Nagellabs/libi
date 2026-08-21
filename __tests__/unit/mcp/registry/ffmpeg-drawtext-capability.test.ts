import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";
import { DependencyManager } from "@/mcp/registry/dependency-manager";
import type { BundledDependency } from "@/mcp/registry/types";

/**
 * Regression guard for F5 (2026-08-16): every text overlay export on Linux
 * failed with "No such filter: 'drawtext'".
 *
 * The Linux ffmpeg download (johnvansickle) had no `drawtext` filter. It
 * executed perfectly, so `runCheck: ["-version"]` passed it green — and its
 * `-version` output even ADVERTISED `--enable-libfreetype`, so parsing the
 * configuration string would have passed it too. Measured on the shipped
 * artifact: 486 filters, drawtext absent.
 *
 * Two things must hold forever after:
 *   1. the Linux source is one that ships drawtext, and ffmpeg/ffprobe come
 *      from the SAME archive (they are a matched pair);
 *   2. a binary that runs but lacks a required capability does NOT verify
 *      green — otherwise the next bad upstream build repeats this exactly.
 */

const core = BUNDLED_MCP_SERVERS.find((m) => m.core);

function coreDep(binary: string): BundledDependency {
  const dep = core!.dependencies.find((d) => d.binary === binary);
  if (!dep) throw new Error(`core dep ${binary} not found`);
  return dep;
}

describe("ffmpeg declares the capabilities libi actually depends on", () => {
  it("ffmpeg asserts drawtext, not merely that it runs", () => {
    const dep = coreDep("ffmpeg");
    expect(dep.runCheck).toEqual(["-version"]);
    expect(dep.capabilityCheck).toBeDefined();
    expect(dep.capabilityCheck!.mustContain).toContain("drawtext");
    // The probe has to actually list filters — `-version` output never
    // contains the word "drawtext", so probing it would pass vacuously.
    expect(dep.capabilityCheck!.args).toEqual(["-filters"]);
  });

  it("does not use johnvansickle on linux — that build has no drawtext", () => {
    for (const binary of ["ffmpeg", "ffprobe"] as const) {
      const linux = coreDep(binary).downloadUrl?.linux;
      expect(typeof linux).toBe("string");
      expect(linux as string).not.toContain("johnvansickle");
    }
  });

  it("ffmpeg and ffprobe come from the SAME linux archive", () => {
    // Mixing builds would mean probing media with a different ffmpeg than the
    // one encoding it.
    expect(coreDep("ffmpeg").downloadUrl?.linux).toBe(
      coreDep("ffprobe").downloadUrl?.linux,
    );
  });

  it("the linux extraction path matches the archive's actual layout", () => {
    // BtbN nests binaries under bin/; johnvansickle did not. Getting this
    // wrong means the install silently finds no binary.
    expect(coreDep("ffmpeg").archive?.binaryPathInArchive?.linux).toContain("/bin/");
    expect(coreDep("ffprobe").archive?.binaryPathInArchive?.linux).toContain("/bin/");
  });

  it("the install token was bumped so existing broken installs re-fetch", () => {
    // A new URL alone does not help anyone who already has the old binary on
    // disk — resolveStatus would keep reporting it installed.
    for (const binary of ["ffmpeg", "ffprobe"] as const) {
      expect(coreDep(binary).pinnedInstallToken).not.toBe("2026-07-24");
    }
  });
});

describe("a runnable-but-incapable binary does not verify green", () => {
  let dir: string;

  afterEach(() => {
    vi.restoreAllMocks();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A fake "ffmpeg" that runs fine and prints the given filter list. */
  function fakeFfmpeg(filterOutput: string): string {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-cap-"));
    const bin = path.join(dir, "ffmpeg");
    fs.writeFileSync(
      bin,
      `#!/bin/sh\nif [ "$1" = "-filters" ]; then\n  cat <<'EOF'\n${filterOutput}\nEOF\nfi\nexit 0\n`,
    );
    fs.chmodSync(bin, 0o755);
    return bin;
  }

  it("reports the missing capability by name", async () => {
    if (process.platform === "win32") return; // sh shebang
    const bin = fakeFfmpeg(" ... scale   V->V  Scale the input video.");
    // @ts-expect-error — exercising the private probe directly is the point
    const missing = await DependencyManager.missingCapabilities(bin, {
      args: ["-filters"],
      mustContain: ["drawtext"],
    });
    expect(missing).toEqual(["drawtext"]);
  });

  it("passes when the capability is present", async () => {
    if (process.platform === "win32") return;
    const bin = fakeFfmpeg(" TS. drawtext  V->V  Draw text on top of video frames.");
    // @ts-expect-error — private by design
    const missing = await DependencyManager.missingCapabilities(bin, {
      args: ["-filters"],
      mustContain: ["drawtext"],
    });
    expect(missing).toEqual([]);
  });

  it("treats a probe that cannot run as missing EVERYTHING", async () => {
    // A binary that will not answer `-filters` cannot be trusted to have those
    // filters. Assuming success on a failed probe would reinstate the bug.
    // @ts-expect-error — private by design
    const missing = await DependencyManager.missingCapabilities(
      "/nonexistent/ffmpeg",
      { args: ["-filters"], mustContain: ["drawtext", "overlay"] },
    );
    expect(missing).toEqual(["drawtext", "overlay"]);
  });
});
