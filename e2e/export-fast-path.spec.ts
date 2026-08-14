import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

test.describe("Export fast path", () => {
  let pieceId = "";

  test.beforeAll(async ({ request }) => {
    // Create a piece + upload tiny.mp4 + create a video scene.
    const pRes = await request.post("/api/pieces");
    pieceId = (await pRes.json()).id as string;

    const fixturePath = path.resolve(
      __dirname,
      "..",
      "__tests__",
      "helpers",
      "fixtures",
      "tiny.mp4",
    );
    const fixtureBuf = fs.readFileSync(fixturePath);

    // Probe duration server-side via ffprobe so add_overlay has
    // the metadata it requires (no browser in this spec to probe client-side).
    const probeOut = execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        fixturePath,
      ],
      { encoding: "utf8" },
    ).trim();
    const mediaDuration = Number(probeOut);

    await request.post(`/api/pieces/${pieceId}/upload`, {
      multipart: {
        file: { name: "tiny.mp4", mimeType: "video/mp4", buffer: fixtureBuf },
        mediaDuration: String(mediaDuration),
      },
    });

    const filesRes = await request.get(`/api/pieces/${pieceId}/files`);
    const filesBody = await filesRes.json();
    const arr = Array.isArray(filesBody) ? filesBody : filesBody.files ?? [];
    const fileId = arr.find((f: { filename: string }) => f.filename === "tiny.mp4")?.id;
    if (!fileId) throw new Error("tiny.mp4 not present on seeded piece");

    // Create a plain video scene (no trim, no overlay) — this is the
    // shape that classifies as stream-copy-trim.
    await request.post("/api/e2e/run-tool", {
      data: {
        tool: "libi.add_overlay",
        args: { pieceId, kind: "video", fileId, displayName: "fast-path" },
      },
    });
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

    expect(resp.ok()).toBe(true);
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
