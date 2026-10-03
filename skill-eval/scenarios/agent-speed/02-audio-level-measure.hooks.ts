/**
 * Seed and verify hooks for `02-audio-level-measure.md`.
 *
 * SEED: one 9:16 piece, "Tidewater (single)": a full-length backdrop, an 11 s narration at 5.3 s, an end card
 * at 16.5–20.5, and a 30 s song (stamped copyrighted, with a track title) already on the timeline as a
 * standalone clip, 0–20.5, at full level, with no duck and no envelope: too loud under the voice.
 *
 * VERIFY (outcomes only): the song is still ONE clip on the ORIGINAL file (nothing was mixed or baked and
 * re-uploaded: no new audio file in the piece), audible the whole way, and the level model says it plays
 * 10 dB (±1.5) under the narration relative to its level over the end card, which stays at full level
 * (−1 … +3 dB). The level is the manifest's effective gain: volume × `gainDb` × the volume envelope, times the
 * duck's reduction while its sidechain clip plays (fades ignored; probes sit away from edges).
 */
import type { ScenarioHookContext, StateCheck } from "../../../scripts/skill-eval/types";
import { musicLevelAt } from "../_bench/dreams-six-pieces.hooks";
import { BACKDROP_BODY, call, f2, fixtureOf, near, readManifest, runTool, upload, type Clip, type Manifest } from "./_shared";

export const PIECE_NAME = "Tidewater (single)";
export const SONG = { title: "Tidewater Lights", artist: "The Bench Band" } as const;
export const T = { narrStart: 5.3, narrDur: 11, endStart: 16.5, endDur: 4, total: 20.5 } as const;

export interface SeedState {
  pieceId: string;
  narrationFileId: string;
  songFileId: string;
  narrationClipId: string;
  musicClipId: string;
}

export async function seed(ctx: ScenarioHookContext): Promise<{ placeholders: Record<string, string>; state: SeedState }> {
  const { base } = ctx;
  const p = ctx.pieceId;
  await call(base, "PATCH", `/api/pieces/${p}`, { name: PIECE_NAME });
  await call(base, "PATCH", `/api/pieces/${p}/composition/dimensions`, { width: 1080, height: 1920 });
  const narrationFileId = await upload(base, p, fixtureOf(ctx, "jfk.wav"), "Narration");
  const songFileId = await upload(base, p, fixtureOf(ctx, "tidewater-lights-30s.m4a"), `${SONG.title} (song)`);
  await call(base, "PATCH", `/api/files/by-id/${songFileId}/audio-rights`, { class: "copyrighted", track: { ...SONG } });
  await runTool(base, "libi.add_overlay", { pieceId: p, kind: "code", startTime: 0, duration: T.total, rect: { x: 0, y: 0, width: 1080, height: 1920 }, body: BACKDROP_BODY, displayName: "Backdrop", z: 0 });
  await runTool(base, "libi.add_overlay", { pieceId: p, kind: "code", startTime: T.endStart, duration: T.endDur, rect: { x: 0, y: 0, width: 1080, height: 1920 }, body: BACKDROP_BODY, displayName: "End card", z: 3 });
  const narration = await runTool<{ clipId?: string; clip?: { id: string } }>(base, "libi.audio_add_clip", {
    pieceId: p, fileId: narrationFileId, kind: "standalone", startTime: T.narrStart, duration: T.narrDur, label: "narration",
  });
  const music = await runTool<{ clipId?: string; clip?: { id: string } }>(base, "libi.audio_add_clip", {
    pieceId: p, fileId: songFileId, kind: "standalone", startTime: 0, duration: T.total, label: "song",
  });
  const narrationClipId = narration.clipId ?? narration.clip?.id;
  const musicClipId = music.clipId ?? music.clip?.id;
  if (!narrationClipId || !musicClipId) throw new Error(`audio_add_clip returned no clip id: ${JSON.stringify({ narration, music })}`);
  await call(base, "POST", `/api/pieces/${p}/snapshot/commit`, { summary: "Seeded" });
  return { placeholders: { piece: PIECE_NAME }, state: { pieceId: p, narrationFileId, songFileId, narrationClipId, musicClipId } };
}

const dB = (x: number): number => 20 * Math.log10(x);

/** All checks for the piece's composition and its audio file count. Exported for the unit test. */
export function checkPiece(manifest: Manifest, audioFileCount: number, ids: SeedState): StateCheck[] {
  const clips: Clip[] = manifest.audioClips ?? [];
  const out: StateCheck[] = [];
  const check = (name: string, pass: boolean, detail: string) => out.push({ name, pass, detail });
  const narration = clips.find((c) => c.id === ids.narrationClipId);
  const music = clips.filter((c) => c.kind === "standalone" && c.id !== ids.narrationClipId && c.fileId !== ids.narrationFileId);

  check("nothing was baked: no audio file besides the narration and the song", audioFileCount === 2, `${audioFileCount} audio file(s) in the piece`);
  check("the song is still on its original file", music.length >= 1 && music.every((c) => c.fileId === ids.songFileId), `${music.length} music clip(s) on [${[...new Set(music.map((c) => c.fileId.slice(-6)))].join(", ")}]`);
  check("the narration is untouched", !!narration && narration.enabled && near(narration.startTime, T.narrStart) && near(narration.duration, T.narrDur) && near(narration.volume, 1, 0.01), narration ? `narration ${f2(narration.startTime)}+${f2(narration.duration)} v${f2(narration.volume)}` : "no narration clip");

  const gaps: string[] = [];
  for (let t = 0.5; t <= T.total - 0.5; t += 0.5) if (musicLevelAt(t, music, clips) <= 0) gaps.push(t.toFixed(1));
  check("the song plays the whole way", music.length >= 1 && gaps.length === 0, gaps.length ? `silent at ${gaps.slice(0, 5).join(", ")}` : "audible from 0.5 s to the end");

  const underT = T.narrStart + T.narrDur / 2;
  const overT = T.endStart + 1;
  const under = musicLevelAt(underT, music, clips);
  const over = musicLevelAt(overT, music, clips);
  const overDb = over > 0 ? dB(over) : -Infinity;
  const diff = under > 0 && over > 0 ? dB(under) - dB(over) : NaN;
  check("over the end card the song is at full level", over > 0 && overDb >= -1 && overDb <= 3, `end card level ${f2(over)} (${f2(overDb)} dB; −1 … +3 wanted)`);
  check("under the narration it is 10 dB quieter than over the end card", Number.isFinite(diff) && diff >= -11.5 && diff <= -8.5, `under narration ${f2(under)}, over end card ${f2(over)}: ${f2(diff)} dB (−11.5 … −8.5 wanted)`);
  return out;
}

export async function verify(ctx: ScenarioHookContext & { state: unknown }): Promise<StateCheck[]> {
  const state = ctx.state as SeedState;
  try {
    const manifest = await readManifest(ctx.base, state.pieceId);
    const files = (await call(ctx.base, "GET", `/api/pieces/${state.pieceId}/files`)) as { files: Array<{ id: string; mimeType?: string; type?: string; category?: string; filename: string }> };
    const audio = files.files.filter((f) => /^audio\//.test(f.mimeType ?? "") || f.category === "audio" || f.type === "audio" || /\.(wav|m4a|mp3|aac|flac|ogg)$/i.test(f.filename));
    return checkPiece(manifest, audio.length, state);
  } catch (e) {
    return [{ name: "composition readable", pass: false, detail: (e as Error).message }];
  }
}
