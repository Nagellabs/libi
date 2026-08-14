import { test, expect } from "@playwright/test";
import { openEditor } from "./helpers/app";

/**
 * Drives the trim tool via /api/e2e/run-tool (the test-only dispatch
 * route introduced in Task 26's cleanup). Verifies the new file shows
 * up in the resources panel via the existing asset-row data-testid.
 */

test.describe("Agent — trim flow", () => {
  let pieceId = "";

  test.beforeAll(async ({ request }) => {
    // Create a piece + upload tiny.mp4 server-side. The POST /api/pieces
    // route auto-names the piece, so we just capture the returned id.
    const piecesResp = await request.post("/api/pieces");
    const piece = await piecesResp.json();
    pieceId = piece.id;

    const fs = await import("fs/promises");
    const path = await import("path");
    const fixtureBuf = await fs.readFile(
      path.resolve(__dirname, "..", "__tests__", "helpers", "fixtures", "tiny.mp4"),
    );

    // Probe duration on the server is optional; the trim tool doesn't require it.
    await request.post(
      `/api/pieces/${piece.id}/upload`,
      { multipart: { file: { name: "tiny.mp4", mimeType: "video/mp4", buffer: fixtureBuf } } },
    );
  });

  test("agent produces a trimmed file via libi.trim_video", async ({ page }) => {
    await openEditor(page);

    // Wait for the original asset row to render so we know files are loaded.
    await expect(
      page.locator('[data-testid="asset-row"]:has-text("tiny.mp4")'),
    ).toBeVisible({ timeout: 20_000 });

    // Drive the trim tool via the test-only dispatch route.
    await page.evaluate(async (pieceId: string) => {
      const filesResp = await fetch(`/api/pieces/${pieceId}/files`, {
        credentials: "same-origin",
      });
      // The route returns `{ files: [...] }`.
      const filesJson = await filesResp.json();
      const fileList: Array<{ id: string; filename: string }> = Array.isArray(
        filesJson,
      )
        ? filesJson
        : filesJson.files ?? [];
      const file = fileList.find((f) => f.filename === "tiny.mp4");
      if (!file) throw new Error("no tiny.mp4 on piece");

      const runResp = await fetch("/api/e2e/run-tool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tool: "libi.trim_video",
          args: {
            pieceId,
            fileId: file.id,
            startSeconds: 0,
            endSeconds: 0.5,
          },
        }),
      });
      const runJson = await runResp.json();
      if (!runResp.ok || !runJson.success) {
        throw new Error(
          `trim_video failed: ${runResp.status} ${JSON.stringify(runJson)}`,
        );
      }
    }, pieceId);

    // The SSE refresh only fires to clients with an active chat session
    // (see `useAgentChat` — the EventSource is session-scoped). In this
    // headless test we don't have a live session, so reload to pick up the
    // new file. This matches what the app would do for a user that simply
    // revisits the editor after a tool run.
    await page.reload();
    await expect(page.locator('[data-testid="editor-panel"]')).toBeVisible({
      timeout: 30_000,
    });

    // The trim produces `tiny-trim.mp4` by default.
    await expect(
      page.locator('[data-testid="asset-row"]:has-text("tiny-trim.mp4")'),
    ).toBeVisible({ timeout: 20_000 });
  });
});
