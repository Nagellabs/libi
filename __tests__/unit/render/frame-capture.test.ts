import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { join } from "node:path";
import { computeVerifyDims, VERIFY_BITRATE_BPS, overlayFileIds } from "@/lib/render/frame-capture";
import type { Overlay } from "@/lib/engine/types";
import type { RenderPayload } from "@/lib/export/render-jobs";
import { createTempStorageDir, cleanupTempDir } from "../../helpers/test-storage";
import { createTestDb, resetTestDb } from "../../helpers/test-db";

let storageRoot: string;

vi.mock("@/lib/storage", () => ({
  getStorage: async () => {
    const { LocalFileStorage } = await import("@/lib/storage/local");
    return new LocalFileStorage(join(storageRoot, "storage"));
  },
}));

// The chromium render is the thing under test's OUTPUT, not its subject: what
// this file pins is the payload handed to it. Capture it and hand back a
// minimal MP4-shaped blob.
const { capturedPayloads } = vi.hoisted(() => ({ capturedPayloads: [] as RenderPayload[] }));
vi.mock("@/lib/export/backends/chromium-render", () => ({
  ChromiumRenderBackend: class {
    name = "chromium-render";
    async run(ctx: { payload: RenderPayload }) {
      capturedPayloads.push(ctx.payload);
      return { blob: new Blob([new Uint8Array([0, 0, 0, 1])]) };
    }
  },
}));

// No ffmpeg in a unit run; the frame extraction is not what is being pinned.
vi.mock("@/lib/ffmpeg/exec", () => ({ runFfmpeg: vi.fn(async () => ({ stdout: "", stderr: "" })) }));

describe("computeVerifyDims", () => {
  it("downscales 1080p to the height cap, even dims, preserves aspect", () => {
    const d = computeVerifyDims(1920, 1080, 720);
    expect(d.height).toBe(720);
    expect(d.width).toBe(1280);
    expect(d.width % 2).toBe(0);
    expect(d.height % 2).toBe(0);
  });

  it("never upscales a small source", () => {
    expect(computeVerifyDims(640, 480, 720)).toEqual({ width: 640, height: 480 });
  });

  it("handles portrait", () => {
    const d = computeVerifyDims(1080, 1920, 720);
    expect(d.height).toBe(1280);
    expect(d.width).toBe(720);
  });
});

describe("verify render bitrate", () => {
  it("uses a low vision-check bitrate (2 Mbps), not the export default", () => {
    // The verify MP4 exists only for the agent's frame extraction; 2 Mbps at
    // ≤720 short-side is fully legible and keeps the postback small + fast.
    expect(VERIFY_BITRATE_BPS).toBe(2_000_000);
  });
});

describe("overlayFileIds", () => {
  it("finds the file a TRACKED overlay mounts on its content, not just top-level ids", () => {
    // Two nesting levels, and the second is the one a `.map(o => o.fileId)`
    // misses in silence.
    const overlays = [
      { id: "v", kind: "video", fileId: "file-video" },
      { id: "t", kind: "tracked", trackId: "trk-1", content: { kind: "image", fileId: "file-mounted" } },
      { id: "c", kind: "code", drawFunction: "" },
    ] as unknown as Overlay[];
    expect(overlayFileIds(overlays).sort()).toEqual(["file-mounted", "file-video"]);
  });

  it("de-duplicates one file mounted by several overlays", () => {
    const overlays = [
      { id: "a", kind: "video", fileId: "same" },
      { id: "b", kind: "video", fileId: "same" },
    ] as unknown as Overlay[];
    expect(overlayFileIds(overlays)).toEqual(["same"]);
  });
});

