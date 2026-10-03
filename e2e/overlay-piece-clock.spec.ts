import type { APIRequestContext } from "@playwright/test";
import { test, expect, openEditor, runTool } from "./helpers/app";

/**
 * A body can read where it sits on the piece: `compositionTime`, `overlayStart`, `pieceDuration`
 * (the manual's DrawContext). The preview hands them to the sandboxed runtime on every render
 * request; this is the browser half of the parity the export's unit test holds (a primitive that
 * worked in one path only is the duck-bug class).
 *
 * The body paints a flat colour rgb(compositionTime × 50, overlayStart × 100, pieceDuration × 30):
 * the red channel moves with the playhead, the other two are the overlay's and the piece's own.
 * The overlay starts at 1 s, so its own clock (`time`) is a full second behind the piece's: a body
 * that only saw overlay-local time would paint red 0–100 where this one paints 50–150.
 */
const FPS = 30;

async function newClockPiece(request: APIRequestContext): Promise<string> {
  const created = await request.post("/api/pieces");
  expect(created.ok()).toBe(true);
  const { id } = (await created.json()) as { id: string };
  const dims = await request.patch(`/api/pieces/${id}/composition/dimensions`, { data: { width: 640, height: 360 } });
  expect(dims.ok(), await dims.text()).toBe(true);
  const clock = `const { ctx, width, height, compositionTime, overlayStart, pieceDuration } = context;
ctx.fillStyle = "rgb(" + Math.round(compositionTime * 50) + "," + Math.round(overlayStart * 100) + "," + Math.round(pieceDuration * 30) + ")";
ctx.fillRect(0, 0, width, height);`;
  const a = await runTool(request, "libi.add_overlay", {
    pieceId: id, kind: "code", displayName: "Clock", body: clock, startTime: 1, duration: 2, z: 1, opacity: 1,
    rect: { x: 0, y: 0, width: 640, height: 360 },
  });
  expect(a.success, a.error).toBe(true);
  // The last thing on the timeline: it ends at 4 s, so the piece is 4 s long.
  const b = await runTool(request, "libi.add_overlay", {
    pieceId: id, kind: "text", content: "end", startTime: 3, duration: 1, z: 0, opacity: 1,
    rect: { x: 0, y: 0, width: 100, height: 40 }, font: "700 20px Inter", color: "#ffffff", align: "left",
  });
  expect(b.success, b.error).toBe(true);
  return id;
}

test.describe("overlay piece clock in the preview", () => {
  test("a body reading compositionTime / overlayStart / pieceDuration paints the piece's clock at every playhead position", async ({ page, request }) => {
    const pieceId = await newClockPiece(request);
    await openEditor(page, pieceId);

    const counter = page.locator('[data-testid="frame-counter"]');
    const play = page.locator('[data-testid="preview-play"]');
    await expect(counter).toBeVisible({ timeout: 15_000 });

    /** The frame the counter shows, and the colour in the middle of the canvas. */
    const read = async () => {
      const n = Number(((await counter.textContent()) ?? "").trim().split("/")[0]);
      const rgb = await page.locator('[data-testid="preview-canvas"]').evaluate((el: HTMLCanvasElement) => {
        const ctx = el.getContext("2d");
        if (!ctx) return [0, 0, 0];
        return Array.from(ctx.getImageData(Math.floor(el.width / 2), Math.floor(el.height / 2), 1, 1).data.slice(0, 3));
      });
      return { n, rgb };
    };

    // Pause the playhead at three places inside the overlay's window (1 s – 3 s of a 4 s piece, frames 30–90):
    // play until the counter passes a mark, then pause and read what the canvas painted for the frame it stopped on.
    for (const mark of [40, 60, 80]) {
      await play.click();
      await expect.poll(async () => (await read()).n, { intervals: [50], timeout: 30_000 }).toBeGreaterThanOrEqual(mark);
      await play.click(); // pause
      await expect
        .poll(
          async () => {
            const { n, rgb } = await read();
            const time = n / FPS;
            // Red follows the PIECE clock (a full second ahead of the overlay's own), green is where the overlay
            // starts (1 s → 100), blue is the piece length (4 s → 120).
            return time >= 1 && time < 3 && Math.abs(rgb[0]! - Math.round(time * 50)) <= 2 && Math.abs(rgb[1]! - 100) <= 2 && Math.abs(rgb[2]! - 120) <= 2;
          },
          { timeout: 30_000, message: `paused after frame ${mark}: the canvas paints the piece clock` },
        )
        .toBe(true);
    }
  });
});
