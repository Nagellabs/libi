import { test, expect } from "@playwright/test";
import { launchLibi } from "./helpers";
import path from "node:path";
import fs from "node:fs";

/**
 * Two-part Electron verification, driven against a SCRATCH LIBI_HOME so
 * we don't touch the developer's real `~/.libi`:
 *
 *  1. LIBI_HOME flows through to the renderer — pieces/files land in
 *     the scratch root, not `~/.libi/`.
 *  2. A full create-piece → write-scene → export run finishes inside
 *     the Electron renderer + the same Next.js server it loaded from.
 *
 * Prereqs (set by the harness before invocation):
 *   - A dev server on http://127.0.0.1:$LIBI_PORT with the same
 *     LIBI_HOME this spec reads.
 *
 * Skips itself with a clear message when those env vars aren't set,
 * so the spec is safe to include in the default `test:electron` suite.
 */

const LIBI_HOME = process.env.LIBI_HOME ?? "";
const LIBI_PORT = process.env.LIBI_PORT ?? "";
const SHOULD_RUN = LIBI_HOME.startsWith("/tmp/") && LIBI_PORT !== "";

const EXPORT_DEST = path.join(LIBI_HOME, "exports");

test.describe("Electron — LIBI_HOME + export end-to-end", () => {
  test.skip(!SHOULD_RUN, "Set LIBI_HOME=/tmp/... and LIBI_PORT=... to run this spec");

  test("renderer-side fetches resolve against the scratch LIBI_HOME", async () => {
    const { app, main } = await launchLibi();
    try {
      const fromRenderer = await main.evaluate(async (port) => {
        const res = await fetch(`http://127.0.0.1:${port}/api/pieces`);
        return (await res.json()) as Array<{ id: string; name: string }>;
      }, LIBI_PORT);
      expect(Array.isArray(fromRenderer)).toBe(true);

      const portFile = path.join(LIBI_HOME, "port");
      expect(fs.existsSync(portFile)).toBe(true);
      expect(fs.readFileSync(portFile, "utf-8").trim()).toBe(LIBI_PORT);
    } finally {
      await app.close();
    }
  });

  test("piece create + canvas-scene export end-to-end through the renderer", async () => {
    test.setTimeout(240_000);
    const { app, main } = await launchLibi();
    try {
      const port = LIBI_PORT;

      // ── 1. Create a fresh piece (writes to scratch DB).
      const piece = await main.evaluate(async (p) => {
        const res = await fetch(`http://127.0.0.1:${p}/api/pieces`, {
          method: "POST",
        });
        return (await res.json()) as { id: string; name: string };
      }, port);
      expect(piece.id).toMatch(/^[0-9a-f-]{36}$/);

      // ── 2. Seed a minimal canvas composition.json under scratch storage.
      const storageDir = path.join(LIBI_HOME, "storage", piece.id);
      fs.mkdirSync(storageDir, { recursive: true });
      const sceneId = `s-${Date.now()}`;
      const manifest = {
        sceneOrder: [sceneId],
        width: 320,
        height: 180,
        fps: 30,
        audioClips: [],
        overlays: [],
        scenes: [
          {
            id: sceneId,
            type: "canvas",
            name: "Test scene",
            duration: 0.5, // 15 frames @ 30fps
            drawFunction:
              "const { ctx, width, height } = context; ctx.fillStyle='#0ea5e9'; ctx.fillRect(0,0,width,height); ctx.fillStyle='#fff'; ctx.font='24px sans-serif'; ctx.fillText('libi', 20, 40);",
          },
        ],
      };
      fs.writeFileSync(
        path.join(storageDir, "composition.json"),
        JSON.stringify(manifest, null, 2),
      );

      // Server must initialize a snapshot before export accepts it for the
      // "draft" source. The route's loadComposition already creates one
      // lazily, so this is just an idempotent prime.
      await main.evaluate(async (args) => {
        const r = await fetch(
          `http://127.0.0.1:${args.port}/api/pieces/${args.pieceId}/composition`,
        );
        if (!r.ok) throw new Error("composition fetch failed: " + r.status);
      }, { port, pieceId: piece.id });

      // ── 3. Kick off an export, override destFolder so the artifact
      // lands inside the scratch home (easy to assert on).
      fs.mkdirSync(EXPORT_DEST, { recursive: true });
      const enqueued = await main.evaluate(async (args) => {
        const r = await fetch(`http://127.0.0.1:${args.port}/api/export`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pieceId: args.pieceId,
            source: "draft",
            filename: "electron-e2e",
            format: "mp4",
            quality: "source",
            destFolder: args.destFolder,
          }),
        });
        const text = await r.text();
        return { status: r.status, body: text };
      }, { port, pieceId: piece.id, destFolder: EXPORT_DEST });

      if (enqueued.status !== 200) {
        throw new Error(
          `POST /api/export failed: ${enqueued.status} ${enqueued.body}`,
        );
      }
      const { jobId } = JSON.parse(enqueued.body) as { jobId: string };
      expect(jobId).toBeTruthy();

      // ── 4. Poll job status until it completes or we time out. The
      // /api/jobs/[id] handler returns a JobStatusSnapshot: `status`,
      // `error`, and `resultJson` (the encoded runner result — NOT a
      // nested object).
      let lastSnapshot: { status?: string; resultJson?: string | null; error?: string | null } = {};
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        const snap = await main.evaluate(async (args) => {
          const r = await fetch(`http://127.0.0.1:${args.port}/api/jobs/${args.jobId}`);
          if (!r.ok) return { status: "missing" } as { status: string };
          return (await r.json()) as { status: string; resultJson?: string | null; error?: string | null };
        }, { port, jobId });
        lastSnapshot = snap;
        if (snap.status === "completed" || snap.status === "failed" || snap.status === "cancelled") {
          break;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (lastSnapshot.status !== "completed") {
        throw new Error(
          `Export job ended with status=${lastSnapshot.status} error=${lastSnapshot.error ?? "(none)"}`,
        );
      }
      const parsed = lastSnapshot.resultJson
        ? (JSON.parse(lastSnapshot.resultJson) as { filePath?: string; sizeBytes?: number })
        : null;
      const filePath = parsed?.filePath;
      expect(filePath, `result missing filePath: ${lastSnapshot.resultJson}`).toBeTruthy();
      expect(fs.existsSync(filePath!)).toBe(true);
      const st = fs.statSync(filePath!);
      expect(st.size).toBeGreaterThan(500); // non-empty MP4
      // The output MUST live inside the destFolder we requested — proves
      // the export route honors per-call destFolder, not the global default.
      expect(filePath!.startsWith(EXPORT_DEST)).toBe(true);
      console.log(`[export] wrote ${st.size} bytes to ${filePath}`);
    } finally {
      await app.close();
    }
  });
});
