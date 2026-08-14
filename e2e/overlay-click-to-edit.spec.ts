import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { openEditor } from "./helpers/app";

test.describe("Overlay — click to edit text", () => {
  let pieceId = "";

  test.beforeAll(async ({ request }) => {
    // Seed: piece + upload tiny.mp4 (with mediaDuration from host-side ffprobe) +
    // create a video scene + add a text overlay at a known rect.
    const pRes = await request.post("/api/pieces");
    pieceId = (await pRes.json()).id as string;

    const fixturePath = path.resolve(
      __dirname, "..", "__tests__", "helpers", "fixtures", "tiny.mp4",
    );
    const fixtureBuf = fs.readFileSync(fixturePath);
    const mediaDuration = Number(
      execFileSync("ffprobe", [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        fixturePath,
      ], { encoding: "utf8" }).trim(),
    );

    await request.post(`/api/pieces/${pieceId}/upload`, {
      multipart: {
        file: { name: "tiny.mp4", mimeType: "video/mp4", buffer: fixtureBuf },
        mediaDuration: String(mediaDuration),
      },
    });

    const filesRes = await request.get(`/api/pieces/${pieceId}/files`);
    const { files } = await filesRes.json();
    const fileId = files.find((f: { filename: string }) => f.filename === "tiny.mp4")?.id;
    if (!fileId) throw new Error("tiny.mp4 not present on seeded piece");

    await request.post("/api/e2e/run-tool", {
      data: { tool: "libi.add_overlay", args: { pieceId, kind: "video", fileId, displayName: "base" } },
    });

    // Text overlay at composition-space rect (100, 100) 400x80 — matches
    // the coordinate we click below.
    await request.post("/api/e2e/run-tool", {
      data: {
        tool: "libi.add_text_overlay",
        args: {
          pieceId, content: "Initial", startTime: 0, duration: 2,
          rect: { x: 100, y: 100, width: 400, height: 80 },
          font: "48px Inter", color: "#ffffff", align: "center", z: 0, opacity: 1,
        },
      },
    });
  });

  test("user clicks on text overlay, edits it, commits on blur", async ({ page }) => {
    await openEditor(page);

    // Wait for the editor to hydrate and for the composition query to
    // settle (Task 4 wires overlays through the query's `manifest` field).
    await expect(page.locator('[data-testid="editor-panel"]')).toBeVisible({
      timeout: 20_000,
    });

    // Click at the text overlay's composition-space center (100+200, 100+40)
    // mapped into the canvas's current display bounds.
    const canvas = page.locator('[data-testid="preview-canvas"]');
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    if (!box) throw new Error("no canvas box");
    // Composition is 1920x1080 from the default buildComposition hardcoded dims.
    const scaleX = box.width / 1920;
    const scaleY = box.height / 1080;
    await page.mouse.click(
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
