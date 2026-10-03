/**
 * Seed and verify hooks for `03-insert-time-folder.md`.
 *
 * SEED: a folder of three 9:16 copies, sharing every id, each:
 *   0.0 – 5.0   intro video (a 12 s source clip trimmed to 0–5, with its own inline sound)
 *   0.0 – 20.5  backdrop (code, full-length) and a music bed (30 s song, standalone, 0–20.5)
 *   5.3 – 16.3  narration clip (11 s speech) and a caption text over it
 *  16.5 – 20.5  end card (code)
 *
 * VERIFY (outcomes only): in every piece the intro is 8 s with its trim and inline sound, the
 * narration, caption and end card sit exactly 3 s later, and the two full-length layers (backdrop,
 * music bed) grew to still cover the 23.5 s piece. How the agent got there is not checked here: the
 * scenario's ceilings cap the call count, the matchers check it used `insert_time`.
 */
import type { ScenarioHookContext, StateCheck } from "../../../scripts/skill-eval/types";
import { BACKDROP_BODY, call, duplicatesOf, f2, fixtureOf, folderWithFirstPiece, near, readManifest, runTool, upload, withRollup, type Manifest } from "./_shared";

export const FOLDER_NAME = "Harbor Tour — 3 cuts";
export const T = { introDur: 5, narrStart: 5.3, narrDur: 11, endStart: 16.5, endDur: 4, total: 20.5, by: 3 } as const;

export interface SeedState {
  folderId: string;
  videoId: string;
  captionId: string;
  endCardId: string;
  backdropId: string;
  narrationClipId: string;
  musicClipId: string;
  pieces: Array<{ pieceId: string; name: string }>;
}

export async function seed(ctx: ScenarioHookContext): Promise<{ placeholders: Record<string, string>; state: SeedState }> {
  const { base } = ctx;
  const p1 = ctx.pieceId;
  const names = ["Harbor Tour · Day", "Harbor Tour · Dusk", "Harbor Tour · Night"];
  const folderId = await folderWithFirstPiece(ctx, FOLDER_NAME, names[0]);
  await call(base, "PATCH", `/api/pieces/${p1}/composition/dimensions`, { width: 1080, height: 1920 });
  const introFile = await upload(base, p1, fixtureOf(ctx, "intro-clip-12s.mp4"), "Original clip");
  const narrationFile = await upload(base, p1, fixtureOf(ctx, "jfk.wav"), "Narration");
  const songFile = await upload(base, p1, fixtureOf(ctx, "tidewater-lights-30s.m4a"), "Bed (song)");

  const backdrop = await runTool<{ overlayId: string }>(base, "libi.add_overlay", {
    pieceId: p1, kind: "code", startTime: 0, duration: T.total, rect: { x: 0, y: 0, width: 1080, height: 1920 }, body: BACKDROP_BODY, displayName: "Backdrop", z: 0,
  });
  const video = await runTool<{ overlayId: string }>(base, "libi.add_overlay", {
    pieceId: p1, kind: "video", fileId: introFile, startTime: 0, duration: T.introDur, trim: { start: 0, end: T.introDur }, displayName: "Intro",
  });
  const narration = await runTool<{ clipId?: string; clip?: { id: string } }>(base, "libi.audio_add_clip", {
    pieceId: p1, fileId: narrationFile, kind: "standalone", startTime: T.narrStart, duration: T.narrDur, label: "narration",
  });
  const music = await runTool<{ clipId?: string; clip?: { id: string } }>(base, "libi.audio_add_clip", {
    pieceId: p1, fileId: songFile, kind: "standalone", startTime: 0, duration: T.total, label: "music bed",
  });
  const narrationClipId = narration.clipId ?? narration.clip?.id;
  const musicClipId = music.clipId ?? music.clip?.id;
  if (!narrationClipId || !musicClipId) throw new Error(`audio_add_clip returned no clip id: ${JSON.stringify({ narration, music })}`);
  const caption = await runTool<{ overlayId: string }>(base, "libi.add_overlay", {
    pieceId: p1, kind: "text", startTime: T.narrStart, duration: T.narrDur, rect: { x: 90, y: 1500, width: 900, height: 220 },
    content: "Ask not what your country can do for you", color: "#FFFFFF", displayName: "Caption", z: 2,
  });
  const endCard = await runTool<{ overlayId: string }>(base, "libi.add_overlay", {
    pieceId: p1, kind: "code", startTime: T.endStart, duration: T.endDur, rect: { x: 0, y: 0, width: 1080, height: 1920 }, body: BACKDROP_BODY, displayName: "End card", z: 3,
  });
  const copies = await duplicatesOf(ctx, p1, folderId, names.slice(1));
  return {
    placeholders: { folder: FOLDER_NAME },
    state: {
      folderId,
      videoId: video.overlayId,
      captionId: caption.overlayId,
      endCardId: endCard.overlayId,
      backdropId: backdrop.overlayId,
      narrationClipId,
      musicClipId,
      pieces: [{ pieceId: p1, name: names[0] }, ...copies],
    },
  };
}

