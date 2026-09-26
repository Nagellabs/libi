/**
 * The ffmpeg-overlay export declares an UNTAGGED HD base — and every untagged
 * HD video overlay — as BT.709 before anything is composited.
 *
 * ffmpeg converts RGB overlays (drawtext, drawbox plates, image/video overlays)
 * into the base frame's YUV with the frame's matrix, and an untagged frame means
 * BT.601 to ffmpeg. The output stayed untagged, and the browser the preview runs
 * in (and QuickTime) read untagged HD as BT.709 — so a pure green overlay
 * exported as 0,216,0 where the preview drew 0,255,0. `setparams` is metadata
 * only: the base's YUV is untouched, the overlays convert with 709, and the
 * encoder writes the 709 tags into the output.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDb, resetTestDb, seedPiece } from "../../helpers/test-db";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/ffmpeg/exec", () => ({
  runFfmpeg: vi.fn(),
  resolveFfmpegPath: vi.fn(() => "/usr/bin/ffmpeg"),
  resolveFfprobePath: vi.fn(() => "/usr/bin/ffprobe"),
}));
vi.mock("@/lib/ffmpeg/probe", () => ({ probeMedia: vi.fn(async () => ({})) }));
vi.mock("@/lib/export/hw-accel", () => ({
  detectAvailableEncoders: vi.fn(async () => new Set<string>()),
  pickEncoder: vi.fn(() => "libx264"),
}));

import { getDb } from "@/lib/db/client";
import { runFfmpeg } from "@/lib/ffmpeg/exec";
import { probeMedia } from "@/lib/ffmpeg/probe";
import { files } from "@/lib/db/schema/sqlite";
import { exportLogger } from "@/lib/logger";
import { untaggedHdColorParams, untaggedSdToHdConversion } from "@/lib/export/untagged-color";
import { FfmpegOverlayBackend, buildFilterChain } from "@/lib/export/backends/ffmpeg-overlay";
import type { ExportContext } from "@/lib/export/backend";
import type { Composition, Overlay } from "@/lib/engine/types";

const SETPARAMS_709 = "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709";

describe("untaggedHdColorParams", () => {
  it("declares an untagged 1080p base BT.709 (matrix, primaries, transfer)", () => {
    expect(untaggedHdColorParams({ width: 1920, height: 1080, pixFmt: "yuv420p" })).toBe(SETPARAMS_709);
  });

  it("treats 720p, portrait HD and 4K the same", () => {
    for (const [width, height] of [[1280, 720], [720, 1280], [1080, 1920], [3840, 2160]]) {
      expect(untaggedHdColorParams({ width, height, pixFmt: "yuv420p" })).toBe(SETPARAMS_709);
    }
  });

  it("leaves an untagged SD base as today (players read it as BT.601, as ffmpeg does)", () => {
    for (const [width, height] of [[640, 480], [720, 480], [720, 576], [1024, 576], [640, 360]]) {
      expect(untaggedHdColorParams({ width, height, pixFmt: "yuv420p" })).toBeNull();
    }
  });

  it("carries a tagged base's own tags through unchanged", () => {
    expect(untaggedHdColorParams({ width: 1920, height: 1080, pixFmt: "yuv420p", colorSpace: "bt709" })).toBeNull();
    expect(untaggedHdColorParams({ width: 1920, height: 1080, pixFmt: "yuv420p", colorSpace: "smpte170m" })).toBeNull();
    expect(untaggedHdColorParams({ width: 1920, height: 1080, pixFmt: "yuv420p", colorSpace: "bt470bg" })).toBeNull();
  });

  it("fills only the unknown fields when the matrix is missing but primaries/transfer are tagged", () => {
    expect(
      untaggedHdColorParams({ width: 1920, height: 1080, pixFmt: "yuv420p", colorPrimaries: "bt709" }),
    ).toBe("setparams=colorspace=bt709:color_trc=bt709");
    expect(untaggedHdColorParams({ width: 1920, height: 1080, pixFmt: "yuv420p", colorTransfer: "bt709" })).toBe(
      "setparams=colorspace=bt709:color_primaries=bt709",
    );
  });

  it("declares nothing when the primaries are tagged as something other than BT.709 (a 709 matrix would be a guess against the tag)", () => {
    expect(
      untaggedHdColorParams({ width: 1920, height: 1080, pixFmt: "yuv420p", colorPrimaries: "bt2020", colorTransfer: "smpte2084" }),
    ).toBeNull();
    expect(untaggedHdColorParams({ width: 1920, height: 1080, pixFmt: "yuv420p", colorPrimaries: "bt470bg" })).toBeNull();
  });

  it("never declares a YUV matrix on an RGB or unknown pixel format, or unknown dimensions", () => {
    expect(untaggedHdColorParams({ width: 1920, height: 1080, pixFmt: "gbrp" })).toBeNull();
    expect(untaggedHdColorParams({ width: 1920, height: 1080, pixFmt: "rgb24" })).toBeNull();
    expect(untaggedHdColorParams({ width: 1920, height: 1080 })).toBeNull();
    expect(untaggedHdColorParams({ pixFmt: "yuv420p" })).toBeNull();
  });

  it("covers the other YUV layouts a base can decode to (10-bit, 4:2:2, alpha, full-range yuvj)", () => {
    for (const pixFmt of ["yuv420p10le", "yuv422p", "yuva420p", "yuvj420p"]) {
      expect(untaggedHdColorParams({ width: 1920, height: 1080, pixFmt })).toBe(SETPARAMS_709);
    }
  });
});

// ─── Untagged SD base, HD output (QA 2026-09-19 Q1) ─────────────────────────
// Text/code/3D raise the output to at least 1080p, so a 640×480 clip with one
// caption exports at 1440×1080. The base stayed untagged BT.601 while the file
// became HD — and every player reads untagged HD as BT.709, so the base, the
// overlays and every video overlay played shifted (green 0,214,0; base Δ30).
// The base's scale now converts 601 → 709 and the output is tagged 709.
const SD_TO_709 = { scaleArgs: ":in_color_matrix=bt601:out_color_matrix=bt709", params: SETPARAMS_709 };

describe("untaggedSdToHdConversion", () => {
  it("converts an untagged SD base to BT.709 when the output is HD (1080p, 4K, portrait)", () => {
    for (const [width, height] of [[1440, 1080], [1920, 1080], [2880, 2160], [1080, 1440]]) {
      expect(untaggedSdToHdConversion({ width: 640, height: 480, pixFmt: "yuv420p" }, { width, height })).toEqual(SD_TO_709);
    }
  });

  it("also when the output only leaves the unambiguous SD sizes (a player may read it either way)", () => {
    expect(untaggedSdToHdConversion({ width: 640, height: 480, pixFmt: "yuv420p" }, { width: 720, height: 540 })).toEqual(SD_TO_709);
    expect(untaggedSdToHdConversion({ width: 640, height: 360, pixFmt: "yuv420p" }, { width: 1024, height: 576 })).toEqual(SD_TO_709);
  });

  it("does nothing when the output stays SD — the untagged file reads as BT.601, as today", () => {
    for (const [width, height] of [[640, 480], [320, 240], [704, 576]]) {
      expect(untaggedSdToHdConversion({ width: 640, height: 480, pixFmt: "yuv420p" }, { width, height })).toBeNull();
    }
  });

  it("leaves HD, in-between, tagged, non-YUV and unknown bases to the other rules", () => {
    const hd = { width: 1920, height: 1080 };
    expect(untaggedSdToHdConversion({ width: 1920, height: 1080, pixFmt: "yuv420p" }, hd)).toBeNull();
    expect(untaggedSdToHdConversion({ width: 720, height: 480, pixFmt: "yuv420p" }, hd)).toBeNull();
    expect(untaggedSdToHdConversion({ width: 720, height: 576, pixFmt: "yuv420p" }, hd)).toBeNull();
    expect(untaggedSdToHdConversion({ width: 640, height: 480, pixFmt: "yuv420p", colorSpace: "smpte170m" }, hd)).toBeNull();
    expect(untaggedSdToHdConversion({ width: 640, height: 480, pixFmt: "yuv420p", colorSpace: "bt709" }, hd)).toBeNull();
    expect(untaggedSdToHdConversion({ width: 640, height: 480, pixFmt: "rgb24" }, hd)).toBeNull();
    expect(untaggedSdToHdConversion({ width: 640, height: 480 }, hd)).toBeNull();
    expect(untaggedSdToHdConversion({ pixFmt: "yuv420p" }, hd)).toBeNull();
  });

  it("keeps a tagged transfer, and gives up on primaries other than smpte170m / bt709", () => {
    expect(
      untaggedSdToHdConversion({ width: 640, height: 480, pixFmt: "yuv420p", colorTransfer: "smpte170m" }, { width: 1440, height: 1080 }),
    ).toEqual({ ...SD_TO_709, params: "setparams=colorspace=bt709:color_primaries=bt709" });
    expect(
      untaggedSdToHdConversion({ width: 640, height: 480, pixFmt: "yuv420p", colorPrimaries: "smpte170m" }, { width: 1440, height: 1080 }),
    ).toEqual({ ...SD_TO_709, params: "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709" });
    expect(
      untaggedSdToHdConversion({ width: 640, height: 480, pixFmt: "yuv420p", colorPrimaries: "bt470bg" }, { width: 1440, height: 1080 }),
    ).toBeNull();
  });

  it("covers full-range yuvj and 10-bit SD sources (scale keeps the range)", () => {
    for (const pixFmt of ["yuvj420p", "yuv420p10le", "yuv422p"]) {
      expect(untaggedSdToHdConversion({ width: 640, height: 480, pixFmt }, { width: 1440, height: 1080 })).toEqual(SD_TO_709);
    }
  });
});

describe("buildFilterChain — base colour stage", () => {
  const text = {
    id: "t", kind: "text", content: "Hi", font: "48px Inter", color: "#00ff00",
    align: "center", opacity: 1, startTime: 0, duration: 1, z: 1,
    rect: { x: 0, y: 0, width: 400, height: 100 },
  } as unknown as Overlay;

  it("puts the setparams stage on [0:v] BEFORE the fit scale, so every overlay converts with it", () => {
    const graph = buildFilterChain([text], new Map(), {
      width: 1920, height: 1080, baseFit: "cover", baseColorParams: SETPARAMS_709,
    });
    expect(graph.startsWith(`[0:v]${SETPARAMS_709},scale=1920:1080:force_original_aspect_ratio=increase,`)).toBe(true);
  });

  it("also on the contain path and the no-overlay passthrough", () => {
    expect(
      buildFilterChain([text], new Map(), { width: 1920, height: 1080, baseColorParams: SETPARAMS_709 }),
    ).toMatch(/^\[0:v\]setparams=[^,]+,scale=1920:1080:force_original_aspect_ratio=decrease,pad=/);
    expect(
      buildFilterChain([], new Map(), { width: 1920, height: 1080, baseColorParams: SETPARAMS_709 }),
    ).toMatch(/^\[0:v\]setparams=[^,]+,scale=/);
  });

  it("declares an untagged HD VIDEO overlay on its own input, before its rect scale", () => {
    const video = {
      id: "v", kind: "video", fileId: "fv", startTime: 0, duration: 1, z: 2, opacity: 1, fit: "cover",
      rect: { x: 10, y: 20, width: 640, height: 360 },
    } as unknown as Overlay;
    const graph = buildFilterChain([text, video], new Map([["v", 1]]), {
      width: 1920, height: 1080, baseColorParams: SETPARAMS_709,
      assetColorParams: new Map([["v", SETPARAMS_709]]),
    });
    expect(graph).toContain(`[1:v]${SETPARAMS_709},scale=640:360:force_original_aspect_ratio=increase,crop=640:360[`);
    // …and an asset without an entry is untouched
    const plain = buildFilterChain([video], new Map([["v", 1]]), { width: 1920, height: 1080 });
    expect(plain).toContain("[1:v]scale=640:360:");
  });

  it("an SD→HD conversion rides on the base's fit scale and tags the result, on both fit paths", () => {
    const contain = buildFilterChain([text], new Map(), { width: 640, height: 480, targetWidth: 1440, targetHeight: 1080, baseScaleColor: SD_TO_709 });
    expect(contain.startsWith(
      `[0:v]scale=1440:1080:force_original_aspect_ratio=decrease:in_color_matrix=bt601:out_color_matrix=bt709,` +
      `pad=1440:1080:(ow-iw)/2:(oh-ih)/2:black,setsar=1,${SETPARAMS_709}[base]`,
    )).toBe(true);
    const cover = buildFilterChain([text], new Map(), {
      width: 640, height: 480, targetWidth: 1440, targetHeight: 1080, baseFit: "cover", baseScaleColor: SD_TO_709,
    });
    expect(cover.startsWith(
      `[0:v]scale=1440:1080:force_original_aspect_ratio=increase:in_color_matrix=bt601:out_color_matrix=bt709,` +
      `crop=1440:1080,setsar=1,${SETPARAMS_709}[base]`,
    )).toBe(true);
  });

  it("is unchanged when there is nothing to declare", () => {
    const graph = buildFilterChain([text], new Map(), { width: 1920, height: 1080, baseFit: "cover" });
    expect(graph.startsWith("[0:v]scale=1920:1080:")).toBe(true);
    expect(graph).not.toContain("setparams");
  });
});

describe("FfmpegOverlayBackend — probes the base and declares its colour", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-base-color-"));
    process.env.LIBI_HOME = tmp;
    delete process.env.STORAGE_DIR;
    const db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    seedPiece(db as never, { id: "p" });
    db.insert(files).values({
      id: "base", pieceId: "p", filename: "base.mp4", name: "base.mp4", description: "",
      type: "video", storagePath: "p/base.mp4", size: 1, hasAlpha: false,
    }).run();
  });
  afterEach(() => {
    resetTestDb();
    delete process.env.LIBI_HOME;
    fs.rmSync(tmp, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  async function exportArgs(
    extraOverlays: unknown[] = [],
    comp = { width: 1920, height: 1080 },
    out = { width: 1920, height: 1080 },
  ): Promise<string[]> {
    const composition = {
      id: "c", name: "c", width: comp.width, height: comp.height, fps: 30,
      overlays: [
        {
          id: "b", kind: "video", fileId: "base", videoUrl: "", startTime: 0, duration: 2, z: 0,
          opacity: 1, fit: "cover", rect: { x: 0, y: 0, width: comp.width, height: comp.height },
        },
        {
          id: "t", kind: "text", content: "Hi", font: "48px Inter", color: "#00ff00", align: "center",
          opacity: 1, startTime: 0, duration: 2, z: 1, rect: { x: 0, y: 0, width: 400, height: 100 },
        },
        ...extraOverlays,
      ],
    } as unknown as Composition;
    const outputPath = path.join(tmp, "out.mp4");
    vi.mocked(runFfmpeg).mockImplementation(async () => {
      fs.writeFileSync(outputPath, Buffer.alloc(16));
      return { stdout: "", stderr: "" };
    });
    await new FfmpegOverlayBackend().run({
      composition,
      settings: { format: "mp4", codec: "avc", bitrate: 4_000_000, width: out.width, height: out.height, fps: 30 },
      outputPath,
    } as ExportContext);
    return vi.mocked(runFfmpeg).mock.calls[0][0] as string[];
  }

  const graphOf = (args: string[]) => args[args.indexOf("-filter_complex") + 1];

  it("an untagged 1080p base gets the 709 declaration in the graph", async () => {
    vi.mocked(probeMedia).mockResolvedValue({ width: 1920, height: 1080, pixFmt: "yuv420p" });
    const args = await exportArgs();
    expect(vi.mocked(probeMedia)).toHaveBeenCalledWith(expect.stringMatching(/base\.mp4$/));
    expect(graphOf(args).startsWith(`[0:v]${SETPARAMS_709},scale=`)).toBe(true);
  });

  it("probes each video overlay and declares the untagged HD ones; SD and tagged ones are left alone", async () => {
    const db = vi.mocked(getDb)() as ReturnType<typeof createTestDb>;
    for (const id of ["vhd", "vsd", "v709"]) {
      db.insert(files).values({
        id, pieceId: "p", filename: `${id}.mp4`, name: id, description: "", type: "video",
        storagePath: `p/${id}.mp4`, size: 1, hasAlpha: false,
      }).run();
    }
    vi.mocked(probeMedia).mockImplementation(async (p: string) => {
      if (p.endsWith("vsd.mp4")) return { width: 640, height: 480, pixFmt: "yuv420p" };
      if (p.endsWith("v709.mp4")) return { width: 1920, height: 1080, pixFmt: "yuv420p", colorSpace: "bt709" };
      return { width: 1920, height: 1080, pixFmt: "yuv420p" }; // base.mp4, vhd.mp4
    });
    const ov = (id: string, z: number) => ({
      id: `o-${id}`, kind: "video", fileId: id, videoUrl: "", startTime: 0, duration: 2, z, opacity: 1,
      fit: "cover", rect: { x: 0, y: 0, width: 320, height: 180 },
    });
    const info = vi.spyOn(exportLogger, "info");
    const graph = graphOf(await exportArgs([ov("vhd", 2), ov("vsd", 3), ov("v709", 4)]));
    // logged ONCE, naming the inputs (never a path)
    const declares = info.mock.calls.filter((c) => (c[0] as { op?: string }).op === "color_declare");
    expect(declares).toHaveLength(1);
    expect((declares[0][0] as { inputs: unknown }).inputs).toEqual([
      { input: 0, role: "base", params: SETPARAMS_709 },
      { input: 1, role: "video-overlay", overlayId: "o-vhd", params: SETPARAMS_709 },
    ]);
    expect(JSON.stringify(declares[0])).not.toMatch(/\.mp4/);
    info.mockRestore();
    expect(graph).toContain(`[1:v]${SETPARAMS_709},scale=320:180:`);
    expect(graph).toContain("[2:v]scale=320:180:");
    expect(graph).toContain("[3:v]scale=320:180:");
  });

  it("an untagged SD base exported at HD size is converted to 709 on its scale, and logged", async () => {
    vi.mocked(probeMedia).mockResolvedValue({ width: 640, height: 480, pixFmt: "yuv420p" });
    const info = vi.spyOn(exportLogger, "info");
    const graph = graphOf(await exportArgs([], { width: 640, height: 480 }, { width: 1440, height: 1080 }));
    expect(graph.startsWith(
      `[0:v]scale=1440:1080:force_original_aspect_ratio=increase:in_color_matrix=bt601:out_color_matrix=bt709,crop=1440:1080,setsar=1,${SETPARAMS_709}[base]`,
    )).toBe(true);
    const declares = info.mock.calls.filter((c) => (c[0] as { op?: string }).op === "color_declare");
    expect((declares[0][0] as { inputs: unknown }).inputs).toEqual([
      { input: 0, role: "base", convert: "bt601->bt709", params: SETPARAMS_709 },
    ]);
    info.mockRestore();
  });

  it("the same SD base exported at SD size is left as it was", async () => {
    vi.mocked(probeMedia).mockResolvedValue({ width: 640, height: 480, pixFmt: "yuv420p" });
    const graph = graphOf(await exportArgs([], { width: 640, height: 480 }, { width: 640, height: 480 }));
    expect(graph).not.toContain("setparams");
    expect(graph).not.toContain("color_matrix");
  });

  it("a tagged base, or a failed probe, leaves the graph as it was", async () => {
    vi.mocked(probeMedia).mockResolvedValue({ width: 1920, height: 1080, pixFmt: "yuv420p", colorSpace: "bt709" });
    expect(graphOf(await exportArgs())).not.toContain("setparams");
    vi.mocked(runFfmpeg).mockClear();
    vi.mocked(probeMedia).mockResolvedValue({});
    expect(graphOf(await exportArgs())).not.toContain("setparams");
  });
});
