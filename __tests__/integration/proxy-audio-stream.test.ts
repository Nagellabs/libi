/**
 * Integration (real ffmpeg + real mediabunny demux): the proxy's audio is the
 * audio the preview reads from the ORIGINAL, at the same source time. So when
 * the audio engine falls back from the original to the proxy, the sound
 * neither changes nor moves (Review M6).
 *
 * - Several audio streams: the preview reads libi's primary track (the first
 *   default-flagged audio stream, else the first; `primaryAudioTrack`), while
 *   ffmpeg without `-map` picks by its own rules (a `default`-flagged stream,
 *   then the one with the most channels) and mediabunny 1.60's own pick ranks
 *   by bitrate. The proxy has to carry the preview's.
 * - A non-zero start: a clip cut from a stream starts at 1.5 s. ffmpeg rebases
 *   the proxy to 0, and the preview measures both files from their own start
 *   (sourceTimeOrigin), so a sound at source time 1.0 is at 1.0 in both.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { Input, FilePathSource, ALL_FORMATS, EncodedPacketSink } from "mediabunny";
import { buildProxyArgs, proxyStreamsFor } from "@/lib/proxy/args";
import { probeMedia } from "@/lib/ffmpeg/probe";
import { sourceTimeOrigin } from "@/lib/engine/source-time-origin";
import { primaryAudioTrack } from "@/lib/engine/primary-track";
import { hasFfmpeg, FFMPEG_SKIP_REASON } from "@/__tests__/helpers/media";

if (!hasFfmpeg()) console.info(`[skip] ${FFMPEG_SKIP_REASON}`);
const skipIf = hasFfmpeg() ? describe : describe.skip;

const RATE = 48000;

function ff(args: string[]): void {
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "ignore", timeout: 60_000 });
}

/** Amplitude of `freq` over the whole decoded first audio stream (mono mixdown). */
function toneAmp(file: string, freq: number): number {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-map", "0:a:0", "-ac", "1", "-ar", String(RATE), "-f", "f32le", "-"]);
  const x = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const n = RATE; // 1 s window from 0.5 s: every tone below sits on a bin
  const from = RATE / 2;
  const w = (2 * Math.PI * freq) / RATE;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const s = x[from + i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return (2 * Math.sqrt(Math.max(s1 * s1 + s2 * s2 - coeff * s1 * s2, 0))) / n;
}

/** The proxy exactly as the proxy_gen runner builds it: probe, then map. */
async function makeProxy(src: string, out: string): Promise<void> {
  const probed = await probeMedia(src);
  ff(buildProxyArgs(src, out, { fps: 10, ...proxyStreamsFor(probed) }).slice(1)); // drop the leading -y (ff adds it)
}

/** Source time (from the file's own start) of the first audio packet at or after a loud onset. */
async function onsetSourceTime(file: string): Promise<number> {
  const input = new Input({ source: new FilePathSource(file), formats: ALL_FORMATS });
  try {
    const origin = await sourceTimeOrigin(input);
    const track = (await primaryAudioTrack(input))!;
    const sink = new EncodedPacketSink(track);
    // Packets during silence are tiny; the tone's first packets are much larger.
    let small = Infinity;
    for await (const p of sink.packets()) {
      small = Math.min(small, p.byteLength);
      if (p.timestamp - origin > 0.2 && p.byteLength > small * 4) return p.timestamp - origin;
    }
    throw new Error("no onset found");
  } finally {
    input.dispose();
  }
}

skipIf("proxy audio stream selection and timing (real ffmpeg)", () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-proxy-audio-"));
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** video + a:0 mono 440 Hz + a:1 stereo 880 Hz, with the given default flags. */
  function twoTrackFile(name: string, defaults: [boolean, boolean]): string {
    const src = path.join(dir, name);
    ff(["-f", "lavfi", "-i", "testsrc2=s=64x64:r=10:d=2",
      "-f", "lavfi", "-i", `aevalsrc=0.3*sin(2*PI*440*t):s=${RATE}:d=2:c=mono`,
      "-f", "lavfi", "-i", `aevalsrc=0.3*sin(2*PI*880*t)|0.3*sin(2*PI*880*t):s=${RATE}:d=2:c=stereo`,
      "-map", "0:v", "-map", "1:a", "-map", "2:a",
      "-disposition:a:0", defaults[0] ? "default" : "0", "-disposition:a:1", defaults[1] ? "default" : "0",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", src]);
    return src;
  }

  async function previewChannels(file: string): Promise<number> {
    const input = new Input({ source: new FilePathSource(file), formats: ALL_FORMATS });
    try {
      return (await primaryAudioTrack(input))!.getNumberOfChannels();
    } finally {
      input.dispose();
    }
  }

  it.each([
    // Both flagged default: the preview takes the FIRST (mono 440). ffmpeg's
    // own pick is the one with more channels (stereo 880), and so is
    // mediabunny 1.60's (higher btrt bitrate). This is the case that diverged,
    // twice.
    ["both default", [true, true] as [boolean, boolean], 1, 440, 880],
    // Only the second flagged default: the preview takes it (stereo 880).
    ["second default", [false, true] as [boolean, boolean], 2, 880, 440],
  ])("two audio streams (%s): the proxy carries the stream the preview decodes", async (_l, defaults, channels, want, notWant) => {
    const src = twoTrackFile(`two-${defaults.join("-")}.mp4`, defaults);
    expect(await previewChannels(src)).toBe(channels);

    const proxy = src.replace(/\.mp4$/, "-proxy.mp4");
    await makeProxy(src, proxy);
    const streams = execFileSync("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=channels", "-of", "csv=p=0", proxy]).toString().trim().split("\n");
    expect(streams).toEqual([String(channels)]);
    expect(toneAmp(proxy, want)).toBeGreaterThan(0.2);
    expect(toneAmp(proxy, notWant)).toBeLessThan(0.02);
  });

  it("a file that starts at 1.5 s: a sound at source time 1.0 is at 1.0 in the original AND its proxy", async () => {
    const src = path.join(dir, "cut.mp4");
    // Silence for 1 s, then a tone; the whole file is offset to start at 1.5 s.
    ff(["-f", "lavfi", "-i", "testsrc2=s=64x64:r=10:d=3",
      "-f", "lavfi", "-i", `aevalsrc='if(gte(t,1),0.5*sin(2*PI*440*t),0)':s=${RATE}:d=3:c=mono`,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-output_ts_offset", "1.5", src]);
    const input = new Input({ source: new FilePathSource(src), formats: ALL_FORMATS });
    expect(await sourceTimeOrigin(input)).toBeGreaterThan(1.4); // raw timestamps really start near 1.5
    input.dispose();

    const proxy = path.join(dir, "cut-proxy.mp4");
    await makeProxy(src, proxy);
    const inOriginal = await onsetSourceTime(src);
    const inProxy = await onsetSourceTime(proxy);
    expect(inOriginal).toBeGreaterThan(0.9);
    expect(inOriginal).toBeLessThan(1.1);
    expect(Math.abs(inProxy - inOriginal)).toBeLessThan(0.05); // within ~2 AAC frames
  });
});
