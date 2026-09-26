import { test, expect } from "@playwright/test";
import { openEditor, runTool, seedPieceWithVideo } from "./helpers/app";

test.describe("Overlay — click to edit text", () => {
  let pieceId = "";

  test.beforeAll(async ({ request }) => {
    // 1920x1080, so the click below can place itself by composition
    // coordinates.
    ({ pieceId } = await seedPieceWithVideo(request, { fixture: "tiny.mp4", width: 1920, height: 1080 }));

    await runTool(request, "libi.add_overlay", {
      pieceId,
      kind: "text",
      content: "Initial",
      startTime: 0,
      duration: 2,
      rect: { x: 100, y: 100, width: 400, height: 80 },
      font: "48px Inter",
      color: "#ffffff",
      align: "center",
      z: 1,
      opacity: 1,
    });
  });

  test("user clicks on text overlay, edits it, commits on blur", async ({ page }) => {
    await openEditor(page, pieceId);

    // Click at the text overlay's composition-space center (100+200, 100+40)
    // mapped into the canvas's current display bounds.
    const canvas = page.locator('[data-testid="preview-canvas"]');
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    if (!box) throw new Error("no canvas box");
    // The seeded composition is 1920x1080.
    const scaleX = box.width / 1920;
    const scaleY = box.height / 1080;
    // A DOUBLE-click opens the inline text editor; a single click only
    // selects (preview-player.tsx handleCanvasPointerDown / handleCanvasDoubleClick).
    await page.mouse.dblclick(
      box.x + (100 + 200) * scaleX,
      box.y + (100 + 40) * scaleY,
    );

    // The inline editor mounts as a contentEditable div with a
    // data-overlay-id attribute (Task 7).
    const editor = page.locator('[contenteditable="true"][data-overlay-id]');
    await expect(editor).toBeVisible({ timeout: 5_000 });

    // Select all existing text + type the new content. The editor is
    // already focused + has a select-all range from its useEffect.
    // Use ControlOrMeta so this works on macOS (Meta+A) and Linux/Win
    // (Control+A) — Playwright does not remap a bare "Control".
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type("Edited content");

    // Blur to commit. Click outside the editor (top-left of the canvas
    // area, well away from the overlay rect).
    await canvas.click({ position: { x: 5, y: 5 } });

    // The commit fetches PATCH /api/pieces/{pieceId}/overlays/{overlayId}
    // which calls updateTextOverlay + invalidates the composition query.
    // Verify via the composition endpoint.
    await expect.poll(async () => {
      const after = await page.evaluate(async (id) => {
        const r = await fetch(`/api/pieces/${id}/composition`);
        return r.json();
      }, pieceId);
      const overlays = after.manifest?.overlays ?? [];
      const text = overlays.find((o: { kind: string }) => o.kind === "text");
      return text?.content;
    }, { timeout: 5_000 }).toBe("Edited content");
  });
});
