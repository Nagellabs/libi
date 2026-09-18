/**
 * Integration: the unified `export` JobManager runner — the path
 * `libi.export_video` actually takes — must surface `droppedOverlays` from
 * the chromium-render backend in its own returned result, so the MCP tool
 * response tells the agent which overlay(s) were skipped (QA 2026-09-18 B1:
 * a code overlay whose starter body threw "ctx is not defined" was silently
 * dropped and the export still reported plain success).
 *
 * The ChromiumRenderBackend is stubbed to return a droppedOverlays list — no
 * Chromium is launched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { resetStorage } from "@/lib/storage";
import { getLibiStorageDir } from "@/lib/libi-home";
import { getDb } from "@/lib/db/client";
import type { Composition } from "@/lib/engine/types";
import type { RenderPayload } from "@/lib/export/render-jobs";
import type { JobContext } from "@/lib/jobs/types";
import { exportLogger } from "@/lib/logger";

const captured = vi.hoisted(() => ({
  droppedOverlays: undefined as Array<{ id: string; message: string }> | undefined,
  unloadedFonts: undefined as Array<{ fontFileId: string; reason: string }> | undefined,
  failWith: undefined as (Error & { graphFile?: string }) | undefined,
}));
vi.mock("@/lib/export/ensure-chromium", async (orig) => ({
  ...(await orig<typeof import("@/lib/export/ensure-chromium")>()),
  ensureChromium: vi.fn(async () => {}),
}));
vi.mock("@/lib/export/backends/chromium-render", () => ({
  ChromiumRenderBackend: class {
    name = "chromium-render";
    async run(_ctx: { composition: Composition; payload: RenderPayload }) {
      if (captured.failWith) throw captured.failWith;
      return {
        blob: new Blob([new Uint8Array([0, 1])]),
        duration: 2,
        format: "mp4",
        ...(captured.droppedOverlays ? { droppedOverlays: captured.droppedOverlays } : {}),
        ...(captured.unloadedFonts ? { unloadedFonts: captured.unloadedFonts } : {}),
      };
    }
  },
}));

import { exportRunner, type ExportParams } from "@/lib/jobs/runners/export";
import { loadManifest, saveManifest } from "@/lib/composition/persistence";

const PIECE_ID = "p-export-runner-dropped";

function fakeCtx(params: ExportParams): JobContext<ExportParams> {
  return {
    jobId: "job-test",
    params,
    resumeState: null,
    reportProgress: () => {},
    checkpoint: async () => {},
    shouldCancel: () => false,
  };
}

function params(destFolder: string): ExportParams {
  return {
    pieceId: PIECE_ID,
    source: "draft",
    filename: "out",
    destFolder,
    settings: {
      format: "mp4", codec: "avc", bitrate: 1_000_000,
      width: 320, height: 240, fps: 24,
    },
  } as ExportParams;
}

/** A code overlay with a broken body forces the chromium-render branch (the
 *  ffmpeg graph cannot run one) — exactly the QA repro shape. The backend is
 *  stubbed, so the body itself is never actually executed here. */
async function seedManifest(): Promise<void> {
  const m = await loadManifest(PIECE_ID);
  m.width = 320;
  m.height = 240;
  m.fps = 24;
  m.overlays = [
    {
      id: "code-bg", kind: "code", displayName: "backdrop",
      startTime: 0, duration: 2, z: 0, opacity: 1,
      rect: { x: 0, y: 0, width: 320, height: 240 }, drawFunction: "// draw",
    },
  ] as typeof m.overlays;
  await saveManifest(PIECE_ID, m);
}

