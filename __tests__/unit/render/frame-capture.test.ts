import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { join } from "node:path";
import { computeVerifyDims, VERIFY_BITRATE_BPS, verifyBitrate, overlayFileIds } from "@/lib/render/frame-capture";
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

  it("stays at 2 Mbps up to 720 x 1280 and grows with the pixels above it (a region's render), capped", () => {
    expect(verifyBitrate(720, 1280)).toBe(2_000_000);
    expect(verifyBitrate(360, 640)).toBe(2_000_000);
    expect(verifyBitrate(1080, 1920)).toBe(4_500_000);
    expect(verifyBitrate(3840, 2160)).toBe(12_000_000);
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
      { width: payload.width, height: payload.height, fps: payload.fps },
    );
    const dims = Object.fromEntries(
      (built!.overlays ?? [])
        .filter((o) => o.kind === "video")
        .map((o) => [o.id, [o.sourceWidth, o.sourceHeight]]),
    );
    expect(dims["vid-piece"]).toEqual([1920, 1080]);
    expect(dims["vid-global"]).toEqual([3840, 2160]);
  });

  it("2 times out of a 150-frame piece: the payload asks for 2 frames, and each PNG is cut from its own index", async () => {
    const { renderCompositionFrames } = await import("@/lib/render/frame-capture");
    const { runFfmpeg } = await import("@/lib/ffmpeg/exec");
    const ffmpeg = vi.mocked(runFfmpeg);
    ffmpeg.mockClear();
    capturedPayloads.length = 0;
    // Out of order and with a duplicate frame: 1.01 s and 1.02 s are both frame 31.
    const frames = await renderCompositionFrames("piece-verify-1", [4, 1.01, 1.02], { outDir: join(storageRoot, "out2") });

    expect(capturedPayloads).toHaveLength(1);
    expect(capturedPayloads[0].frames).toEqual([31, 120]);
    expect(frames.map((f) => f.time)).toEqual([1.01, 1.02, 4]);
    const selected = ffmpeg.mock.calls.map(([args]) => args[args.indexOf("-vf") + 1]);
    expect(selected).toEqual(["select=eq(n\\,0)", "select=eq(n\\,0)", "select=eq(n\\,1)"]);
    expect(ffmpeg.mock.calls.map(([, o]) => (o as { op: string }).op)).toEqual(Array(3).fill("render_verify_frame"));
  });

  it("N1: every captured frame names the absolute frame it drew", async () => {
    const { renderCompositionFrames } = await import("@/lib/render/frame-capture");
    capturedPayloads.length = 0;
    const frames = await renderCompositionFrames("piece-verify-1", [0.067, 4.99], { outDir: join(storageRoot, "out3") });
    expect(capturedPayloads[0].frames).toEqual([2, 149]);
    expect(frames.map((f) => [f.time, f.frame])).toEqual([[0.067, 2], [4.99, 149]]);
  });

  it("N2: a time at or past the end is refused per time, naming the duration and the last valid time — nothing is rendered", async () => {
    const { renderCompositionFrames, FrameTimesOutOfRangeError } = await import("@/lib/render/frame-capture");
    capturedPayloads.length = 0;
    const err = await renderCompositionFrames("piece-verify-1", [1, 5, 60], { outDir: join(storageRoot, "out4") }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FrameTimesOutOfRangeError);
    const e = err as InstanceType<typeof FrameTimesOutOfRangeError>;
    expect(e.duration).toBe(5);
    expect(e.lastValidTime).toBe(4.967);
    expect(e.errors.map((x) => x.time)).toEqual([5, 60]);
    for (const x of e.errors) {
      expect(x.error).toContain("5 s");
      expect(x.error).toContain("4.967");
    }
    expect(e.message).toContain("4.967");
    expect(capturedPayloads).toHaveLength(0);
  });
});

/**
 * Task 12b review, controller follow-up: the verify render asks the render
 * page for the requested frames only, then takes frame i of the short file it
 * gets back — not a whole-piece MP4 cut at `-ss t`.
 */
