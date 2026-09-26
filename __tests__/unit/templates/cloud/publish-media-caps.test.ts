// __tests__/unit/templates/cloud/publish-media-caps.test.ts
// The size-cap retry ladder, with ffmpeg replaced by a writer of chosen sizes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ffmpeg/exec", () => ({ runFfmpeg: vi.fn() }));
vi.mock("@/lib/ffmpeg/probe", () => ({ probeMedia: vi.fn(), probeMediaResult: vi.fn() }));
import { runFfmpeg } from "@/lib/ffmpeg/exec";
import { probeMedia, probeMediaResult } from "@/lib/ffmpeg/probe";
import { CAPS } from "@/lib/templates/cloud/constants";
import { EXAMPLE_OP, POSTER_OP, makePoster, transcodeExample } from "@/lib/templates/cloud/publish-media";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-publish-media-caps-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Each ffmpeg run writes its output (the last arg) at the next size in `sizes`. */
function ffmpegWrites(sizes: number[]): void {
  let i = 0;
  vi.mocked(runFfmpeg).mockImplementation(async (args) => {
    fs.writeFileSync(args[args.length - 1], Buffer.alloc(sizes[i++] ?? 0));
    return { stdout: "", stderr: "" };
  });
}

const SRC = path.join(dir, "in.mp4");
type Probed = Awaited<ReturnType<typeof probeMedia>>;
/** The source probes as `source`; each output read-back takes the next of `outputs` (the last repeats). */
function probes(source: Probed, outputs: Probed[] = [{ duration: 15, width: 1280, height: 720 }]): void {
  let i = 0;
  vi.mocked(probeMedia).mockImplementation(async (p) => (p === SRC ? source : outputs[Math.min(i++, outputs.length - 1)]));
}

beforeEach(() => {
  vi.mocked(runFfmpeg).mockReset();
  vi.mocked(probeMedia).mockReset();
  // The source is probed through probeMediaResult (a failure is not "no video"); read-backs through probeMedia.
  vi.mocked(probeMediaResult).mockReset();
  vi.mocked(probeMediaResult).mockImplementation(async (p) => ({ ok: true, media: await probeMedia(p) }));
  probes({ duration: 30, width: 1280, height: 720, hasAlpha: false, frameRate: 30 });
});

const arg = (call: number, name: string) => {
  const args = vi.mocked(runFfmpeg).mock.calls[call][0];
  return args[args.indexOf(name) + 1];
};

describe("example size cap", () => {
  it("retries once at the higher CRF when the first pass is over 8 MB, and uses the fixed op", async () => {
    ffmpegWrites([CAPS.example + 1, CAPS.example]);
    const r = await transcodeExample(SRC, path.join(dir, "a.mp4"));
    expect(r.bytes).toBe(CAPS.example);
    expect(vi.mocked(runFfmpeg)).toHaveBeenCalledTimes(2);
    expect([arg(0, "-crf"), arg(1, "-crf")]).toEqual(["26", "32"]);
    for (const [, opts] of vi.mocked(runFfmpeg).mock.calls) expect(opts.op).toBe(EXAMPLE_OP);
    expect(EXAMPLE_OP).toBe("template_example");
    // Progress is measured against the trimmed length, not the 30 s source.
    expect(vi.mocked(runFfmpeg).mock.calls[0][1].totalDurationSeconds).toBeCloseTo(15 - 1 / 30, 6);
  });
  it("throws naming the 8 MB cap when the retry is still over it", async () => {
    ffmpegWrites([CAPS.example + 1, CAPS.example + 1]);
    await expect(transcodeExample(SRC, path.join(dir, "b.mp4"))).rejects.toThrow(/8 MB/);
    expect(vi.mocked(runFfmpeg)).toHaveBeenCalledTimes(2);
  });
  it("passes the abort signal to every ffmpeg run", async () => {
    ffmpegWrites([CAPS.example + 1, 10]);
    const ac = new AbortController();
    await transcodeExample(SRC, path.join(dir, "c.mp4"), { signal: ac.signal });
    for (const [, opts] of vi.mocked(runFfmpeg).mock.calls) expect(opts.signal).toBe(ac.signal);
  });
  it("probes the source for alpha and flattens it on both passes", async () => {
    probes({ duration: 2, width: 320, height: 240, hasAlpha: true, videoCodec: "vp9" }, [{ duration: 2, width: 320, height: 240 }]);
    ffmpegWrites([CAPS.example + 1, 10]);
    await transcodeExample(SRC, path.join(dir, "d.mp4"));
    for (const [args] of vi.mocked(runFfmpeg).mock.calls) {
      expect(args.slice(0, 4)).toEqual(["-y", "-c:v", "libvpx-vp9", "-i"]);
      expect(args[args.indexOf("-vf") + 1]).toMatch(/^format=rgba,premultiply=inplace=1,scale=iw\*sar:ih,setsar=1,/);
    }
  });
  it("caps the bitrate on the size retry only", async () => {
    ffmpegWrites([CAPS.example + 1, 10]);
    await transcodeExample(SRC, path.join(dir, "e.mp4"));
    const calls = vi.mocked(runFfmpeg).mock.calls.map(([args]) => args);
    expect(calls[0]).not.toContain("-maxrate");
    expect(calls[1]).toEqual(expect.arrayContaining(["-maxrate", "4M", "-bufsize", "8M"]));
  });
  it("never reports progress going backwards across the retry", async () => {
    vi.mocked(runFfmpeg).mockImplementation(async (args, opts) => {
      for (const p of [0.2, 0.6, 1]) opts?.onProgress?.(p);
      fs.writeFileSync(args[args.length - 1], Buffer.alloc(vi.mocked(runFfmpeg).mock.calls.length === 1 ? CAPS.example + 1 : 10));
      return { stdout: "", stderr: "" };
    });
    const seen: number[] = [];
    await transcodeExample(SRC, path.join(dir, "f.mp4"), { onProgress: (p) => seen.push(p) });
    expect(seen.length).toBeGreaterThan(0);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
  });
});

