/**
 * Integration: a ducked mix must not clip.
 *
 * This is the test that would have caught the 2026-08-18 export bug. The unit
 * tests around `buildAudioMixGraph` all passed while every exported mix was
 * destroyed, because they asserted the graph STRING — and the string contained
 * `makeup=12`, which they had been written to expect. Only rendering the graph
 * and looking at the samples reveals that ffmpeg's `makeup` is a linear
 * multiplier, so a -12 dB duck was amplifying the music 12x (+21.6 dB) and
 * pinning ~10% of the output at full scale.
 *
 * So: build the real graph, run it through the real ffmpeg, and count clipped
 * samples. Nothing here inspects the filter string.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync, execSync } from "child_process";
import { buildAudioMixGraph } from "@/lib/export/audio-mix";
import { renderDuckEnvelopes } from "@/lib/export/duck-envelopes";
import { DEFAULT_DUCK, sanitizeDuck } from "@/lib/audio/duck-params";
import type { AudioClip } from "@/lib/engine/types";

function hasFfmpeg(): boolean {
  try { execSync("ffmpeg -version", { stdio: "ignore", timeout: 2000 }); return true; }
  catch { return false; }
}
const ffmpegPresent = hasFfmpeg();
if (!ffmpegPresent) console.info("[skip] duck mix clipping — ffmpeg not on PATH");
const skipIf = ffmpegPresent ? describe : describe.skip;

/**
 * Samples of a 16-bit WAV, located by walking the RIFF chunks.
 *
 * NOT a fixed 44-byte skip: this ffmpeg writes a `LIST` chunk before `data`,
 * putting the samples at offset 78. An earlier draft assumed 44 and silently
 * measured misaligned bytes — every level in this file was fiction.
 */
function readPcm(file: string): Buffer {
  const buf = fs.readFileSync(file);
  let pos = 12; // past "RIFF" + size + "WAVE"
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === "data") return buf.subarray(pos + 8, pos + 8 + size);
    pos += 8 + size + (size % 2); // chunks are word-aligned
  }
  throw new Error(`no data chunk in ${file}`);
}

const DUR = 4;
/** Music-bed amplitude, -6 dBFS. Asserted in `fixtureLevels` so the fixture
 *  cannot drift quiet enough to stop testing anything. */
const MUSIC_PEAK = 0.5;
/** Voice amplitude while speaking — well above the -30 dB duck threshold. */
const VO_PEAK = 0.3;

