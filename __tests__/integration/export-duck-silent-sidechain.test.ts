/**
 * Integration: the EXPORT keeps a ducked music clip at full level wherever its
 * sidechain is silent or absent, and ducks it under the sidechain. Real ffmpeg:
 * the envelope is rendered by `renderDuckEnvelopes` (the duck law), multiplied
 * in by `buildAudioMixGraph`, and the resulting audio is measured per segment.
 *
 * Counterpart of the preview-side tests (sidechain-worklet-silence): the
 * preview once muted the music wherever the narration was not playing; this
 * pins that the export has no such shape and cannot grow one.
 *
 * The music is mixed ALONE (the narration only drives the envelope) so the
 * measured level is the music's, not music plus voice.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync, execSync, spawnSync } from "child_process";
import { renderDuckEnvelopes, type PlacedSidechain } from "@/lib/export/duck-envelopes";
import { buildAudioMixGraph } from "@/lib/export/audio-mix";
import type { AudioClip, DuckSettings } from "@/lib/engine/types";

function hasFfmpeg(): boolean {
  try { execSync("ffmpeg -version", { stdio: "ignore", timeout: 2000 }); return true; }
  catch { return false; }
}
const ffmpegPresent = hasFfmpeg();
if (!ffmpegPresent) console.info("[skip] export duck silent sidechain — ffmpeg not on PATH");
const skipIf = ffmpegPresent ? describe : describe.skip;

const DUCK: DuckSettings = { sidechainClipIds: ["vo"], thresholdDb: -30, ratio: 4, attackMs: 50, releaseMs: 250, reductionDb: -12 };
const TOTAL = 14; // seconds
const VO_AT = 3;
const VO_LEN = 4;

let dir: string;
let music: string;
let vo: string;
let reference: string;

function ff(args: string[]): void {
  execFileSync("ffmpeg", ["-hide_banner", "-nostdin", "-y", ...args], { stdio: ["ignore", "pipe", "pipe"] });
}

/** Mean volume (dB) of [from, to) of a file, via volumedetect. */
function volume(file: string, from: number, to: number): number {
  const r = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-nostdin", "-ss", String(from), "-t", String(to - from), "-i", file, "-af", "volumedetect", "-f", "null", "-"],
    { encoding: "utf8" },
  );
  const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(r.stderr);
  if (!m) throw new Error(`no volumedetect output for ${file}: ${r.stderr}`);
  return parseFloat(m[1]);
}

const musicClip = (duck: DuckSettings | undefined): AudioClip => ({
  id: "music", kind: "standalone", fileId: "f", startTime: 0, duration: TOTAL, trimStart: 0, volume: 1, enabled: true,
  ...(duck ? { duck } : {}),
});

/** Export just the music clip, ducked by `sidechains` (none ⇒ no envelope, like the export does). */
async function exportMusic(sidechains: PlacedSidechain[], name: string): Promise<string> {
  const inputPaths = [music];
  const envelopeIndex = new Map<string, number>();
  if (sidechains.length > 0) {
    const envs = await renderDuckEnvelopes({
      inputs: [{ clipId: "music", duck: DUCK, sidechains }],
      timelineSeconds: TOTAL,
      outDir: dir,
    });
    inputPaths.push(envs.get("music")!);
    envelopeIndex.set("music", 1);
  }
  const { chain } = buildAudioMixGraph({
    baseAudio: null,
    clips: [musicClip(DUCK)],
    inputIndex: new Map([["music", 0]]),
    envelopeIndex,
    mixDuration: "longest",
    inputChannels: new Map([[0, 1]]),
  });
  const out = path.join(dir, `${name}.wav`);
  ff([...inputPaths.flatMap((p) => ["-i", p]), "-filter_complex", chain!, "-map", "[aout]", "-t", String(TOTAL), out]);
  return out;
}

const placed = (p: string): PlacedSidechain => ({ path: p, startTime: VO_AT, trimStart: 0, duration: VO_LEN, volume: 1 });

const BEFORE = [0.3, VO_AT - 0.2] as const;
const DURING = [VO_AT + 2, VO_AT + VO_LEN - 0.3] as const;
// Well past the release tail, to the end of the piece.
const AFTER = [VO_AT + VO_LEN + 4, TOTAL - 0.3] as const;

skipIf("export: ducked music vs a silent / absent sidechain", () => {
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-duck-export-"));
    music = path.join(dir, "music.wav");
    vo = path.join(dir, "vo.wav");
    reference = path.join(dir, "reference.wav");
    // Music: a 440 Hz bed for the whole piece. Narration: loud noise.
    ff(["-f", "lavfi", "-i", `sine=frequency=440:duration=${TOTAL}:sample_rate=44100`, "-af", "volume=0.3", "-ac", "1", music]);
    ff(["-f", "lavfi", "-i", `anoisesrc=color=white:amplitude=0.7:duration=${VO_LEN}:sample_rate=44100`, "-ac", "1", vo]);
    // The music un-ducked, upmixed at unity like the export (ffmpeg's own -ac 2 is -3 dB).
    ff(["-i", music, "-af", "pan=stereo|c0=c0|c1=c0", reference]);
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("keeps the music at full level before and after the narration, and ducks it during", async () => {
    const out = await exportMusic([placed(vo)], "ducked");
    expect(volume(out, ...BEFORE)).toBeCloseTo(volume(reference, ...BEFORE), 0);
    expect(volume(out, ...AFTER)).toBeCloseTo(volume(reference, ...AFTER), 0);
    expect(volume(out, ...AFTER)).toBeGreaterThan(-40); // audible (the bed sits near -31.5 dB), not muted
    // The duck: at least 6 dB down while the narration plays (the floor is -12).
    expect(volume(out, ...DURING)).toBeLessThan(volume(reference, ...DURING) - 6);
    expect(volume(out, ...DURING)).toBeGreaterThan(volume(reference, ...DURING) - 13);
  });

  it("mixes the music at full level when no sidechain survives (no envelope is rendered)", async () => {
    const out = await exportMusic([], "no-sidechain");
    for (const [a, b] of [BEFORE, DURING, AFTER] as const) {
      expect(volume(out, a, b)).toBeCloseTo(volume(reference, a, b), 0);
    }
  });

  it("a SILENT sidechain file leaves the music at full level throughout", async () => {
    const silentVo = path.join(dir, "silent-vo.wav");
    ff(["-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", String(VO_LEN), silentVo]);
    const out = await exportMusic([placed(silentVo)], "silent-sidechain");
    for (const [a, b] of [BEFORE, DURING, AFTER] as const) {
      expect(volume(out, a, b)).toBeCloseTo(volume(reference, a, b), 0);
    }
  });
});