describe("example duration cap (the site refuses durationSec > 15 exactly)", () => {
  it("trims one frame's length under 15 s from the start, so the last frame ENDS by 15 s", async () => {
    probes({ duration: 30, width: 1920, height: 1080, frameRate: 30000 / 1001 });
    ffmpegWrites([10]);
    await transcodeExample(SRC, path.join(dir, "t1.mp4"));
    const t = Number(arg(0, "-t"));
    expect(t).toBeLessThanOrEqual(15 - 1001 / 30000);
    expect(t).toBeGreaterThan(15 - 1001 / 30000 - 0.002);
  });
  it("re-encodes shorter by the overshoot when the read-back is still over 15 s", async () => {
    probes({ duration: 30, width: 1920, height: 1080 }, [{ duration: 15.04, width: 1280, height: 720 }, { duration: 14.97, width: 1280, height: 720 }]);
    ffmpegWrites([10, 10]);
    const r = await transcodeExample(SRC, path.join(dir, "t2.mp4"));
    expect(r.durationSec).toBe(14.97);
    expect(vi.mocked(runFfmpeg)).toHaveBeenCalledTimes(2);
    expect(Number(arg(1, "-t"))).toBeLessThan(Number(arg(0, "-t")) - 0.04);
  });
  it("throws naming the 15 s cap when the re-encode is still over it — never reports a longer example", async () => {
    probes({ duration: 30, width: 1920, height: 1080 }, [{ duration: 15.04, width: 1280, height: 720 }]);
    ffmpegWrites([10, 10]);
    await expect(transcodeExample(SRC, path.join(dir, "t3.mp4"))).rejects.toThrow(/15 s/);
  });
  it("refuses an output it cannot read back, or one past the long-edge cap", async () => {
    probes({ duration: 5, width: 1920, height: 1080 }, [{}]);
    ffmpegWrites([10]);
    await expect(transcodeExample(SRC, path.join(dir, "t4.mp4"))).rejects.toThrow(/could not read/);
    probes({ duration: 5, width: 1920, height: 1080 }, [{ duration: 5, width: 1282, height: 720 }]);
    ffmpegWrites([10]);
    await expect(transcodeExample(SRC, path.join(dir, "t5.mp4"))).rejects.toThrow(/1280/);
  });
});

describe("poster size cap", () => {
  it("retries once at the lower quality when the first frame is over 400 KB, and uses the fixed op", async () => {
    ffmpegWrites([CAPS.poster + 1, CAPS.poster]);
    const r = await makePoster(SRC, path.join(dir, "a.jpg"));
    expect(r.bytes).toBe(CAPS.poster);
    expect([arg(0, "-q:v"), arg(1, "-q:v")]).toEqual(["5", "12"]);
    for (const [, opts] of vi.mocked(runFfmpeg).mock.calls) expect(opts.op).toBe(POSTER_OP);
    expect(POSTER_OP).toBe("template_poster");
  });
  it("throws naming the 400 KB cap when the retry is still over it", async () => {
    ffmpegWrites([CAPS.poster + 1, CAPS.poster + 1]);
    await expect(makePoster(SRC, path.join(dir, "b.jpg"))).rejects.toThrow(/400 KB/);
  });
  it("says so when ffmpeg succeeded but wrote no frame", async () => {
    vi.mocked(runFfmpeg).mockResolvedValue({ stdout: "", stderr: "" });
    await expect(makePoster(SRC, path.join(dir, "never.jpg"))).rejects.toThrow(/no frame at 1 s/);
  });
  it("seeks to 1 s, or half-way into a source of 2 s or less", async () => {
    ffmpegWrites([10]);
    await makePoster(SRC, path.join(dir, "s1.jpg"));
    expect(arg(0, "-ss")).toBe("1");
    probes({ duration: 0.5, width: 320, height: 240 });
    ffmpegWrites([10]);
    await makePoster(SRC, path.join(dir, "s2.jpg"));
    expect(arg(1, "-ss")).toBe("0.25");
  });
});

describe("a source probe that fails", () => {
  it.each([
    ["timeout", /could not read the source video: ffprobe timed out/],
    ["unreadable", /could not read the source video: it is missing, unreadable or not a media file/],
  ] as const)("(%s) is reported as that, never as a source with no video stream, and nothing is encoded", async (failure, message) => {
    vi.mocked(probeMediaResult).mockResolvedValue({ ok: false, failure });
    for (const run of [() => transcodeExample(SRC, path.join(dir, "f.mp4")), () => makePoster(SRC, path.join(dir, "f.jpg"))]) {
      const err = await run().catch((e: Error) => e);
      expect((err as Error).message).toMatch(message);
      expect((err as Error).message).not.toMatch(/no video stream/);
    }
    expect(runFfmpeg).not.toHaveBeenCalled();
  });
});
