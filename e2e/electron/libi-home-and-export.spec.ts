import { test, expect } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { launchLibi } from "./helpers";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

/**
 * Two-part Electron verification, driven against a SCRATCH LIBI_HOME so
 * we don't touch the developer's real `~/.libi`:
 *
 *  1. LIBI_HOME flows through to the renderer — pieces/files land in
 *     the scratch root, not `~/.libi/`.
 *  2. A full create-piece → add a drawn layer → export run finishes inside
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

  test("piece create + code-overlay export end-to-end through the renderer", async () => {
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

      // ── 2. A small frame, then one full-frame hand-drawn layer on it.
      //
      // This used to hand-write a composition.json with a canvas SCENE
      // (`scenes` / `sceneOrder` / `drawFunction`). Canvas scenes were removed
      // on 2026-08-21 (f0e0a410): "a full-frame hand-drawn graphic is a code
      // overlay now", and loadManifest drops `scenes` from any manifest still
      // carrying it (lib/composition/persistence.ts) — so that seed loaded as
      // an EMPTY piece and the export rightly refused it, "Nothing to export".
      // The same draw body now goes in as a code overlay, the way an agent
      // makes one: `libi.add_overlay` over libi's MCP endpoint, whose code
      // lands in the overlay's own file (composition.json never holds code).
      const dims = await main.evaluate(async (args) => {
        const r = await fetch(`http://127.0.0.1:${args.port}/api/pieces/${args.pieceId}/composition/dimensions`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ width: 320, height: 180 }),
        });
        return r.status;
      }, { port, pieceId: piece.id });
      expect(dims).toBe(200);

      const mcpPort = fs.readFileSync(path.join(LIBI_HOME, "mcp-port"), "utf-8").trim();
      const client = new Client({ name: "electron-e2e", version: "0" });
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`));
      try {
        await client.connect(transport);
        const called = await client.callTool({
          name: "libi.add_overlay",
          arguments: {
            pieceId: piece.id,
            kind: "code",
            displayName: "Test layer",
            body:
              "const { ctx, width, height } = context; ctx.fillStyle='#0ea5e9'; ctx.fillRect(0,0,width,height); ctx.fillStyle='#fff'; ctx.font='24px sans-serif'; ctx.fillText('libi', 20, 40);",
            rect: { x: 0, y: 0, width: 320, height: 180 },
            startTime: 0,
            duration: 0.5, // 15 frames @ 30fps
            z: 0,
            opacity: 1,
          },
        });
        const text = (called.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
        const result = JSON.parse(text) as { success: boolean; error?: string };
        expect(result.success, text).toBe(true);
      } finally {
        // DELETE /mcp — leave no session behind on a live aggregator.
        await transport.terminateSession().catch(() => {});
        await transport.close().catch(() => {});
      }

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
      // The layer is in the file: a non-empty MP4 could still be black frames.
      // The body fills the frame with #0ea5e9, so a 2x2 patch away from the
      // "libi" label must decode to that blue (within H.264's colour error).
      const [w, h] = execFileSync(
        "ffprobe",
        ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", filePath!],
        { encoding: "utf8" },
      ).trim().split(",").map(Number);
      const rgb = execFileSync("ffmpeg", [
        "-v", "error", "-ss", "0.1", "-i", filePath!, "-frames:v", "1",
        "-vf", `crop=2:2:${Math.round(w * 0.75)}:${Math.round(h * 0.75)},format=rgb24`,
        "-f", "rawvideo", "-",
      ]);
      const [r, g, b] = [rgb[0], rgb[1], rgb[2]];
      expect(
        Math.abs(r - 0x0e) <= 12 && Math.abs(g - 0xa5) <= 12 && Math.abs(b - 0xe9) <= 12,
        `pixel rgb(${r},${g},${b}) is not the drawn #0ea5e9`,
      ).toBe(true);
      console.log(`[export] wrote ${st.size} bytes to ${filePath}`);
    } finally {
      await app.close();
    }
  });
});
