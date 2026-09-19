/**
 * QA 2026-09-18 N3: the ffmpeg drawtext export emitted only `font=<family>`,
 * so `fontWeight: "bold"` was dropped, and where fontconfig couldn't resolve
 * the family (the bundled macOS ffmpeg ships without a fontconfig config) the
 * text came out in an unrelated fallback face. The preview draws with libi's
 * bundled files (`lib/fonts/bundled.ts`), so the export now resolves the
 * same file by family + weight and hands drawtext its path.
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
vi.mock("@/lib/ffmpeg/probe", () => ({ probeMedia: vi.fn(async () => ({ videoCodec: "h264", hasAlpha: false })) }));
const graphFile = vi.hoisted(() => ({ supported: false, failWrite: false, dirs: [] as string[] }));
vi.mock("@/lib/ffmpeg/filter-script", async (orig) => ({
  ...(await orig<typeof import("@/lib/ffmpeg/filter-script")>()),
  supportsFilterFileOption: vi.fn(async () => graphFile.supported),
  filterGraphArgs: vi.fn(async (graph: string, dir: string, supportsFile: boolean) => {
    graphFile.dirs.push(dir);
    if (graphFile.failWrite) throw new Error("ENOSPC: no space left on device");
    const real = await vi.importActual<typeof import("@/lib/ffmpeg/filter-script")>("@/lib/ffmpeg/filter-script");
    return real.filterGraphArgs(graph, dir, supportsFile);
  }),
}));
vi.mock("@/lib/export/hw-accel", () => ({
  detectAvailableEncoders: vi.fn(async () => ({})),
  pickEncoder: vi.fn(() => "libx264"),
}));

import { getDb } from "@/lib/db/client";
import { runFfmpeg } from "@/lib/ffmpeg/exec";
import { files } from "@/lib/db/schema/sqlite";
import { FfmpegOverlayBackend } from "@/lib/export/backends/ffmpeg-overlay";
import type { ExportContext } from "@/lib/export/backend";
import type { Composition } from "@/lib/engine/types";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-ffov-font-"));
  process.env.LIBI_HOME = tmp;
  delete process.env.STORAGE_DIR;
  const db = createTestDb();
  vi.mocked(getDb).mockReturnValue(db as never);
  seedPiece(db as never, { id: "p" });
  db.insert(files)
    .values({ id: "base", pieceId: "p", filename: "clip.mp4", name: "clip.mp4", description: "", type: "video", storagePath: "p/clip.mp4", size: 1 })
    .run();
});
afterEach(() => {
  graphFile.supported = false;
  graphFile.failWrite = false;
  for (const d of graphFile.dirs) if (d) fs.rmSync(d, { recursive: true, force: true });
  graphFile.dirs = [];
  resetTestDb();
  delete process.env.LIBI_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.clearAllMocks();
  vi.mocked(runFfmpeg).mockReset();
});

async function filterFor(text: Record<string, unknown>, extra = 0): Promise<string> {
  await runExport(text, extra);
  const args = vi.mocked(runFfmpeg).mock.calls[0][0] as string[];
  return args[args.indexOf("-filter_complex") + 1];
}

async function runExport(text: Record<string, unknown>, extra = 0): Promise<void> {
  const composition = {
    id: "c", name: "c", width: 1080, height: 1920, fps: 30,
    overlays: [
      {
        id: "s1", kind: "video", fileId: "base", videoUrl: "", startTime: 0, duration: 2, z: 0, opacity: 1,
        fit: "cover", rect: { x: 0, y: 0, width: 1080, height: 1920 },
      },
      {
        id: "t1", kind: "text", startTime: 0, duration: 2, z: 1, opacity: 1,
        rect: { x: 90, y: 800, width: 900, height: 300 }, content: "STROKE QA",
        font: "48px Inter", color: "#ffffff", align: "center",
        ...text,
      },
      // Extra caption cues, for the argv-length check.
      ...Array.from({ length: extra }, (_, i) => ({
        id: `cue${i}`, kind: "text", startTime: i * 0.1, duration: 0.1, z: 2 + i, opacity: 1,
        rect: { x: 90, y: 1500, width: 900, height: 200 }, // One line: a longer cue wraps (as the preview wraps it), and each
        // line is its own drawtext — see drawtext-caption-fidelity.test.ts.
        content: `Cue ${i} says hello`,
        font: "48px Inter", fontSize: 64, fontWeight: 700, color: "#ffffff", align: "center",
        stroke: { color: "#000000", width: 6 },
      })),
    ],
    audioClips: [],
  } as unknown as Composition;
  const outputPath = path.join(tmp, "out.mp4");
  if (!vi.mocked(runFfmpeg).getMockImplementation()) {
    vi.mocked(runFfmpeg).mockImplementation(async () => {
      fs.writeFileSync(outputPath, Buffer.alloc(16));
      return { stdout: "", stderr: "" };
    });
  }
  await new FfmpegOverlayBackend().run({
    composition,
    settings: { format: "mp4", codec: "avc", bitrate: 4_000_000, width: 1080, height: 1920, fps: 30 },
    outputPath,
  } as ExportContext);
}

const FONTS_DIR = path.join(process.cwd(), "public", "fonts", "2d");

describe("FfmpegOverlayBackend — text draws with the bundled face the preview uses", () => {
  it("bold Inter → Inter-Bold.ttf", async () => {
    const chain = await filterFor({ fontSize: 120, fontWeight: "bold" });
    expect(chain).toContain("fontfile='Inter-Bold.ttf'");
    expect(chain).not.toMatch(/:font=/);
  });

  it("a weight in the shorthand counts too", async () => {
    const chain = await filterFor({ font: "800 64px Inter" });
    expect(chain).toContain("fontfile='Inter-ExtraBold.ttf'");
  });

  it("no weight → Inter-Regular.ttf", async () => {
    const chain = await filterFor({});
    expect(chain).toContain("fontfile='Inter-Regular.ttf'");
  });

  it("a family libi doesn't ship keeps the fontconfig family lookup", async () => {
    const chain = await filterFor({ fontFamily: "Anton", fontWeight: 700 });
    expect(chain).toContain("font='Anton'");
    expect(chain).not.toContain("fontfile=");
  });

  // Re-review of a46beac8 (IMPORTANT 2): an absolute fontfile on every caption
  // (~130 chars each, and every Windows path needs escaping on top) pushed a
  // captioned export past Windows' 32,767-char command line at ~85 cues. The
  // bundled face is named relative to an EXPLICIT spawn cwd — the fonts dir —
  // rather than relying on whatever cwd the server inherited.
  it("names the bundled face relative to an explicit spawn cwd", async () => {
    await filterFor({ fontWeight: 700 });
    const opts = vi.mocked(runFfmpeg).mock.calls[0][1] as { cwd?: string };
    expect(opts.cwd).toBe(FONTS_DIR);
    const args = vi.mocked(runFfmpeg).mock.calls[0][0] as string[];
    // Everything else on the command line stays absolute, so the cwd change
    // can't redirect an input or the output.
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-i") expect(path.isAbsolute(args[i + 1])).toBe(true);
    }
    expect(path.isAbsolute(args[args.length - 1])).toBe(true);
  });

  it("a 100-cue captioned export stays well inside Windows' command-line limit", async () => {
    await filterFor({}, 100);
    const args = vi.mocked(runFfmpeg).mock.calls[0][0] as string[];
    const cmdLine = args.join(" ").length;
    expect(cmdLine).toBeLessThan(32_767);
    // The font adds a short, fixed token per cue — not a path.
    const chain = args[args.indexOf("-filter_complex") + 1];
    expect(chain).not.toContain(FONTS_DIR);
  });

  // Windows command-line headroom (QA recheck 4b): with an ffmpeg that reads
  // option values from files (-/filter_complex, 7.0+), a long graph leaves
  // argv, and its file is removed once ffmpeg is done.
  it("passes a long graph as -/filter_complex <file> and removes the file afterwards", async () => {
    graphFile.supported = true;
    let fileSeen = "";
    let graphInFile = "";
    vi.mocked(runFfmpeg).mockImplementation(async (a: string[]) => {
      fileSeen = a[a.indexOf("-/filter_complex") + 1];
      graphInFile = fs.readFileSync(fileSeen, "utf-8");
      fs.writeFileSync(a[a.length - 1], Buffer.alloc(16));
      return { stdout: "", stderr: "" };
    });
    await runExport({}, 400);
    const args = vi.mocked(runFfmpeg).mock.calls[0][0] as string[];
    expect(args).not.toContain("-filter_complex");
    expect(graphInFile).toContain("drawtext=text='Cue 399 says hello'");
    expect(args.join(" ").length).toBeLessThan(2_000);
    expect(fs.existsSync(fileSeen)).toBe(false);
  });

  it("keeps the graph inline when the ffmpeg can't read it from a file", async () => {
    graphFile.supported = false;
    await runExport({}, 400);
    const args = vi.mocked(runFfmpeg).mock.calls[0][0] as string[];
    expect(args).toContain("-filter_complex");
  });

  // A failed ffmpeg run keeps its graph file for debugging — the logged argv
  // only names it — and the error carries its path for the fail log.
  it("keeps the graph file when ffmpeg fails and reports its path on the error", async () => {
    graphFile.supported = true;
    vi.mocked(runFfmpeg).mockImplementation(async () => {
      throw new Error("ffmpeg exited with code 234");
    });
    const err = (await runExport({}, 400).then(
      () => undefined,
      (e: unknown) => e,
    )) as Error & { graphFile?: string };
    expect(err).toBeInstanceOf(Error);
    expect(err.graphFile).toMatch(/filter_complex\.txt$/);
    expect(fs.readFileSync(err.graphFile!, "utf-8")).toContain("drawtext=");
  });

  it("removes the scratch dir when writing the graph file fails", async () => {
    graphFile.supported = true;
    graphFile.failWrite = true;
    await expect(runExport({}, 400)).rejects.toThrow("ENOSPC");
    expect(graphFile.dirs).toHaveLength(1);
    expect(fs.existsSync(graphFile.dirs[0])).toBe(false);
  });
});

