/**
 * Smoke tests for the `__tests__/helpers/media.ts` validator library + the
 * committed video fixtures under `__tests__/helpers/fixtures/video/`.
 *
 * These tests lock in the baseline shape of the fixtures so downstream video-
 * pipeline integration tests can rely on them. Skipped if ffmpeg is missing.
 */
import { describe, it, expect } from "vitest";
import path from "path";
import {
  probe,
  extractFrameRgba,
  samplePixel,
  sampleRegionMean,
  audioMeanVolumeDb,
  sha256,
  hasFfmpeg, FFMPEG_SKIP_REASON,
} from "@/__tests__/helpers/media";

const FIXTURES = path.resolve(__dirname, "..", "helpers", "fixtures", "video");
const RED = path.join(FIXTURES, "clip-red-3s.mp4");
const GREEN = path.join(FIXTURES, "clip-green-3s.mp4");

const ffmpegPresent = hasFfmpeg();
if (!ffmpegPresent) console.info(`[skip] media helpers — ${FFMPEG_SKIP_REASON}`);
const skipIf = ffmpegPresent ? describe : describe.skip;

skipIf("media helpers", () => {
  it("probe() describes clip-red-3s.mp4", async () => {
    const p = await probe(RED);
    expect(p.duration).toBeGreaterThan(2.8);
    expect(p.duration).toBeLessThan(3.2);
    expect(p.videoStream).not.toBeNull();
    expect(p.videoStream!.codec).toBe("h264");
    expect(p.videoStream!.width).toBe(320);
    expect(p.videoStream!.height).toBe(240);
    expect(p.videoStream!.fps).toBeGreaterThan(23);
    expect(p.videoStream!.fps).toBeLessThan(25);
    expect(p.audioStream).not.toBeNull();
    expect(p.audioStream!.codec).toBe("aac");
  });

  it("probe() describes clip-green-3s.mp4", async () => {
    const p = await probe(GREEN);
    expect(p.duration).toBeGreaterThan(2.8);
    expect(p.duration).toBeLessThan(3.2);
    expect(p.videoStream?.codec).toBe("h264");
    expect(p.audioStream?.codec).toBe("aac");
  });

  it("extractFrameRgba + samplePixel confirms red dominance at t=1s in clip-red-3s.mp4", async () => {
    const frame = await extractFrameRgba(RED, 1);
    expect(frame.width).toBe(320);
    expect(frame.height).toBe(240);
    const [r, g, b, a] = samplePixel(frame, 160, 120);
    expect(a).toBe(255);
    expect(r).toBeGreaterThan(150);
    expect(g).toBeLessThan(80);
    expect(b).toBeLessThan(80);
  });

  it("sampleRegionMean over clip-green-3s.mp4 at t=1s is green-dominant", async () => {
    const frame = await extractFrameRgba(GREEN, 1);
    // ffmpeg's `color=c=green` lavfi source emits mid-green (R=0, G=128, B=0),
    // so use thresholds that reflect the actual pixel emission.
    const [r, g, b] = sampleRegionMean(frame, { x: 100, y: 100, w: 40, h: 40 });
    expect(g).toBeGreaterThan(100);
    expect(r).toBeLessThan(100);
    expect(b).toBeLessThan(100);
  });

  it("audioMeanVolumeDb() returns a negative dB value for the red fixture", async () => {
    const db = await audioMeanVolumeDb(RED);
    expect(db).not.toBeNull();
    expect(db!).toBeLessThan(0);
  });

  it("sha256() returns a 64-char hex string", async () => {
    const h = await sha256(RED);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});