describe("export runner — droppedOverlays propagation (agent path)", () => {
  let outDir: string;

  beforeEach(() => {
    captured.droppedOverlays = undefined;
    captured.unloadedFonts = undefined;
    captured.failWith = undefined;
    createTestDb();
    createTempStorageDir();
    resetStorage();
    seedPiece(getDb() as never, { id: PIECE_ID });
    outDir = path.join(getLibiStorageDir(), "export-out");
  });

  afterEach(() => {
    cleanupTempDir();
    resetTestDb();
    resetStorage();
  });

  it("carries a non-empty droppedOverlays list from the backend into the runner's ExportResult", async () => {
    await seedManifest();
    captured.droppedOverlays = [{ id: "code-bg", message: "ctx is not defined" }];
    const result = await exportRunner.run(fakeCtx(params(outDir)));
    expect(result.backend).toBe("chromium-render");
    expect(result.droppedOverlays).toEqual([{ id: "code-bg", message: "ctx is not defined" }]);
    // The export still succeeded — a dropped overlay is informational, not fatal.
    expect(fs.existsSync(result.filePath)).toBe(true);
  });

  // QA 2026-09-18 O1: the warn line carried the inner export_render job's id,
  // not the export job id the agent holds, so correlating the two took a
  // second log line. It is now logged here, under the agent's job id.
  it("logs overlay_dropped under the EXPORT job id the agent sees", async () => {
    const warnSpy = vi.spyOn(exportLogger, "warn").mockImplementation(() => exportLogger);
    await seedManifest();
    captured.droppedOverlays = [{ id: "code-bg", message: "ctx is not defined" }];
    await exportRunner.run(fakeCtx(params(outDir)));
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        op: "overlay_dropped",
        jobId: "job-test",
        pieceId: PIECE_ID,
        droppedOverlays: [{ id: "code-bg", message: "ctx is not defined" }],
      }),
      expect.any(String),
    );
    warnSpy.mockRestore();
  });

  // QA recheck N5: an uploaded font the render page couldn't load falls back
  // to a default face — say so in the log, under the agent's job id.
  it("logs font_load_failed under the export job id when the render page couldn't load an uploaded font", async () => {
    const warnSpy = vi.spyOn(exportLogger, "warn").mockImplementation(() => exportLogger);
    await seedManifest();
    captured.unloadedFonts = [{ fontFileId: "font-impact", reason: "font load timed out" }];
    const result = await exportRunner.run(fakeCtx(params(outDir)));
    const expected = [{ fontFileId: "font-impact", family: "libifont-font-impact", reason: "font load timed out" }];
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ op: "font_load_failed", jobId: "job-test", pieceId: PIECE_ID, unloadedFonts: expected }),
      expect.any(String),
    );
    // Final QA F1: and in the result libi.export_video returns, like
    // droppedOverlays — the agent must be able to tell the user.
    expect(result.unloadedFonts).toEqual(expected);
    warnSpy.mockRestore();
  });

  it("bounds the unloadedFonts list in the result", async () => {
    await seedManifest();
    captured.unloadedFonts = Array.from({ length: 30 }, (_, i) => ({ fontFileId: `f${i}`, reason: "x" }));
    const result = await exportRunner.run(fakeCtx(params(outDir)));
    expect(result.unloadedFonts).toHaveLength(20);
  });

  it("omits unloadedFonts from the result when every font loaded", async () => {
    await seedManifest();
    const result = await exportRunner.run(fakeCtx(params(outDir)));
    expect(result.unloadedFonts).toBeUndefined();
  });

  // A failed long-graph export keeps its filter graph file; the fail line
  // names it so it can be inspected.
  it("names a kept graph file in the export fail log", async () => {
    const warnSpy = vi.spyOn(exportLogger, "warn").mockImplementation(() => exportLogger);
    await seedManifest();
    captured.failWith = Object.assign(new Error("ffmpeg exited with code 234"), { graphFile: "/tmp/g/filter_complex.txt" });
    await expect(exportRunner.run(fakeCtx(params(outDir)))).rejects.toThrow("234");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: "fail", jobId: "job-test", graphFile: "/tmp/g/filter_complex.txt" }),
      "export.fail",
    );
    warnSpy.mockRestore();
  });

  it("omits droppedOverlays from the runner's ExportResult when nothing was dropped", async () => {
    await seedManifest();
    captured.droppedOverlays = undefined;
    const result = await exportRunner.run(fakeCtx(params(outDir)));
    expect(result.droppedOverlays).toBeUndefined();
  });
});