/** All checks for one piece's composition. Exported for the unit test. */
export function checkPiece(manifest: Manifest, ids: Omit<SeedState, "folderId" | "pieces">, piece: { name: string }): StateCheck[] {
  const overlays = manifest.overlays ?? [];
  const clips = manifest.audioClips ?? [];
  const out: StateCheck[] = [];
  const check = (name: string, pass: boolean, detail: string) => out.push({ name: `${piece.name}: ${name}`, pass, detail });
  const by = T.by;
  const video = overlays.find((o) => o.id === ids.videoId);
  const caption = overlays.find((o) => o.id === ids.captionId);
  const endCard = overlays.find((o) => o.id === ids.endCardId);
  const backdrop = overlays.find((o) => o.id === ids.backdropId);
  const narration = clips.find((c) => c.id === ids.narrationClipId);
  const music = clips.find((c) => c.id === ids.musicClipId);
  const inline = clips.find((c) => c.kind === "inline" && c.linkedOverlayId === ids.videoId);
  const pieceEnd = T.total + by;

  check(
    "intro is 3 s longer, with its trim",
    !!video && near(video.startTime, 0) && near(video.duration, T.introDur + by) && (!video.trim || near(video.trim.end - video.trim.start, video.duration)),
    video ? `video ${f2(video.startTime)}+${f2(video.duration)} trim ${video.trim ? `${f2(video.trim.start)}-${f2(video.trim.end)}` : "none"}` : "no intro overlay",
  );
  check("intro's own sound is 3 s longer", !!inline && near(inline.startTime, 0) && near(inline.duration, T.introDur + by), inline ? `inline ${f2(inline.startTime)}+${f2(inline.duration)}` : "no inline clip");
  check("narration moved +3 s", !!narration && near(narration.startTime, T.narrStart + by) && near(narration.duration, T.narrDur), narration ? `narration ${f2(narration.startTime)}+${f2(narration.duration)}` : "no narration clip");
  check("caption moved +3 s", !!caption && near(caption.startTime, T.narrStart + by) && near(caption.duration, T.narrDur), caption ? `caption ${f2(caption.startTime)}+${f2(caption.duration)}` : "no caption");
  check("end card moved +3 s", !!endCard && near(endCard.startTime, T.endStart + by) && near(endCard.duration, T.endDur), endCard ? `end card ${f2(endCard.startTime)}+${f2(endCard.duration)}` : "no end card");
  check("backdrop still covers the piece", !!backdrop && near(backdrop.startTime, 0) && near(backdrop.duration, pieceEnd), backdrop ? `backdrop ${f2(backdrop.startTime)}+${f2(backdrop.duration)} (piece ends ${f2(pieceEnd)})` : "no backdrop");
  check("music bed still covers the piece", !!music && near(music.startTime, 0) && music.startTime + music.duration >= pieceEnd - 0.15, music ? `bed ${f2(music.startTime)}+${f2(music.duration)} (piece ends ${f2(pieceEnd)})` : "no music bed");
  check("nothing overlaps the intro", !!narration && !!video && narration.startTime >= video.startTime + video.duration, "narration starts after the intro ends");
  return out;
}

export async function verify(ctx: ScenarioHookContext & { state: unknown }): Promise<StateCheck[]> {
  const state = ctx.state as SeedState;
  const out: StateCheck[] = [];
  for (const p of state.pieces) {
    try {
      out.push(...checkPiece(await readManifest(ctx.base, p.pieceId), state, p));
    } catch (e) {
      out.push({ name: `${p.name}: composition readable`, pass: false, detail: (e as Error).message });
    }
  }
  return withRollup(`all ${state.pieces.length} pieces right`, out);
}
