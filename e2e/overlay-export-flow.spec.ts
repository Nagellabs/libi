import { test, expect } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync, execSync } from "child_process";
import { openEditor } from "./helpers/app";

function hasFfmpeg(): boolean {
  try {
    execSync("ffmpeg -version", { stdio: "ignore", timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

interface ProbeStream {
  codec_type: string;
  codec_name: string;
}

interface ProbeOutput {
  format?: { duration?: string };
  streams?: ProbeStream[];
}

function probe(filePath: string): {
  duration: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
} {
  const stdout = execFileSync(
    "ffprobe",
    [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      filePath,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  const parsed = JSON.parse(stdout) as ProbeOutput;
  const streams = parsed.streams ?? [];
  return {
    duration: parsed.format?.duration ? parseFloat(parsed.format.duration) : null,
    hasVideo: streams.some((s) => s.codec_type === "video"),
    hasAudio: streams.some((s) => s.codec_type === "audio"),
  };
}

test.describe("Overlay export flow (e2e)", () => {
  let pieceId = "";
  let videoFixturePath = "";

  test.beforeAll(async ({ request }) => {
    test.skip(!hasFfmpeg(), "ffmpeg not available");

    // Seed a piece.
    const pRes = await request.post("/api/pieces");
    pieceId = (await pRes.json()).id as string;

    videoFixturePath = path.resolve(
      __dirname,
      "..",
      "__tests__",
      "helpers",
      "fixtures",
      "video",
      "clip-red-3s.mp4",
    );
    const imageFixturePath = path.resolve(
      __dirname,
      "..",
      "__tests__",
      "helpers",
      "fixtures",
      "video",
      "logo-64.png",
    );

    const videoBuf = fs.readFileSync(videoFixturePath);
    const imageBuf = fs.readFileSync(imageFixturePath);

    // Probe duration server-side so add_overlay has the metadata it
    // needs (no browser to probe client-side in beforeAll).
    const mediaDuration = Number(
      execFileSync(
        "ffprobe",
        [
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "default=noprint_wrappers=1:nokey=1",
          videoFixturePath,
        ],
        { encoding: "utf8" },
      ).trim(),
    );

    // Upload the video fixture.
    await request.post(`/api/pieces/${pieceId}/upload`, {
      multipart: {
        file: {
          name: "clip-red-3s.mp4",
          mimeType: "video/mp4",
          buffer: videoBuf,
        },
        mediaDuration: String(mediaDuration),
      },
    });

    // Upload the logo fixture.
    await request.post(`/api/pieces/${pieceId}/upload`, {
      multipart: {
        file: {
          name: "logo-64.png",
          mimeType: "image/png",
          buffer: imageBuf,
        },
      },
    });

    const filesRes = await request.get(`/api/pieces/${pieceId}/files`);
    const filesBody = await filesRes.json();
    const files: { id: string; filename: string }[] = Array.isArray(filesBody)
      ? filesBody
      : filesBody.files ?? [];
    const videoFileId = files.find((f) => f.filename === "clip-red-3s.mp4")?.id;
    const imageFileId = files.find((f) => f.filename === "logo-64.png")?.id;
    if (!videoFileId) throw new Error("clip-red-3s.mp4 not persisted on piece");
    if (!imageFileId) throw new Error("logo-64.png not persisted on piece");

    // Base video scene.
    await request.post("/api/e2e/run-tool", {
      data: {
        tool: "libi.add_overlay",
        args: { pieceId, fileId: videoFileId, name: "base" },
      },
    });

    // Image overlay (drawtext not required).
    await request.post("/api/e2e/run-tool", {
      data: {
        tool: "libi.add_image_overlay",
        args: {
          pieceId,
          fileId: imageFileId,
          startTime: 0,
          duration: 3,
          rect: { x: 10, y: 10, width: 64, height: 64 },
          z: 0,
          opacity: 1,
        },
      },
    });
  });

  test("clicking Export downloads an MP4 produced by the ffmpeg-overlay backend", async ({
    page,
  }) => {
    test.skip(!hasFfmpeg(), "ffmpeg not available");

    await openEditor(page);
    await expect(page.locator('[data-testid="editor-panel"]')).toBeVisible({
      timeout: 20_000,
    });

    const exportButton = page.locator('[data-testid="export-button"]');
    await expect(exportButton).toBeVisible({ timeout: 20_000 });
    await expect(exportButton).toBeEnabled();

    // Capture the /api/export/ffmpeg response so we can assert the backend
    // header — the download event itself does not expose response headers.
    const exportResponsePromise = page.waitForResponse(
      (resp) =>
        resp.url().includes("/api/export/ffmpeg") && resp.request().method() === "POST",
      { timeout: 45_000 },
    );
    const downloadPromise = page.waitForEvent("download", { timeout: 45_000 });

    await exportButton.click();

    const exportResponse = await exportResponsePromise;
    expect(exportResponse.status()).toBe(200);
    expect(exportResponse.headers()["x-export-backend"]).toBe("ffmpeg-overlay");

    const download = await downloadPromise;
    const tmpPath = path.join(
      os.tmpdir(),
      `libi-e2e-overlay-${Date.now()}.mp4`,
    );
    await download.saveAs(tmpPath);

    try {
      const info = probe(tmpPath);
      expect(info.duration).not.toBeNull();
      // clip-red-3s.mp4 is ~3.0s; ffmpeg-overlay re-encode preserves it.
      expect(info.duration!).toBeGreaterThan(2.7);
      expect(info.duration!).toBeLessThan(3.3);
      expect(info.hasVideo).toBe(true);
      expect(info.hasAudio).toBe(true);
    } finally {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
    }
  });
});