describe("renderCompositionFrames — renders only the requested frames", () => {
  it("frameForTime picks the frame `ffmpeg -ss t` picked from the whole-piece render: the first frame at or after t", async () => {
    const { frameForTime } = await import("@/lib/render/frame-capture");
    expect(frameForTime(0, 30, 150)).toBe(0);
    expect(frameForTime(1, 30, 150)).toBe(30);
    expect(frameForTime(0.1, 30, 150)).toBe(3); // 0.1 × 30 is 3.0000000000000004 in floats
    expect(frameForTime(0.0333, 30, 150)).toBe(1);
    // More than 1 ms past a frame's time: the next frame, as `-ss` picked.
    expect(frameForTime(0.035, 30, 150)).toBe(2);
    expect(frameForTime(1.01, 30, 150)).toBe(31);
    // Before the end but after the last frame's time: the last frame is what is on screen.
    expect(frameForTime(4.99, 30, 150)).toBe(149);
  });

  it("N1: within 1 ms of a frame's time is THAT frame — the ms-rounded time a diagnostic reports names its own frame", async () => {
    const { frameForTime } = await import("@/lib/render/frame-capture");
    // 30 fps frame 2 is reported as 0.067; 0.067 × 30 = 2.01 used to ceil to frame 3.
    expect(frameForTime(0.067, 30, 150)).toBe(2);
    expect(frameForTime(0.0334, 30, 150)).toBe(1);
    const misses: string[] = [];
    for (const fps of [24, 25, 30, 60]) {
      const totalFrames = 5 * fps;
      for (let f = 0; f < totalFrames; f++) {
        const reported = Math.round((f / fps) * 1000) / 1000; // what buildExportDiagnosticsReport sends
        const back = frameForTime(reported, fps, totalFrames);
        if (back !== f) misses.push(`${fps} fps frame ${f} → ${reported} → ${back}`);
      }
    }
    expect(misses).toEqual([]);
  });

  it("N3: a preview diagnostic on an overlay with an unaligned start names a time that renders its own frame, and that frame draws the failing local frame", async () => {
    const { frameForTime } = await import("@/lib/render/frame-capture");
    const { compositionFrameAt, elementTiming } = await import("@/lib/engine/overlay-timing");
    // The finding's example: start 0.1 s at 24 fps is 2.4 frames in, so local
    // frame 1 is composition frame 3 (0.125 s), not 0.1 + 1/24 = 0.142 s → 4.
    expect(compositionFrameAt(1, 0.1, 24)).toEqual({ frame: 3, time: 0.125 });
    const misses: string[] = [];
    // 0.1 @ 24 and 0.01 @ 30 are the finding's unaligned starts; 0.1 @ 25 and
    // 0.3 @ 25 fall exactly half a frame in, where the nearest composition
    // frame belongs to the NEXT local frame; 0 @ 30 is the aligned baseline.
    for (const [start, fps] of [[0.1, 24], [0.01, 30], [0.1, 25], [0.3, 25], [0, 30]]) {
      const totalFrames = 10 * fps;
      // What the export draws on each composition frame. At a half-frame start
      // float noise in `elementTiming` skips the odd local frame (0.1 s @ 25:
      // frame 3 draws local 0, frame 4 local 2) — no frame can name those, so
      // for them only the time ↔ frame round trip is required.
      const drawnOn = (g: number) => elementTiming(g / fps, fps, start, 5).frame;
      const drawable = new Set(Array.from({ length: totalFrames }, (_, g) => drawnOn(g)));
      for (let local = 0; local < 5 * fps; local++) {
        const { frame, time } = compositionFrameAt(local, start, fps);
        const rendered = frameForTime(time, fps, totalFrames);
        const drawn = drawnOn(rendered);
        if (rendered !== frame || (drawable.has(local) && drawn !== local)) {
          misses.push(`${start}s @ ${fps} local ${local} → ${time} s / frame ${frame} → renders ${rendered}, draws local ${drawn}`);
        }
      }
    }
    expect(misses).toEqual([]);
  });

  it("N2: the last valid time it names renders the last frame", async () => {
    const { frameForTime, lastValidTime } = await import("@/lib/render/frame-capture");
    for (const fps of [24, 25, 30, 60]) {
      expect(frameForTime(lastValidTime(fps, 5 * fps), fps, 5 * fps)).toBe(5 * fps - 1);
    }
  });
});
