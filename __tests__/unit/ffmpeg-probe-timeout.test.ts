/**
 * Important 1 (pre-merge findings): `probeMedia` runs on the BOOT path — the
 * has_alpha backfill sweep awaits it serially for every un-backfilled video
 * row, and the 720p regen sweep is sequenced after that sweep. One ffprobe
 * hung on a stalled network mount would therefore stall boot maintenance
 * forever. The exec MUST carry a timeout that kills the child, and a timeout
 * must surface as an ordinary probe failure (`{}` — "unknown"), which every
 * caller already handles by skipping, never deleting.
 */
import { describe, it, expect, vi } from "vitest";

let lastOptions: Record<string, unknown> | undefined;
let behavior: "ok" | "timeout" = "ok";

vi.mock("child_process", () => ({
  execFile: (...callArgs: unknown[]) => {
    // Real call shape: execFile(cmd, args, options, cb) — promisify appends
    // the callback last; the options object sits right before it.
    const cb = callArgs[callArgs.length - 1] as (
      err: Error | null,
      out: { stdout: string; stderr: string },
    ) => void;
    lastOptions =
      typeof callArgs[callArgs.length - 2] === "object"
        ? (callArgs[callArgs.length - 2] as Record<string, unknown>)
        : undefined;
    if (behavior === "timeout") {
      // Node's execFile timeout kills the child and errors the callback.
      cb(Object.assign(new Error("spawn killed"), { killed: true }), {
        stdout: "",
        stderr: "",
      });
      return;
    }
    cb(null, {
      stdout: JSON.stringify({ format: { duration: "1.0" }, streams: [] }),
      stderr: "",
    });
  },
}));

import { probeMedia } from "@/lib/ffmpeg/probe";

describe("probeMedia timeout", () => {
  it("passes a bounded timeout + SIGKILL to execFile (boot-sweep hang guard)", async () => {
    behavior = "ok";
    await probeMedia("/tmp/whatever.mp4");
    expect(lastOptions).toBeDefined();
    expect(typeof lastOptions?.timeout).toBe("number");
    expect(lastOptions?.timeout as number).toBeGreaterThan(0);
    expect(lastOptions?.timeout as number).toBeLessThanOrEqual(60_000);
    expect(lastOptions?.killSignal).toBe("SIGKILL");
  });

  it("surfaces a timeout as an ordinary probe failure ({} — skip, never delete)", async () => {
    behavior = "timeout";
    await expect(probeMedia("/mnt/stalled/clip.mp4")).resolves.toEqual({});
  });
});
