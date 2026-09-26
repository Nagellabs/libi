import { test, expect } from "@playwright/test";
import { openEditor, runTool, seedPieceWithVideo } from "./helpers/app";

test.describe("Overlay — agent creates", () => {
  let pieceId = "";

  test.beforeAll(async ({ request }) => {
    // 1920x1080, so the canvas sampling below can place the text by
    // composition coordinates. tiny.mp4 is a black clip.
    ({ pieceId } = await seedPieceWithVideo(request, { fixture: "tiny.mp4", width: 1920, height: 1080 }));
  });

  test("agent-added text overlay appears in the preview canvas", async ({ page, request }) => {
    await openEditor(page, pieceId);

    const canvas = page.locator('[data-testid="preview-canvas"]');
    await expect(canvas).toBeVisible();

    // White pixels in a 40x20 strip at the text overlay's composition-space
    // center (300, 140) — its rect below is (100,100) 400x80.
    const textIsDrawn = () =>
      canvas.evaluate((el: HTMLCanvasElement) => {
        const ctx = el.getContext("2d");
        if (!ctx) return false;
        const cx = Math.round((300 / 1920) * el.width);
        const cy = Math.round((140 / 1080) * el.height);
        try {
          const strip = ctx.getImageData(
            Math.max(0, cx - 20),
            Math.max(0, cy - 10),
            40,
            20,
          ).data;
          for (let i = 0; i < strip.length; i += 4) {
            if (strip[i] > 200 || strip[i + 1] > 200 || strip[i + 2] > 200) {
              return true;
            }
          }
        } catch {
          /* getImageData may throw on tainted canvas — retry next poll */
        }
        return false;
      });

    // Nothing bright there before the agent acts — otherwise the poll below
    // would pass without the overlay ever drawing.
    expect(await textIsDrawn()).toBe(false);

    // Agent dispatch — server-side. Fires refresh_query SSE so the editor
    // re-fetches composition and re-renders the canvas.
    await runTool(request, "libi.add_overlay", {
      pieceId,
      kind: "text",
      content: "agent-text",
      startTime: 0,
      duration: 2,
      rect: { x: 100, y: 100, width: 400, height: 80 },
      font: "48px Inter",
      color: "#ffffff",
      align: "center",
      z: 1,
      opacity: 1,
    });

    // The text is white on the black video base, so the strip gains a bright
    // pixel once the SSE invalidation + re-render completes.
    await expect.poll(textIsDrawn, { timeout: 10_000 }).toBe(true);
  });
});
