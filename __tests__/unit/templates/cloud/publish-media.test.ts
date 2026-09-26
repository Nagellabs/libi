// __tests__/unit/templates/cloud/publish-media.test.ts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FFMPEG_SKIP_REASON, extractFrameRgba, hasFfmpeg, probe, samplePixel } from "@/__tests__/helpers/media";
import { resolveFfmpegPath, resolveFfprobePath } from "@/lib/ffmpeg/exec";
import { probeMedia } from "@/lib/ffmpeg/probe";
import { CAPS, EXAMPLE_MAX_LONG_EDGE, EXAMPLE_MAX_SECONDS } from "@/lib/templates/cloud/constants";
import { buildExampleArgs, buildPosterArgs, makePoster, transcodeExample } from "@/lib/templates/cloud/publish-media";

const FIXTURE = path.resolve("__tests__/helpers/fixtures/video/clip-green-3s.mp4");

describe("arg builders (pure)", () => {
  it("example: trims to 15 s, scales the long edge to ≤ 1280 keeping even dims, H.264/AAC, faststart, fixed crf", () => {
    const args = buildExampleArgs("in.mov", "out.mp4", { crf: 26, trimSec: 15 });
    expect(args).toContain("-t");
    expect(args[args.indexOf("-t") + 1]).toBe("15");
    expect(args[args.indexOf("-vf") + 1]).toContain("1280");
    expect(args).toEqual(expect.arrayContaining(["-c:v", "libx264", "-crf", "26", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-c:a", "aac"]));
    // The muxer is named, so the output path is never read as an option or a format guess.
    expect(args.slice(-3)).toEqual(["-f", "mp4", "out.mp4"]);
    expect(args).not.toContain("-maxrate");
  });
  it("example: the size-retry pass also caps the bitrate so 15 s fits in 8 MB", () => {
    const args = buildExampleArgs("in.mov", "out.mp4", { crf: 32, trimSec: 15, capBitrate: true });
    expect(args).toEqual(expect.arrayContaining(["-maxrate", "4M", "-bufsize", "8M"]));
  });
  it("poster: one frame at the given second as a single JPEG (no image-sequence pattern)", () => {
    const args = buildPosterArgs("in.mp4", "out.jpg", 5, 1);
    expect(args.slice(0, 4)).toEqual(["-y", "-ss", "1", "-i"]);
    expect(args).toEqual(expect.arrayContaining(["-frames:v", "1", "-q:v", "5", "-c:v", "mjpeg"]));
    expect(args.slice(-5)).toEqual(["-f", "image2", "-update", "1", "out.jpg"]);
    expect(buildPosterArgs("in.mp4", "out.jpg", 5, 0.25).slice(0, 3)).toEqual(["-y", "-ss", "0.25"]);
  });

  // --- beyond the brief ---------------------------------------------------

  it("example: drops the source's metadata, chapters, subtitles and data streams — it is published to strangers", () => {
    const args = buildExampleArgs("in.mov", "out.mp4", { crf: 26, trimSec: 15 });
    expect(args[args.indexOf("-map_metadata") + 1]).toBe("-1");
    expect(args[args.indexOf("-map_chapters") + 1]).toBe("-1");
    expect(args).toEqual(expect.arrayContaining(["-sn", "-dn"]));
  });
  it("an alpha source is flattened onto black: premultiplied before ANY scaling (the anamorphic squaring too), and a VPx one decoded with libvpx (an input option)", () => {
    const vp9 = { hasAlpha: true, videoCodec: "vp9" };
    const ex = buildExampleArgs("in.webm", "out.mp4", { crf: 26, trimSec: 15 }, vp9);
    expect(ex.slice(0, 4)).toEqual(["-y", "-c:v", "libvpx-vp9", "-i"]);
    expect(ex[ex.indexOf("-vf") + 1]).toMatch(/^format=rgba,premultiply=inplace=1,scale=iw\*sar:ih,setsar=1,scale='/);
    const po = buildPosterArgs("in.webm", "out.jpg", 5, 1, vp9);
    expect(po.slice(0, 6)).toEqual(["-y", "-ss", "1", "-c:v", "libvpx-vp9", "-i"]);
    expect(po[po.indexOf("-vf") + 1]).toMatch(/^format=rgba,premultiply=inplace=1,scale=iw\*sar:ih,setsar=1,scale='/);
    // ProRes 4444 keeps its alpha under the native decoder: flattened, no forced decoder.
    const prores = buildExampleArgs("in.mov", "out.mp4", { crf: 26, trimSec: 15 }, { hasAlpha: true, videoCodec: "prores" });
    expect(prores.slice(0, 3)).toEqual(["-y", "-i", "in.mov"]);
    expect(prores[prores.indexOf("-vf") + 1]).toMatch(/^format=rgba,premultiply=inplace=1,scale=iw\*sar:ih,setsar=1,/);
    // Opaque: no alpha handling at all.
    expect(buildExampleArgs("in.mp4", "out.mp4", { crf: 26, trimSec: 15 }, { hasAlpha: false, videoCodec: "vp9" })).toEqual(buildExampleArgs("in.mp4", "out.mp4", { crf: 26, trimSec: 15 }));
  });
  it("both chains scale the DISPLAY size: pixels squared before the size scale (scale=iw*sar:ih,setsar=1), and the output tagged square", () => {
    for (const vf of [
      buildExampleArgs("in.mp4", "out.mp4", { crf: 26, trimSec: 15 }),
      buildPosterArgs("in.mp4", "out.jpg", 5, 1),
      buildExampleArgs("in.webm", "out.mp4", { crf: 26, trimSec: 15 }, { hasAlpha: true, videoCodec: "vp9" }),
    ].map((a) => a[a.indexOf("-vf") + 1])) {
      expect(vf.replace(/^format=rgba,premultiply=inplace=1,/, "").startsWith("scale=iw*sar:ih,setsar=1,scale='")).toBe(true);
      expect(vf.endsWith(",setsar=1")).toBe(true);
    }
  });
});

if (!hasFfmpeg()) console.info(`[skip] publish-media — ${FFMPEG_SKIP_REASON}`);
describe.skipIf(!hasFfmpeg())("transcode with real ffmpeg", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-publish-media-"));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("produces an mp4 under every cap with correct metadata, reporting progress", async () => {
    const seen: number[] = [];
    const r = await transcodeExample(FIXTURE, path.join(dir, "example.mp4"), { onProgress: (p) => seen.push(p) });
    expect(r.bytes).toBeLessThanOrEqual(CAPS.example);
    expect(r.durationSec).toBeLessThanOrEqual(15);
    expect(Math.max(r.width, r.height)).toBeLessThanOrEqual(1280);
    expect(r.width % 2).toBe(0);
    const head = fs.readFileSync(r.path).subarray(4, 8).toString("latin1");
    expect(head).toBe("ftyp");
    expect(seen.length).toBeGreaterThan(0);
  });
  it("makes a JPEG poster under 400 KB", async () => {
    const r = await makePoster(FIXTURE, path.join(dir, "poster.jpg"));
    expect(r.bytes).toBeLessThanOrEqual(CAPS.poster);
    const head = fs.readFileSync(r.path);
    expect(head[0]).toBe(0xff);
    expect(head[1]).toBe(0xd8);
  });

  // --- beyond the brief ---------------------------------------------------

  const ffmpeg = (args: string[]) => execFileSync(resolveFfmpegPath(), ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "pipe" });

  /**
   * What the site checks, on what it is told: libi-site lib/templates/prepare.ts
   * refuses `durationSec > 15` exactly, `max(w,h) > 1280`, and non-positive
   * integer dims. durationSec is the output's ffprobe `format.duration`, so it
   * is read back here independently of the code under test.
   */
  async function expectSiteAccepts(r: { path: string; durationSec: number; width: number; height: number }) {
    const back = await probe(r.path);
    expect(back.duration).not.toBeNull();
    expect(r.durationSec).toBe(back.duration);
    expect(back.duration!).toBeLessThanOrEqual(EXAMPLE_MAX_SECONDS);
    expect(back.duration!).toBeGreaterThanOrEqual(0.1);
    expect([r.width, r.height]).toEqual([back.videoStream!.width, back.videoStream!.height]);
    expect(Math.max(r.width, r.height)).toBeLessThanOrEqual(EXAMPLE_MAX_LONG_EDGE);
    expect(r.width % 2).toBe(0);
    expect(r.height % 2).toBe(0);
  }

  it("trims a long source to 15 s and scales a landscape source to 1280 wide, never upscaling a small one", async () => {
    const src = path.join(dir, "long-wide.mp4");
    ffmpeg(["-f", "lavfi", "-i", "color=c=blue:s=1920x1080:d=17:r=10", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", src]);
    const r = await transcodeExample(src, path.join(dir, "long-wide-out.mp4"));
    expect([r.width, r.height]).toEqual([1280, 720]);
    expect(r.durationSec).toBeGreaterThan(14);
    await expectSiteAccepts(r);
    const small = await transcodeExample(FIXTURE, path.join(dir, "small-out.mp4"));
    expect([small.width, small.height]).toEqual([320, 240]);
  }, 60_000);

  // Phone and camera rates: at -t 15 the last frame ENDS past 15 s (15.015),
  // which the site's exact check refuses.
  it.each([
    ["29.97", "30000/1001"],
    ["23.976", "24000/1001"],
    ["59.94", "60000/1001"],
  ])("a %s fps source with audio, longer than 15 s, comes out at ≤ 15.000 s", async (label, rate) => {
    const src = path.join(dir, `ntsc-${label}.mp4`);
    ffmpeg([
      "-f", "lavfi", "-i", `testsrc2=s=640x360:r=${rate}:d=17`,
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=17",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", src,
    ]);
    const r = await transcodeExample(src, path.join(dir, `ntsc-${label}-out.mp4`));
    expect(r.durationSec).toBeGreaterThan(14.9);
    await expectSiteAccepts(r);
  }, 90_000);

  // libx264 refuses an odd width or height; only the short edge went through -2.
  it.each([
    [721, 405, [720, 404]],
    [405, 721, [404, 720]],
    [1001, 1001, [1000, 1000]],
    [1081, 1081, [1080, 1080]],
    [999, 555, [998, 554]],
    [333, 777, [332, 776]],
  ])("an odd %ix%i source encodes to even dims with the long edge ≤ 1280", async (w, h, want) => {
    const src = path.join(dir, `odd-${w}x${h}.mp4`);
    // yuv444p: an H.264 source may itself have odd dims only without chroma
    // subsampling. `testsrc`, not `testsrc2`, which silently rounds to even.
    ffmpeg(["-f", "lavfi", "-i", `testsrc=s=${w}x${h}:r=25:d=1.5`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv444p", src]);
    expect((await probe(src)).videoStream).toMatchObject({ width: w, height: h });
    const r = await transcodeExample(src, path.join(dir, `odd-${w}x${h}-out.mp4`));
    expect([r.width, r.height]).toEqual(want);
    await expectSiteAccepts(r);
    const poster = await makePoster(src, path.join(dir, `odd-${w}x${h}.jpg`));
    expect(poster.bytes).toBeGreaterThan(0);
  }, 60_000);

  it("refuses a source with no video stream, naming it, instead of returning 0×0", async () => {
    const src = path.join(dir, "audio-only.m4a");
    ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:a", "aac", src]);
    await expect(transcodeExample(src, path.join(dir, "audio-only-out.mp4"))).rejects.toThrow(/no video/);
    await expect(makePoster(src, path.join(dir, "audio-only.jpg"))).rejects.toThrow(/no video/);
  }, 60_000);

  // A5 follow-up (b): probeMedia answers {} for a file it cannot read, which
  // used to read as "no video stream" — a misleading reason to hand an agent.
  it("says a source it cannot read is unreadable — not that it has no video stream", async () => {
    const junk = path.join(dir, "not-media.mp4");
    fs.writeFileSync(junk, "this is not a video, whatever its name says");
    const missing = path.join(dir, "does-not-exist.mp4");
    for (const src of [junk, missing]) {
      const ex = transcodeExample(src, path.join(dir, "unreadable-out.mp4"));
      await expect(ex).rejects.toThrow(/could not read the source video/);
      await expect(ex).rejects.not.toThrow(/no video stream/);
      const po = makePoster(src, path.join(dir, "unreadable.jpg"));
      await expect(po).rejects.toThrow(/could not read the source video/);
      await expect(po).rejects.not.toThrow(/no video stream/);
    }
  }, 60_000);

  // A5 follow-up (a): a non-square-pixel source (DV/DVD, HDV) is stored at one
  // size and shown at another. The caps apply to what a viewer SEES, and the
  // poster must not come out squashed.
  const sarOf = (p: string) =>
    execFileSync(resolveFfprobePath(), ["-v", "quiet", "-select_streams", "v:0", "-show_entries", "stream=sample_aspect_ratio", "-of", "csv=p=0", p]).toString().trim();
  it.each([
    ["8:9", 720, 480, [640, 480]],
    ["32:27", 720, 480, [852, 480]],
    ["4:3", 1440, 1080, [1280, 720]],
  ])("an anamorphic source (SAR %s, stored %ix%i) is sized by its display size, square-pixelled, in the example and the poster", async (sar, w, h, want) => {
    const src = path.join(dir, `anamorphic-${w}x${h}-${sar.replace(":", "-")}.mp4`);
    ffmpeg(["-f", "lavfi", "-i", `testsrc2=s=${w}x${h}:r=25:d=1.5`, "-vf", `setsar=${sar.replace(":", "/")}`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", src]);
    expect(sarOf(src)).toBe(sar);
    const r = await transcodeExample(src, path.join(dir, `anamorphic-${w}x${h}-${sar.replace(":", "-")}-out.mp4`));
    expect([r.width, r.height]).toEqual(want);
    expect(sarOf(r.path)).toBe("1:1");
    await expectSiteAccepts(r);
    const poster = await makePoster(src, path.join(dir, `anamorphic-${w}x${h}-${sar.replace(":", "-")}.jpg`));
    const p = await probe(poster.path);
    expect([p.videoStream!.width, p.videoStream!.height]).toEqual(want);
  }, 60_000);

  it("cuts a poster from an example of a second or less (the site accepts from 0.1 s)", async () => {
    for (const d of [0.5, 1]) {
      const src = path.join(dir, `short-${d}.mp4`);
      ffmpeg(["-f", "lavfi", "-i", `testsrc2=s=320x240:r=25:d=${d}`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", src]);
      const r = await makePoster(src, path.join(dir, `short-${d}.jpg`));
      expect(fs.readFileSync(r.path).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    }
  }, 60_000);

  it("refuses relative paths — the args are positional, so a path is never read as an option or a URL", async () => {
    await expect(transcodeExample("in.mp4", path.join(dir, "x.mp4"))).rejects.toThrow(/absolute/);
    await expect(transcodeExample(FIXTURE, "-x.mp4")).rejects.toThrow(/absolute/);
    await expect(makePoster("file:in.mp4", path.join(dir, "x.jpg"))).rejects.toThrow(/absolute/);
  });

  it("stops a running transcode when its signal aborts", async () => {
    const src = path.join(dir, "abort-src.mp4");
    ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=1920x1080:r=30:d=15", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", src]);
    const ac = new AbortController();
    const out = path.join(dir, "abort-out.mp4");
    const started = Date.now();
    await expect(transcodeExample(src, out, { signal: ac.signal, onProgress: () => ac.abort() })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 60_000);

  describe("an alpha source", () => {
    // Red everywhere underneath; alpha 0 on the left half, 255 on the right.
    // Dropping the alpha instead of flattening it shows red on the left.
    const src = path.join(dir, "alpha.webm");
    beforeAll(() => {
      ffmpeg([
        "-f", "lavfi", "-i", "color=c=red:s=320x240:d=2:r=25",
        "-f", "lavfi", "-i", "color=c=black:s=320x240:d=2:r=25,drawbox=x=160:y=0:w=160:h=240:c=white:t=fill",
        "-filter_complex", "[1:v]format=gray[a];[0:v][a]alphamerge,format=yuva420p",
        "-c:v", "libvpx-vp9", "-auto-alt-ref", "0", src,
      ]);
    });

    it("is flattened onto black in the example: the transparent half is black, not the colour under it", async () => {
      expect(await probeMedia(src)).toMatchObject({ hasAlpha: true, videoCodec: "vp9" });
      const r = await transcodeExample(src, path.join(dir, "alpha-out.mp4"));
      const frame = await extractFrameRgba(r.path, 1);
      const [lr, lg, lb] = samplePixel(frame, 40, 120);
      expect(Math.max(lr, lg, lb)).toBeLessThan(24);
      expect(samplePixel(frame, 280, 120)[0]).toBeGreaterThan(200);
    }, 60_000);
    it("is flattened onto black in the poster", async () => {
      const r = await makePoster(src, path.join(dir, "alpha-poster.jpg"));
      const frame = await extractFrameRgba(r.path, 0);
      const [lr, lg, lb] = samplePixel(frame, 40, 120);
      expect(Math.max(lr, lg, lb)).toBeLessThan(24);
      expect(samplePixel(frame, 280, 120)[0]).toBeGreaterThan(200);
    }, 60_000);
  });

  it("strips the source's metadata from the example", async () => {
    const src = path.join(dir, "tagged.mp4");
    ffmpeg(["-i", FIXTURE, "-c", "copy", "-metadata", "location=+13.7563+100.5018/", "-metadata", "title=secret", src]);
    const r = await transcodeExample(src, path.join(dir, "tagged-out.mp4"));
    const tags = execFileSync(resolveFfprobePath(), ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", r.path]).toString();
    expect(tags).not.toContain("100.5018");
    expect(tags).not.toContain("secret");
    // Not just the tags ffprobe chooses to show: nowhere in the published bytes.
    const bytes = fs.readFileSync(r.path);
    expect(bytes.includes("100.5018")).toBe(false);
    expect(bytes.includes("secret")).toBe(false);
    const poster = fs.readFileSync((await makePoster(src, path.join(dir, "tagged.jpg"))).path);
    expect(poster.includes("100.5018")).toBe(false);
    expect(poster.includes("secret")).toBe(false);
  }, 60_000);
});
