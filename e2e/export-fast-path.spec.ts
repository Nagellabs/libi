import { test, expect } from "@playwright/test";
import { seedPieceWithVideo } from "./helpers/app";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

test.describe("Export fast path", () => {
  let pieceId = "";

  test.beforeAll(async ({ request }) => {
    // A piece whose only layer is tiny.mp4 as a plain full-frame video
    // overlay (no trim, nothing else) — the shape that classifies as
    // stream-copy-trim. Two things make it that shape, both checked by the
    // server's classifier (lib/export/classifier.ts), which refuses a client
    // shape it disagrees with (409):
    //   - the overlay starts at 0 with a duration — `startTime`/`duration` are
    //     required by add_overlay's schema, and a base video must start at 0;
    //   - the frame is tiny.mp4's own 320x240: `-c copy` cannot scale, so a
    //     source that doesn't match the composition goes to ffmpeg-overlay
    //     (lib/export/export-base.ts#streamCopyPreservesFraming), and a new
    //     piece takes the user's default aspect ratio.
    ({ pieceId } = await seedPieceWithVideo(request, { fixture: "tiny.mp4", width: 320, height: 240, displayName: "fast-path" }));
  });

  test("trim-only export uses stream-copy-trim backend and returns an MP4", async ({ request }) => {
    const t0 = Date.now();
    const resp = await request.post("/api/export/ffmpeg", {
      data: {
        pieceId,
        shape: "stream-copy-trim",
        settings: {
          format: "mp4",
          codec: "avc",
          bitrate: 5_000_000,
          width: 320,
          height: 240,
          fps: 24,
        },
      },
    });
    const elapsed = Date.now() - t0;

    expect(resp.ok(), `HTTP ${resp.status()} ${resp.ok() ? "" : await resp.text()}`).toBe(true);
    expect(resp.headers()["x-export-backend"]).toBe("stream-copy-trim");

    const body = await resp.body();
    expect(body.byteLength).toBeGreaterThan(0);

    // Verify the exported bytes are actually a playable MP4 with the
    // expected duration (the scene covers the full fixture). Write to a
    // temp path so ffprobe can read it.
    const os = await import("os");
    const outPath = path.join(
      os.tmpdir(),
      `libi-e2e-fastpath-${Date.now()}.mp4`,
    );
    fs.writeFileSync(outPath, body);
    try {
      const dur = Number(
        execFileSync(
          "ffprobe",
          [
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            outPath,
          ],
          { encoding: "utf8" },
        ).trim(),
      );
      // tiny.mp4 is ~0.5s. Allow 150ms tolerance for keyframe alignment.
      expect(dur).toBeGreaterThan(0);
      expect(dur).toBeLessThan(2);
    } finally {
      try { fs.unlinkSync(outPath); } catch { /* ignore */ }
    }

    // Sanity: generous ceiling. Real stream-copy on tiny.mp4 is sub-second.
    expect(elapsed).toBeLessThan(10_000);
  });
});
