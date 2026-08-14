/**
 * Integration: the unified `export` JobManager runner — the path
 * `libi.export_video` (agent/server exports) actually takes — strips hidden
 * layers (the PERSISTED `overlay.hidden` eye toggle) + their coupled inline
 * audio from the manifest BEFORE classification. Closing this path is the
 * whole point of persisting `hidden`: no client exists to thread ids.
 *
 * Shape under test: a canvas scene forces the chromium-render branch (what
 * agents most often export), so the assertions cover the `buildRenderPayload`
 * arrays — `payload.overlays` (what the /render page draws) and
 * `payload.audioClips` (exactly what `muxAudioIntoRender` mixes downstream in
 * the export_render runner) — plus the classifier composition itself.
 *
 * The ChromiumRenderBackend is stubbed (captures composition + payload,
 * returns a tiny blob) — no Chromium is launched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { resetStorage } from "@/lib/storage";
import { getLibiStorageDir } from "@/lib/libi-home";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import type { Composition } from "@/lib/engine/types";
import type { RenderPayload } from "@/lib/export/render-jobs";
import type { JobContext } from "@/lib/jobs/types";

const captured = vi.hoisted(() => ({
  runs: [] as Array<{ composition: Composition; payload: RenderPayload }>,
}));
vi.mock("@/lib/export/backends/chromium-render", () => ({
  ChromiumRenderBackend: class {
    name = "chromium-render";
    async run(ctx: { composition: Composition; payload: RenderPayload }) {
      captured.runs.push({ composition: ctx.composition, payload: ctx.payload });
      return { blob: new Blob([new Uint8Array([0, 1])]), duration: 2 };
    }
  },
}));

import { exportRunner, type ExportParams } from "@/lib/jobs/runners/export";
import { loadManifest, saveManifest } from "@/lib/composition/persistence";

const PIECE_ID = "p-export-runner-hidden";
const FILE_ID = "f-vid";

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

/** Seed the draft manifest: a canvas scene (forces the chromium-render branch)
 *  + a video overlay (optionally hidden) with a COUPLED inline clip, plus a
 *  free-standing music clip that must always survive. */
async function seedManifest(opts: { hidden: boolean }): Promise<void> {
  const m = await loadManifest(PIECE_ID);
  m.width = 320;
  m.height = 240;
  m.fps = 24;
  m.scenes = [
    { id: "s1", name: "canvas", type: "canvas", duration: 2, drawFunction: "// draw" },
  ] as typeof m.scenes;
  m.overlays = [
    {
      id: "vid-x", kind: "video", fileId: FILE_ID,
      startTime: 0, duration: 1, z: 0, opacity: 1, fit: "cover",
      rect: { x: 0, y: 0, width: 320, height: 240 },
      ...(opts.hidden ? { hidden: true } : {}),
    },
  ] as typeof m.overlays;
  m.audioClips = [
    {
      id: "a-coupled", kind: "inline", fileId: FILE_ID,
      startTime: 0, duration: 1, trimStart: 0, volume: 1, enabled: true,
      linkedOverlayId: "vid-x",
    },
    {
      id: "a-free", kind: "standalone", fileId: FILE_ID,
      startTime: 0, duration: 1, trimStart: 0, volume: 1, enabled: true,
    },
  ] as typeof m.audioClips;
  await saveManifest(PIECE_ID, m);
}

describe("export runner — hidden layers stripped before classify (agent path)", () => {
  let outDir: string;

  beforeEach(() => {
    captured.runs = [];
    createTestDb();
    createTempStorageDir();
    resetStorage();
    seedPiece(getDb() as never, { id: PIECE_ID });
    fs.mkdirSync(path.join(getLibiStorageDir(), PIECE_ID), { recursive: true });
    fs.writeFileSync(path.join(getLibiStorageDir(), PIECE_ID, "src.mp4"), new Uint8Array([0]));
    getDb().insert(files).values([
      {
        id: FILE_ID, pieceId: PIECE_ID, filename: "src.mp4", name: "src.mp4",
        description: "", type: "video", storagePath: `${PIECE_ID}/src.mp4`,
        contentType: "video/mp4", size: 1, mediaWidth: 320, mediaHeight: 240,
      },
    ]).run();
    outDir = path.join(getLibiStorageDir(), "export-out");
  });

  afterEach(() => {
    cleanupTempDir();
    resetTestDb();
    resetStorage();
  });

  it("CONTROL: a visible overlay + its coupled clip reach the render payload", async () => {
    await seedManifest({ hidden: false });
    const result = await exportRunner.run(fakeCtx(params(outDir)));
    expect(result.backend).toBe("chromium-render");
    expect(captured.runs).toHaveLength(1);
    const { composition, payload } = captured.runs[0];
    expect(composition.overlays?.map((o) => o.id)).toEqual(["vid-x"]);
    expect(payload.overlays.map((o) => o.id)).toEqual(["vid-x"]);
    expect(payload.audioClips.map((c) => (c as { id: string }).id)).toEqual([
      "a-coupled",
      "a-free",
    ]);
  });

  it("a manifest-hidden overlay + its coupled clip are absent from the classifier comp, render payload, and audio mux input", async () => {
    await seedManifest({ hidden: true });
    const result = await exportRunner.run(fakeCtx(params(outDir)));
    expect(result.backend).toBe("chromium-render");
    expect(captured.runs).toHaveLength(1);
    const { composition, payload } = captured.runs[0];
    // Classifier composition: hidden overlay + coupled clip gone.
    expect(composition.overlays ?? []).toHaveLength(0);
    expect(composition.audioClips?.map((c) => c.id)).toEqual(["a-free"]);
    // Render payload (what the /render page draws): hidden overlay gone.
    expect(payload.overlays).toHaveLength(0);
    // Audio mux input (payload.audioClips feeds muxAudioIntoRender in the
    // export_render runner): coupled clip gone, free clip kept.
    expect(payload.audioClips.map((c) => (c as { id: string }).id)).toEqual(["a-free"]);
    // The output file was written from the (stubbed) render blob.
    expect(fs.existsSync(result.filePath)).toBe(true);
  });
});
