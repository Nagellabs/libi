import { test, expect } from "@playwright/test";
import fs from "fs";
import { execFileSync, execSync } from "child_process";
import { fixturePath, openEditor, runTool, seedPieceWithVideo } from "./helpers/app";

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

  test.beforeAll(async ({ request }) => {
    test.skip(!hasFfmpeg(), "ffmpeg not available");

    // Base video: the red 3 s clip, full frame, 0 → its end.
    ({ pieceId } = await seedPieceWithVideo(request, {
      fixture: "video/clip-red-3s.mp4",
      width: 1920,
      height: 1080,
      displayName: "base",
    }));

    // Upload the logo fixture.
    const logo = fixturePath("video/logo-64.png");
    const upRes = await request.post(`/api/pieces/${pieceId}/upload`, {
      multipart: {
        file: { name: "logo-64.png", mimeType: "image/png", buffer: fs.readFileSync(logo) },
      },
    });
    expect(upRes.ok(), `logo upload → HTTP ${upRes.status()}`).toBe(true);
    const imageFileId = ((await upRes.json()) as { file: { id: string } }).file.id;

    // Image overlay above the base (drawtext not required) — a declarative
    // overlay over a base video is what the ffmpeg-overlay backend exists for.
    await runTool(request, "libi.add_overlay", {
      pieceId,
      kind: "image",
      fileId: imageFileId,
      startTime: 0,
      duration: 3,
      rect: { x: 10, y: 10, width: 64, height: 64 },
      z: 1,
      opacity: 1,
    });
  });

  test("the Export dialog writes an MP4 produced by the ffmpeg-overlay backend", async ({
    page,
  }) => {
    test.skip(!hasFfmpeg(), "ffmpeg not available");
    test.setTimeout(120_000);

    await openEditor(page, pieceId);

    // The Export button opens the export dialog (components/export/export-dialog.tsx);
    // its own Export button starts an `export` job through POST /api/export,
    // which writes the file to the export folder — there is no browser download.
    const exportButton = page.locator('[data-testid="export-button"]');
    await expect(exportButton).toBeVisible({ timeout: 20_000 });
    await expect(exportButton).toBeEnabled();
    await exportButton.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 15_000 });

    // Every export shows what it's for (Social preselected) and every track;
    // clip-red-3s.mp4 was uploaded, so its sound is the user's own and on.
    await expect(dialog.getByTestId("export-purpose-social")).toHaveAttribute("aria-checked", "true");
    await expect(dialog.getByTestId("export-audio-list")).toBeVisible();

    const enqueued = page.waitForResponse(
      (resp) => new URL(resp.url()).pathname === "/api/export" && resp.request().method() === "POST",
      { timeout: 30_000 },
    );
    await dialog.getByRole("button", { name: "Export", exact: true }).click();
    const enqueueResponse = await enqueued;
    expect(enqueueResponse.status()).toBe(200);
    const { jobId } = (await enqueueResponse.json()) as { jobId: string };
    expect(jobId).toBeTruthy();

    // The dialog queues the export and steps aside (exports rework B2): it shows
    // the queued banner, not a success card. The job's own record is the source
    // of truth for when it finished and where the file went.
    await expect(dialog.getByTestId("export-queued")).toBeVisible({ timeout: 15_000 });
    type JobRow = { status: string; resultJson?: string | null };
    let job: JobRow = { status: "" };
    await expect
      .poll(
        async () => {
          job = (await (await page.request.get(`/api/jobs/${jobId}`)).json()) as JobRow;
          return job.status;
        },
        { timeout: 90_000, intervals: [500, 1000] },
      )
      .toBe("completed");
    const result = JSON.parse(job.resultJson ?? "null") as { filePath: string; backend: string } | null;
    expect(result?.backend).toBe("ffmpeg-overlay");
    const filePath = result!.filePath;

    try {
      const info = probe(filePath);
      expect(info.duration).not.toBeNull();
      // clip-red-3s.mp4 is ~3.0s; ffmpeg-overlay re-encode preserves it.
      expect(info.duration!).toBeGreaterThan(2.7);
      expect(info.duration!).toBeLessThan(3.3);
      expect(info.hasVideo).toBe(true);
      expect(info.hasAudio).toBe(true);
    } finally {
      try {
        fs.unlinkSync(filePath);
      } catch {
        /* ignore */
      }
    }
  });
});