/**
 * THE REGRESSION THIS FILE EXISTS FOR.
 *
 * `renderCompositionFrames` is a THIRD render path — the one behind
 * `libi.render_overlay_frames`, which the skills tell agents to use to look at
 * their own work. A tracked overlay's samples are in source-video pixels, and
 * `resolveTrackedSpace` needs `sourceWidth`/`sourceHeight` to map them into the
 * composition. The render page derives those from `payload.files` and nowhere
 * else — `buildComposition` rewrites every video overlay as
 * `{ …o, sourceWidth: file?.mediaWidth ?? null }`, unconditionally — so a file
 * absent from the payload is a video with null dims, no source to decode, and
 * any tracked art on it placed against a rect-fill guess.
 *
 * `files.piece_id` is nullable (the shared asset library), so "the piece's
 * files" is not the same set as "the files this composition mounts".
 */
describe("renderCompositionFrames — the payload the render page hydrates from", () => {
  const PIECE = "piece-verify-1";
  const PIECE_FILE = "file-in-piece";
  const GLOBAL_FILE = "file-global";

  beforeAll(async () => {
    storageRoot = createTempStorageDir();
    createTestDb();

    const { getDb } = await import("@/lib/db/client");
    const { files, pieces } = await import("@/lib/db/schema/sqlite");
    getDb().insert(pieces).values({ id: PIECE, name: "verify", description: "" }).run();
    const base = {
      name: "clip",
      description: "",
      type: "video",
      storagePath: "x",
      contentType: "video/mp4",
      size: 1,
    };
    getDb()
      .insert(files)
      .values([
        { ...base, id: PIECE_FILE, pieceId: PIECE, filename: "in-piece.mp4", mediaWidth: 1920, mediaHeight: 1080 },
        // pieceId omitted → a GLOBAL file, the asset-library case.
        { ...base, id: GLOBAL_FILE, filename: "global.mp4", mediaWidth: 3840, mediaHeight: 2160 },
      ])
      .run();

    const { saveManifest } = await import("@/lib/composition/persistence");
    await saveManifest(PIECE, {
      width: 1920,
      height: 1080,
      fps: 30,
      overlays: [
        {
          id: "vid-piece",
          kind: "video",
          startTime: 0,
          duration: 5,
          rect: { x: 0, y: 0, width: 640, height: 360 },
          z: 1,
          opacity: 1,
          fileId: PIECE_FILE,
        },
        {
          id: "vid-global",
          kind: "video",
          startTime: 0,
          duration: 5,
          rect: { x: 640, y: 0, width: 640, height: 360 },
          z: 2,
          opacity: 1,
          fileId: GLOBAL_FILE,
        },
      ],
      audioClips: [],
    } as never);
  });

  afterAll(() => {
    resetTestDb();
    cleanupTempDir();
  });

  it("hands the render page every file its overlays mount, piece-scoped or global", async () => {
    const { renderCompositionFrames } = await import("@/lib/render/frame-capture");
    await renderCompositionFrames(PIECE, [1], { outDir: join(storageRoot, "out") });

    expect(capturedPayloads).toHaveLength(1);
    const ids = new Set(capturedPayloads[0].files.map((f) => f.id));
    expect(ids.has(PIECE_FILE)).toBe(true);
    // The assertion that fails on a piece-scoped-only query.
    expect(ids.has(GLOBAL_FILE)).toBe(true);
  });

  it("survives the render page's own hydration with real source dims on BOTH videos", async () => {
    // End of the chain, asserted rather than assumed: run the payload through
    // the exact call `lib/export/render-entry.ts` makes and read the dims off
    // the result. Attaching dims to `payload.overlays` upstream would NOT pass
    // this — `buildComposition` overwrites them from `filesMap`.
    const { buildComposition } = await import("@/lib/composition/build-composition");
    const payload = capturedPayloads[0];
    const built = buildComposition(
      new Map(payload.files.map((f) => [f.id, f])),
      payload.overlays,
      payload.audioClips,
    );
    const dims = Object.fromEntries(
      (built!.overlays ?? [])
        .filter((o) => o.kind === "video")
        .map((o) => [o.id, [o.sourceWidth, o.sourceHeight]]),
    );
    expect(dims["vid-piece"]).toEqual([1920, 1080]);
    expect(dims["vid-global"]).toEqual([3840, 2160]);
  });
});
