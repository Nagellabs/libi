/**
 * `probeMediaWithFfprobe` returns `hasAudio` based on the presence of
 * an audio stream in ffprobe's JSON. Verified by mocking the exec call.
 */
import { describe, it, expect, vi } from "vitest";
import { __probeMediaForTests } from "@/mcp/tools/file-tools";

vi.mock("node:child_process", () => ({
  // Variadic: probeMedia calls execFile(cmd, args, options, cb) — the
  // callback is always LAST.
  execFile: (...callArgs: unknown[]) => {
    const cb = callArgs[callArgs.length - 1] as (
      err: Error | null,
      out: { stdout: string; stderr: string },
    ) => void;
    cb(null, {
      stdout: JSON.stringify({
        format: { duration: "12.34" },
        streams: [
          { codec_type: "video", width: 1920, height: 1080 },
          { codec_type: "audio" },
        ],
      }),
      stderr: "",
    });
  },
}));

vi.mock("@/lib/ffmpeg/exec", () => ({
  resolveFfprobePath: () => "/usr/bin/ffprobe",
}));

describe("probeMediaWithFfprobe", () => {
  it("reports hasAudio: true when an audio stream is present", async () => {
    const result = await __probeMediaForTests("/fake/path.mp4");
    expect(result.hasAudio).toBe(true);
    expect(result.duration).toBeCloseTo(12.34);
    expect(result.width).toBe(1920);
  });
});