skipIf("ducked mix clipping", () => {
  let dir: string;
  let music: string;
  let vo: string;
  /** Speaks in the SECOND half — the half `vo` is silent for. */
  let voLate: string;
  /** Speaks in the FIRST half, alongside `vo` — the overlap case. */
  let voOverlap: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-duck-"));
    music = path.join(dir, "music.wav");
    vo = path.join(dir, "vo.wav");
    // A steady tone at -6 dBFS stands in for the music bed. Levels are chosen
    // so the honest mix sits below 0 dBFS — anything that clips is gain the
    // mixer invented.
    //
    // `aevalsrc`, not `sine`: the `sine` filter has no amplitude option and its
    // output level is a build detail (-18 dBFS here), which silently made an
    // earlier draft of this fixture ~18 dB too quiet to expose a 12x boost at
    // all. An explicit expression pins the amplitude on every ffmpeg. The
    // `fixtureLevels` assertion below is the guard against that recurring.
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi",
      "-i", `aevalsrc=${MUSIC_PEAK}*sin(2*PI*220*t):d=${DUR}:s=44100`,
      "-c:a", "pcm_s16le", music]);
    // The voice SPEAKS then PAUSES. The pause is the part that matters: with no
    // sidechain signal the compressor applies no reduction, so any standing
    // gain on the music shows up undisguised. A continuously-loud sidechain
    // hides it behind constant gain reduction — which is why the real bug
    // survived review, and why this fixture goes silent for its second half.
    // The `lt(t, ...)` gate is exact; a `volume=enable=...` filter left ~-20 dB
    // of residual behind rather than true silence.
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi",
      // The comma inside lt() must reach ffmpeg escaped, or it reads as a
      // filter-chain separator: `\\,` in source -> `\,` in the argument.
      "-i", `aevalsrc=lt(t\\,${DUR / 2})*${VO_PEAK}*sin(2*PI*900*t):d=${DUR}:s=44100`,
      "-c:a", "pcm_s16le", vo]);
    // A SECOND voice-over line, speaking exactly where the first is silent.
    // With one sidechain per duck, a piece like this had to be bounced into a
    // single "VO bus" file first; with N sidechains the bed ducks under both.
    voLate = path.join(dir, "vo-late.wav");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi",
      "-i", `aevalsrc=gte(t\\,${DUR / 2})*${VO_PEAK}*sin(2*PI*700*t):d=${DUR}:s=44100`,
      "-c:a", "pcm_s16le", voLate]);
    // A third line OVERLAPPING the first — a different frequency so the sum is
    // genuinely louder rather than cancelling.
    voOverlap = path.join(dir, "vo-overlap.wav");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi",
      "-i", `aevalsrc=lt(t\\,${DUR / 2})*${VO_PEAK}*sin(2*PI*1300*t):d=${DUR}:s=44100`,
      "-c:a", "pcm_s16le", voOverlap]);
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** Peak + per-half RMS of a mono 16-bit WAV. */
  function measure(file: string) {
    const pcm = readPcm(file);
    const total = Math.floor(pcm.length / 2);
    let peak = 0;
    const halves = [0, 0];
    for (let i = 0; i < total; i++) {
      const v = pcm.readInt16LE(i * 2) / 32768;
      if (Math.abs(v) > peak) peak = Math.abs(v);
      halves[i < total / 2 ? 0 : 1] += v * v;
    }
    return {
      peak,
      firstHalfRms: Math.sqrt(halves[0] / (total / 2)),
      secondHalfRms: Math.sqrt(halves[1] / (total / 2)),
    };
  }

  it("fixtureLevels: the fixtures are loud enough, and the voice really pauses", () => {
    const m = measure(music);
    expect(m.peak).toBeCloseTo(MUSIC_PEAK, 2);

    const v = measure(vo);
    expect(v.peak).toBeCloseTo(VO_PEAK, 2);
    expect(v.firstHalfRms).toBeGreaterThan(0.1);
    // The pause is what exposes standing gain — if it is not silent, every
    // clipping assertion below is hidden behind constant gain reduction.
    expect(v.secondHalfRms).toBeLessThan(0.01);
  });

  /**
   * Render the mixer's own graph — including a real duck envelope produced by
   * `renderDuckEnvelopes` — and measure the result. Nothing here inspects the
   * filter string; the point is what comes out of ffmpeg.
   */
  async function renderAndMeasure(
    reductionDb: number,
  ): Promise<{ clippedFraction: number; peak: number; duckDb: number }> {
    const duck = sanitizeDuck({ ...DEFAULT_DUCK, sidechainClipIds: ["vo"], reductionDb });
    const base = { trimStart: 0, duration: DUR, startTime: 0 };
    const clips = [
      { id: "music", fileId: "m", ...base, volume: 0.8, duck },
      { id: "vo", fileId: "v", ...base, volume: 1 },
    ] as unknown as AudioClip[];

    const envelopes = await renderDuckEnvelopes({
      inputs: [{
        clipId: "music",
        duck,
        sidechains: [{ path: vo, startTime: 0, trimStart: 0, duration: DUR, volume: 1 }],
      }],
      timelineSeconds: DUR,
      outDir: dir,
    });
    expect(envelopes.get("music"), "an envelope must be rendered").toBeTruthy();

    const { chain } = buildAudioMixGraph({
      clips,
      inputIndex: new Map([["music", 0], ["vo", 1]]),
      envelopeIndex: new Map([["music", 2]]),
      mixDuration: "longest",
    });
    expect(chain).not.toBeNull();

    const out = path.join(dir, `mix-${reductionDb}.wav`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", music, "-i", vo,
      "-i", envelopes.get("music")!,
      "-filter_complex", chain!, "-map", "[aout]",
      "-c:a", "pcm_s16le", "-ar", "44100", out]);

    // How far the BED was pulled down while the voice speaks (first half) vs
    // while it is silent (second half). Measured on a music-only render — the
    // full mix contains the voice, which is itself loud in the first half and
    // would swamp the number. This is what was wrong: the old compressor
    // reached only -1.8 dB where the preview's law reached -7.0.
    const bedGraph = buildAudioMixGraph({
      clips: [clips[0]],
      inputIndex: new Map([["music", 0]]),
      envelopeIndex: new Map([["music", 2]]),
      mixDuration: "longest",
    });
    const bedOut = path.join(dir, `bed-${reductionDb}.wav`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", music, "-i", vo,
      "-i", envelopes.get("music")!,
      "-filter_complex", bedGraph.chain!, "-map", "[aout]",
      "-c:a", "pcm_s16le", "-ar", "44100", bedOut]);
    const bed = measure(bedOut);
    const duckDb = 20 * Math.log10(bed.firstHalfRms / bed.secondHalfRms);

    const pcm = readPcm(out);
    let clipped = 0;
    let peak = 0;
    const total = Math.floor(pcm.length / 2);
    for (let i = 0; i < total; i++) {
      const v = Math.abs(pcm.readInt16LE(i * 2)) / 32768;
      if (v >= 0.9995) clipped++;
      if (v > peak) peak = v;
    }
    return { clippedFraction: clipped / total, peak, duckDb };
  }

  it("a -12 dB duck does not clip the mix", async () => {
    const { clippedFraction, peak } = await renderAndMeasure(-12);
    expect(clippedFraction).toBeLessThan(0.001);
    expect(peak).toBeLessThanOrEqual(1);
  });

  it("no reductionDb in the sanitized range clips the mix", async () => {
    for (const reductionDb of [0, -6, -12, -30, -60]) {
      const { clippedFraction } = await renderAndMeasure(reductionDb);
      expect(
        clippedFraction,
        `reductionDb ${reductionDb} clipped ${(clippedFraction * 100).toFixed(2)}% of samples`,
      ).toBeLessThan(0.001);
    }
  });

  it("the duck actually reaches the depth it promises", async () => {
    // THE regression. ffmpeg's sidechaincompress reached only -1.8 dB on real
    // material where the preview's law reached -7.0, so exported voice-overs
    // sat buried under a bed that ducked correctly in the editor.
    const { duckDb } = await renderAndMeasure(-12);
    expect(duckDb).toBeLessThan(-4);
  });

  it("a deeper reductionDb ducks deeper", async () => {
    const shallow = await renderAndMeasure(-6);
    const deep = await renderAndMeasure(-24);
    expect(deep.duckDb).toBeLessThan(shallow.duckDb);
  });

  it("reductionDb 0 does not duck at all", async () => {
    const { duckDb } = await renderAndMeasure(0);
    expect(Math.abs(duckDb)).toBeLessThan(0.5);
  });

  /**
   * The same real-ffmpeg treatment for N sidechains. The envelope is built by
   * summing every sidechain and running the duck law ONCE — so the measurement
   * that matters is per-half: the bed must dip under whichever voice speaks.
   */
  async function renderMultiBed(
    tag: string,
    voices: { id: string; path: string }[],
    reductionDb = -12,
  ): Promise<{ firstHalfRms: number; secondHalfRms: number; clippedFraction: number; peak: number }> {
    const duck = sanitizeDuck({ ...DEFAULT_DUCK, sidechainClipIds: voices.map((v) => v.id), reductionDb });
    const base = { trimStart: 0, duration: DUR, startTime: 0 };
    const clips = [
      { id: "music", fileId: "m", ...base, volume: 0.8, duck },
      ...voices.map((v) => ({ id: v.id, fileId: v.id, ...base, volume: 1 })),
    ] as unknown as AudioClip[];

    const envelopes = await renderDuckEnvelopes({
      inputs: [{
        clipId: "music",
        duck,
        sidechains: voices.map((v) => ({
          path: v.path, startTime: 0, trimStart: 0, duration: DUR, volume: 1,
        })),
      }],
      timelineSeconds: DUR,
      outDir: dir,
    });
    const envPath = envelopes.get("music");
    expect(envPath, "an envelope must be rendered").toBeTruthy();

    const inputPaths = [music, ...voices.map((v) => v.path), envPath!];
    const inputIndex = new Map<string, number>([
      ["music", 0],
      ...voices.map((v, i) => [v.id, i + 1] as [string, number]),
    ]);
    const envelopeIndex = new Map([["music", inputPaths.length - 1]]);
    const ffArgs = (chain: string, out: string) => [
      "-v", "error", "-y",
      ...inputPaths.flatMap((p) => ["-i", p]),
      "-filter_complex", chain, "-map", "[aout]",
      "-c:a", "pcm_s16le", "-ar", "44100", out,
    ];

    // The BED alone carries the duck measurement — the full mix contains the
    // voices, which are loud in exactly the halves being compared.
    const bedGraph = buildAudioMixGraph({ clips: [clips[0]], inputIndex, envelopeIndex, mixDuration: "longest" });
    const bedOut = path.join(dir, `multi-bed-${tag}.wav`);
    execFileSync("ffmpeg", ffArgs(bedGraph.chain!, bedOut));
    const bed = measure(bedOut);

    const full = buildAudioMixGraph({ clips, inputIndex, envelopeIndex, mixDuration: "longest" });
    const fullOut = path.join(dir, `multi-mix-${tag}.wav`);
    execFileSync("ffmpeg", ffArgs(full.chain!, fullOut));
    const pcm = readPcm(fullOut);
    const total = Math.floor(pcm.length / 2);
    let clipped = 0;
    let peak = 0;
    for (let i = 0; i < total; i++) {
      const v = Math.abs(pcm.readInt16LE(i * 2)) / 32768;
      if (v >= 0.9995) clipped++;
      if (v > peak) peak = v;
    }
    return { ...bed, clippedFraction: clipped / total, peak };
  }

  it("ducks under EVERY sidechain — both voice lines, not just the first", async () => {
    // THE feature. `vo` speaks in the first half, `voLate` in the second; a
    // single-sidechain duck leaves whichever half it does not cover at full
    // level, which is what forced a real piece to bounce six VO lines into one
    // 42-second bus file and re-render it on every retime.
    const undicked = await renderMultiBed("undicked", [{ id: "vo", path: vo }], 0);
    const both = await renderMultiBed("both", [
      { id: "vo", path: vo },
      { id: "voLate", path: voLate },
    ]);
    const firstDb = 20 * Math.log10(both.firstHalfRms / undicked.firstHalfRms);
    const secondDb = 20 * Math.log10(both.secondHalfRms / undicked.secondHalfRms);
    expect(firstDb, `first half ducked ${firstDb.toFixed(1)} dB`).toBeLessThan(-4);
    expect(secondDb, `second half ducked ${secondDb.toFixed(1)} dB`).toBeLessThan(-4);
  });

  it("leaves the half no sidechain covers alone — the single-sidechain baseline", async () => {
    // The contrast that makes the test above mean something: with ONLY the
    // first voice as sidechain, the second half is essentially untouched (all
    // that reaches it is the 250 ms release tail), where two sidechains duck it
    // by more than 4 dB.
    const undicked = await renderMultiBed("base-undicked", [{ id: "vo", path: vo }], 0);
    const one = await renderMultiBed("one", [{ id: "vo", path: vo }]);
    const secondDb = 20 * Math.log10(one.secondHalfRms / undicked.secondHalfRms);
    expect(Math.abs(secondDb), `unducked half moved ${secondDb.toFixed(2)} dB`).toBeLessThan(1.5);
  });

  it("does not double-duck where two sidechains overlap", async () => {
    // Two voices in the SAME half. Summing then curving once bottoms out at the
    // reduction floor (-12 dB). A curve per clip, multiplied together, would
    // reach roughly -24 dB — audibly a hole in the bed.
    const undicked = await renderMultiBed("ov-undicked", [{ id: "vo", path: vo }], 0);
    const overlapped = await renderMultiBed("ov", [
      { id: "vo", path: vo },
      { id: "voOverlap", path: voOverlap },
    ]);
    const db = 20 * Math.log10(overlapped.firstHalfRms / undicked.firstHalfRms);
    expect(db, `overlapping sidechains ducked ${db.toFixed(1)} dB`).toBeLessThan(-4);
    expect(db, `overlapping sidechains ducked ${db.toFixed(1)} dB — floor is -12`).toBeGreaterThan(-15);
  });

  it("a multi-sidechain mix does not clip", async () => {
    const { clippedFraction, peak } = await renderMultiBed("clip", [
      { id: "vo", path: vo },
      { id: "voLate", path: voLate },
      { id: "voOverlap", path: voOverlap },
    ]);
    expect(clippedFraction).toBeLessThan(0.001);
    expect(peak).toBeLessThanOrEqual(1);
  });

  it("ducking only ever makes the target quieter, never louder", async () => {
    // The undicked mix is the ceiling; a deeper duck must not exceed it.
    const undicked = await renderAndMeasure(0);
    for (const reductionDb of [-6, -12, -30]) {
      const ducked = await renderAndMeasure(reductionDb);
      expect(ducked.peak).toBeLessThanOrEqual(undicked.peak + 1e-6);
    }
  });
});
