/** What music a piece plays, by rights class (spec §4.4, §5, §6.1). Pure, client-safe. */
import type { CompositionManifest } from "@/lib/composition/persistence";
import { pieceDurationSec } from "@/lib/composition/duration";
import { effectiveRights, type RightsFileLike } from "./read";
import type { AudioRights } from "./types";

export const COPYRIGHTED_CLIP_NOTE = "left out of social exports by default; at posting each platform gets its own treatment";

export interface PieceSong {
  fileId: string;
  name: string;
  rights: AudioRights;
  /** Total seconds this file is audible on the timeline. */
  clipSeconds: number;
  /** The file's type ("audio" | "video"), for the export dialog's icon. */
  fileType?: string | null;
  /** The earliest clip's timeline start, its trim into the source, its volume (0..1). */
  firstStart: number;
  firstTrimStart: number;
  volume: number;
}

export interface PieceAudio {
  copyrighted: PieceSong[];
  ownMusic: PieceSong[];
  durationSec: number;
}

export type PieceFileLike = RightsFileLike & { id: string; name: string };

export function pieceAudioOf(manifest: Pick<CompositionManifest, "overlays" | "audioClips">, files: PieceFileLike[]): PieceAudio {
  const byId = new Map(files.map((f) => [f.id, f]));
  const songs = new Map<string, PieceSong>();
  const clips = [...(manifest.audioClips ?? [])].sort((a, b) => a.startTime - b.startTime);
  for (const c of clips) {
    if (c.enabled === false || !(c.volume > 0)) continue;
    const file = byId.get(c.fileId);
    if (!file) continue;
    const rights = effectiveRights(file);
    if (!rights) continue;
    const s = songs.get(c.fileId);
    if (s) s.clipSeconds += c.duration;
    else songs.set(c.fileId, { fileId: c.fileId, name: file.name, rights, clipSeconds: c.duration, fileType: file.type, firstStart: c.startTime, firstTrimStart: c.trimStart, volume: c.volume });
  }
  const all = [...songs.values()].sort((a, b) => b.clipSeconds - a.clipSeconds);
  return {
    copyrighted: all.filter((s) => s.rights.class === "copyrighted"),
    ownMusic: all.filter((s) => s.rights.class !== "copyrighted"),
    durationSec: pieceDurationSec(manifest),
  };
}
