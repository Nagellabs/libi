import { test, expect, type Page } from "@playwright/test";
import fs from "fs";
import { fixturePath, openEditor, uploadFile } from "./helpers/app";

/**
 * End-to-end exercise of the original "video stuck on frame 0" bug.
 *
 * The scratch LIBI_HOME starts empty, so we prepare a piece, attach the
 * fixture video to it, and create a video scene before opening the editor.
 * The helpers then see a fully-populated editor and can drive playback /
 * scrubbing.
 */

async function ensurePieceWithVideo(page: Page): Promise<{ pieceId: string; fileId: string }> {
  // 1. Create (or reuse) a piece.
  const existingPieces = await page.request.get("/api/pieces");
  const pieces = (await existingPieces.json()) as Array<{ id: string }>;
  let pieceId: string;
  if (pieces.length > 0) {
    pieceId = pieces[0].id;
  } else {
    const created = await page.request.post("/api/pieces");
    const piece = (await created.json()) as { id: string };
    pieceId = piece.id;
  }

  // 2. Ensure the fixture is uploaded and assigned to the piece.
  const filesResp = await page.request.get(`/api/pieces/${pieceId}/files`);
  const filesJson = await filesResp.json();
  const filesList: Array<{ id: string; filename: string }> = Array.isArray(filesJson)
    ? filesJson
    : (filesJson.files ?? []);
  const existing = filesList.find((f) => f.filename === "tiny.mp4");
  let fileId: string;
  if (existing) {
    fileId = existing.id;
  } else {
    // Probe media dimensions in the browser (mirrors what the UI uploader
    // does), then POST directly to the piece-scoped upload endpoint so the
    // file is immediately scoped and has mediaDuration set.
    const fixtureBytes = fs.readFileSync(fixturePath("tiny.mp4"));
    const uploaded = await page.evaluate(
      async (args: { pieceId: string; bytes: number[] }) => {
        const blob = new Blob([new Uint8Array(args.bytes)], { type: "video/mp4" });
        const file = new File([blob], "tiny.mp4", { type: "video/mp4" });

        // Probe duration via a hidden <video> element.
        const probeDuration = (): Promise<number | null> =>
          new Promise((resolve) => {
            const url = URL.createObjectURL(file);
            const video = document.createElement("video");
            video.preload = "metadata";
            const cleanup = () => {
              URL.revokeObjectURL(url);
              video.remove();
            };
            const timeout = setTimeout(() => {
              cleanup();
              resolve(null);
            }, 5000);
            video.onloadedmetadata = () => {
              clearTimeout(timeout);
              const d = video.duration;
              cleanup();
              resolve(Number.isFinite(d) ? d : null);
            };
            video.onerror = () => {
              clearTimeout(timeout);
              cleanup();
              resolve(null);
            };
            video.src = url;
          });

        const duration = await probeDuration();

        const form = new FormData();
        form.append("file", file);
        if (duration != null) form.append("mediaDuration", String(duration));

        const resp = await fetch(`/api/pieces/${args.pieceId}/upload`, {
          method: "POST",
          body: form,
          credentials: "same-origin",
        });
        if (!resp.ok) throw new Error(`upload failed: ${resp.status}`);
        const data = await resp.json();
        return data.file as { id: string };
      },
      { pieceId, bytes: Array.from(fixtureBytes) },
    );
    fileId = uploaded.id;
  }

  // 3. Ensure at least one video scene references the file.
  const compResp = await page.request.get(`/api/pieces/${pieceId}/composition`);
  const comp = (await compResp.json()) as {
    scenes?: Array<{ type?: string; fileId?: string }>;
  };
  const hasVideoScene = (comp.scenes ?? []).some(
    (s) => s.type === "video" && s.fileId === fileId,
  );
  if (!hasVideoScene) {
    const createResp = await page.request.post("/api/e2e/run-tool", {
      data: {
        tool: "libi.add_overlay",
        args: { pieceId, kind: "video", fileId, displayName: "tiny" },
      },
    });
    const createJson = await createResp.json();
    if (!createJson.success) {
      throw new Error(`add_overlay failed: ${createJson.error ?? "unknown"}`);
    }
  }

  return { pieceId, fileId };
}

test.describe.serial("Video preview", () => {
  test.beforeAll(async ({ browser }) => {
    // Seed the scratch LIBI_HOME before the first test renders the editor,
    // so the editor-panel is guaranteed to be visible.
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    // Hit the root so same-origin cookies / baseURL are active.
    await page.goto("/");
    await ensurePieceWithVideo(page);
    await ctx.close();
  });

  test("playing after upload advances the playhead", async ({ page }) => {
    await openEditor(page);
    await ensurePieceWithVideo(page);

    // The upload helper targets the resources upload input. It does nothing
    // harmful if the file is already present; the helper waits for the row
    // to be visible. When the seeded piece already has the file, the row is
    // already there, so the helper returns quickly.
    try {
      await uploadFile(page, "tiny.mp4");
    } catch {
      // If the panel is closed or the file already exists, proceed.
    }

    const canvas = page.locator('[data-testid="preview-canvas"]');
    await expect(canvas).toBeVisible({ timeout: 15_000 });

    const frameCounter = page.locator('[data-testid="frame-counter"]');
    await expect(frameCounter).toBeVisible();
    const beforeText = (await frameCounter.textContent())?.trim() ?? "";

    await page.locator('[data-testid="preview-play"]').click();
    await page.waitForTimeout(800);

    const afterText = (await frameCounter.textContent())?.trim() ?? "";
    expect(afterText).not.toBe(beforeText);

    // Pause so the DOM settles before the next test.
    await page.locator('[data-testid="preview-play"]').click();
  });

  test("scrubbing the timeline updates the playhead immediately", async ({ page }) => {
    await openEditor(page);
    await ensurePieceWithVideo(page);

    const timeline = page.locator('[data-testid="timeline-track"]');
    await expect(timeline).toBeVisible();

    const frameCounter = page.locator('[data-testid="frame-counter"]');
    await expect(frameCounter).toBeVisible({ timeout: 15_000 });

    const before = (await frameCounter.textContent())?.trim() ?? "";

    const box = await timeline.boundingBox();
    if (!box) throw new Error("no timeline bounding box");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    // Give React a tick to propagate the seek.
    await page.waitForTimeout(100);

    const after = (await frameCounter.textContent())?.trim() ?? "";
    expect(after).not.toBe(before);
  });
});
