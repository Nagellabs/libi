import { test, expect } from "@playwright/test";
import { fixturePath, openEditor, probeDurationSeconds } from "./helpers/app";
import fs from "fs";
import path from "path";

/**
 * Proxy flow e2e. Creates a piece, uploads tiny.mp4 (probing duration in
 * the browser so mediaDuration is set — the piece-scoped upload route
 * trusts the client for that field). Polls proxy-status until ready, then
 * adds a video overlay via the E2E tool dispatch, reloads the editor,
 * and asserts the preview's video decode reads the /proxy URL (not
 * /content). This guards the useVideoSources URL-swap fix: without it, the
 * source would stay pointed at /content even after the proxy becomes ready.
 */

test.describe("Proxy pipeline", () => {
  test("uploaded video gets a proxy and its status reaches 'ready'", async ({ page }) => {
    // Create piece via API (request context is fine for this).
    const pieceResp = await page.request.post("/api/pieces", { data: {} });
    const pieceBody = await pieceResp.json();
    const seededPieceId: string =
      (pieceBody && (pieceBody.id ?? pieceBody.piece?.id)) ??
      (typeof pieceBody === "string" ? pieceBody : "");
    if (!seededPieceId) {
      throw new Error(
        `Could not extract piece id: ${JSON.stringify(pieceBody)}`,
      );
    }

    // Open the editor BEFORE uploading so we can probe duration in-browser.
    await openEditor(page, seededPieceId);

    // Upload the fixture via the piece-scoped upload route, probing duration
    // in the page first (mirrors video-preview.spec.ts approach — the server
    // relies on the client for mediaDuration on this route, and
    // add_overlay requires it).
    const fixtureBytes = fs.readFileSync(
      path.resolve(
        __dirname,
        "..",
        "__tests__",
        "helpers",
        "fixtures",
        "tiny.mp4",
      ),
    );
    const fileId = await page.evaluate(
      async (args: { pieceId: string; bytes: number[] }) => {
        const blob = new Blob([new Uint8Array(args.bytes)], {
          type: "video/mp4",
        });
        const file = new File([blob], "tiny.mp4", { type: "video/mp4" });

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
        return (data.file as { id: string }).id;
      },
      { pieceId: seededPieceId, bytes: Array.from(fixtureBytes) },
    );

    // Wait up to 30 s for proxy ready. Poll the piece-scoped files list and
    // read proxyStatus straight off the FileRecord (the dedicated
    // /proxy-status polling endpoint was removed once SSE-driven cache
    // invalidation made it redundant).
    let status: string | undefined = "unknown";
    for (let i = 0; i < 60; i++) {
      status = await page.evaluate(
        async ({ pieceId, id }) => {
          const r = await fetch(`/api/pieces/${pieceId}/files`);
          // The route answers `{ files: FileRecord[] }`.
          const { files } = (await r.json()) as {
            files: Array<{ id: string; proxyStatus?: string | null }>;
          };
          return files.find((f) => f.id === id)?.proxyStatus ?? "unknown";
        },
        { pieceId: seededPieceId, id: fileId },
      );
      if (status === "ready" || status === "failed") break;
      await page.waitForTimeout(500);
    }
    expect(status).toBe("ready");

    // Verify the editor's preview now reads the proxy URL.
    // Create a video scene from the uploaded file so the scene is rendered.
    const createResult = await page.evaluate(
      async ({ pieceId, fileId, duration }) => {
        const resp = await fetch("/api/e2e/run-tool", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tool: "libi.add_overlay",
            args: { pieceId, kind: "video", fileId, displayName: "tiny", startTime: 0, duration },
          }),
        });
        return { status: resp.status, body: await resp.json() };
      },
      { pieceId: seededPieceId, fileId, duration: probeDurationSeconds(fixturePath("tiny.mp4")) },
    );
    if (!createResult.body?.success) {
      throw new Error(
        `add_overlay failed: ${JSON.stringify(createResult)}`,
      );
    }

    // The preview decodes video with MediaBunny over fetch
    // (hooks/preview/use-video-sources.ts → MediaBunnyFrameSource), not a
    // <video> element, so what it reads is observable as requests. Record the
    // FETCH requests for this file across the reload — only those: the
    // resources panel's thumbnail is a <video src=…/proxy> too
    // (components/editor/asset-thumbnail.tsx), a `media` request, and counting
    // it would pass this spec with the preview still on /content.
    const fileRequests: Array<{ path: string }> = [];
    page.on("request", (req) => {
      const p = new URL(req.url()).pathname;
      if (req.resourceType() === "fetch" && p.startsWith(`/api/files/by-id/${fileId}/`)) {
        fileRequests.push({ path: p });
      }
    });

    // Reload to pick up the new overlay.
    await page.reload();
    await expect(page.locator("[data-testid=\"editor-panel\"]")).toBeVisible({
      timeout: 30_000,
    });

    // Wait for the canvas to appear (overlay rendered).
    const canvas = page.locator("[data-testid=\"preview-canvas\"]");
    await expect(canvas).toBeVisible({ timeout: 15_000 });

    // The video source reads the PROXY. (The audio engine reads the original,
    // /content, and turns to the proxy only when the original's audio track
    // can't be decoded — tiny.mp4's AAC can — so a /proxy request here is the
    // video decode: lib/audio/web-audio-engine.ts, hooks/preview/use-web-audio-master.ts.)
    await expect
      .poll(() => fileRequests.map((r) => r.path), { timeout: 15_000 })
      .toContain(`/api/files/by-id/${fileId}/proxy`);
  });
});
