import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { openEditor } from "./helpers/app";

test.describe("Overlay — agent creates", () => {
  let pieceId = "";

  test.beforeAll(async ({ request }) => {
    // Seed: piece + upload tiny.mp4 + create a video scene (NO overlay yet).
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
    await request.post("/api/e2e/run-tool", {
      data: { tool: "libi.add_overlay", args: { pieceId, kind: "video", fileId, displayName: "base" } },
    });
  });

  test("agent-added text overlay appears in the preview canvas", async ({ page, request }) => {
    await openEditor(page);
    await expect(page.locator('[data-testid="editor-panel"]')).toBeVisible({
      timeout: 20_000,
    });

    const canvas = page.locator('[data-testid="preview-canvas"]');
    await expect(canvas).toBeVisible();

    // Agent dispatch — server-side. Fires refresh_query SSE so the editor
    // re-fetches composition and re-renders the canvas.
    await request.post("/api/e2e/run-tool", {
      data: {
        tool: "libi.add_text_overlay",
        args: {
          pieceId, content: "agent-text", startTime: 0, duration: 2,
          rect: { x: 100, y: 100, width: 400, height: 80 },
          font: "48px Inter", color: "#ffffff", align: "center", z: 0, opacity: 1,
        },
      },
    });

    // Poll the canvas pixels where the overlay should draw — the text is
    // white on a black/dark video base, so a sample at the overlay's
    // composition-space center should have at least one bright pixel
    // once the SSE invalidation + re-render completes.
    await expect.poll(async () => {
      return await canvas.evaluate((el: HTMLCanvasElement) => {
        const ctx = el.getContext("2d");
        if (!ctx) return false;
        // Composition is 1920x1080; text overlay rect is (100,100) 400x80.
        // Sample a 40x20 strip at its center (300, 140).
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
    }, { timeout: 10_000 }).toBe(true);
  });
});
