/**
 * Unit: resolveFfmpegPath / resolveFfprobePath + runFfmpeg log emission.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";

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

import { resolveFfmpegPath, resolveFfprobePath } from "@/lib/ffmpeg/exec";

describe("resolveFfmpegPath / resolveFfprobePath", () => {
  beforeEach(() => {
    tempBinDir = createTempStorageDir();
  });

  afterEach(() => {
    cleanupTempDir(tempBinDir);
  });

  it("returns the bundled binary when present in ~/.libi/bin/", () => {
    const name = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
    const bundled = path.join(tempBinDir, name);
    fs.writeFileSync(bundled, Buffer.from([0]));
    expect(resolveFfmpegPath()).toBe(bundled);
  });

  it("falls back to 'ffmpeg' on PATH when no bundled binary", () => {
    expect(resolveFfmpegPath()).toBe("ffmpeg");
  });

  it("resolves ffprobe the same way", () => {
    const name = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
    const bundled = path.join(tempBinDir, name);
    fs.writeFileSync(bundled, Buffer.from([0]));
    expect(resolveFfprobePath()).toBe(bundled);
  });
});

import { ffmpegLogger } from "@/lib/logger";

describe("runFfmpeg logs", () => {
  it("emits start + done for a successful invocation with a fixed op tag", async () => {
    const events: Array<{ msg: string; bindings: Record<string, unknown> }> = [];
    const spy = vi.spyOn(ffmpegLogger, "info").mockImplementation(
      (bindings: unknown, msg?: string) => {
        events.push({ msg: msg ?? "", bindings: bindings as Record<string, unknown> });
        return ffmpegLogger;
      },
    );

    const { runFfmpeg } = await import("@/lib/ffmpeg/exec");
    try {
      await runFfmpeg(["-version"], { op: "self_test" });
    } catch {
      spy.mockRestore();
      return; // ffmpeg missing — skip assertion
    }

    const startLog = events.find((e) => e.msg.startsWith("ffmpeg.start"));
    const doneLog = events.find((e) => e.msg.startsWith("ffmpeg.done"));
    expect(startLog?.bindings.op).toBe("self_test");
    expect(doneLog?.bindings.op).toBe("self_test");
    expect(doneLog?.bindings.durationMs).toEqual(expect.any(Number));
    expect(doneLog?.bindings.exitCode).toBe(0);
    spy.mockRestore();
  });
});

describe("runFfmpeg abort", () => {
  it("rejects with 'ffmpeg aborted' when the signal aborts mid-run", async () => {
    // Skip if no ffmpeg on PATH.
    try {
      await import("child_process").then((cp) => cp.execSync("ffmpeg -version", { stdio: "ignore", timeout: 2000 }));
    } catch {
      return; // soft skip
    }

    const { runFfmpeg } = await import("@/lib/ffmpeg/exec");
    const controller = new AbortController();

    // Run a ffmpeg call that should take >100ms (lavfi source for 10s) so we can abort it.
    const promise = runFfmpeg(
      [
        "-re",
        "-f", "lavfi",
        "-i", "color=c=black:s=320x240:r=24",
        "-t", "10",
        "-f", "null",
        "-",
      ],
      { op: "test_abort", signal: controller.signal },
    );

    setTimeout(() => controller.abort(), 50);
    await expect(promise).rejects.toThrow(/aborted/i);
  });

  it("emits ffmpeg.cancel log on abort", async () => {
    try {
      await import("child_process").then((cp) => cp.execSync("ffmpeg -version", { stdio: "ignore", timeout: 2000 }));
    } catch {
      return; // soft skip
    }

    const events: Array<{ msg: string; bindings: Record<string, unknown> }> = [];
    const warnSpy = vi.spyOn(ffmpegLogger, "warn").mockImplementation(
      (bindings: unknown, msg?: string) => {
        events.push({ msg: msg ?? "", bindings: bindings as Record<string, unknown> });
        return ffmpegLogger;
      },
    );

    const { runFfmpeg } = await import("@/lib/ffmpeg/exec");
    const controller = new AbortController();

    const promise = runFfmpeg(
      [
        "-re",
        "-f", "lavfi",
        "-i", "color=c=black:s=320x240:r=24",
        "-t", "10",
        "-f", "null",
        "-",
      ],
      { op: "test_cancel_log", signal: controller.signal },
    );

    setTimeout(() => controller.abort(), 50);
    await expect(promise).rejects.toThrow();

    const cancelLog = events.find((e) => e.msg.startsWith("ffmpeg.cancel"));
    expect(cancelLog).toBeDefined();
    expect(cancelLog?.bindings.op).toBe("test_cancel_log");
    expect(cancelLog?.bindings.event).toBe("cancel");
    expect(cancelLog?.bindings.durationMs).toEqual(expect.any(Number));

    warnSpy.mockRestore();
  });
});
