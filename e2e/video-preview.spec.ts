import { test, expect } from "@playwright/test";
import { openEditor, seedPieceWithVideo } from "./helpers/app";

/**
 * End-to-end exercise of the original "video stuck on frame 0" bug.
 *
 * The scratch LIBI_HOME starts empty, so we prepare a piece, attach the
 * fixture video to it, and add it as a video overlay before opening the editor.
 * The helpers then see a fully-populated editor and can drive playback /
 * scrubbing.
 */

test.describe.serial("Video preview", () => {
  let pieceId = "";

  test.beforeAll(async ({ request }) => {
    // Seed the piece before the first test renders the editor. Its own piece,
    // never "whichever piece the scratch home holds first": other specs share
    // that home, and theirs are not this spec's to play.
    ({ pieceId } = await seedPieceWithVideo(request, { fixture: "tiny.mp4", width: 1920, height: 1080, displayName: "tiny" }));
  });

  test("playing after upload advances the playhead", async ({ page }) => {
    await openEditor(page, pieceId);

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
    await openEditor(page, pieceId);

    // The scrub surface is the playhead strip above the tracks — the slim
    // strip that replaced the old ruler track (components/preview/timeline-playhead-strip.tsx).
    const timeline = page.locator('[data-testid="playhead-strip"]');
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
