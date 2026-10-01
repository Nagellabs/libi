import type { DuckSettings } from "@/lib/engine/types";

/** A template's song that was left out on apply (social-music spec §7). Lives in
 *  the piece's composition until `libi.fetch_template_music` places it. */
export interface PendingMusicClip {
  startTime: number;
  duration: number;
  trimStart: number;
  volume: number;
  /** The template clip's own flag. Absent on an entry written before it was
   *  carried: placed enabled. */
  enabled?: boolean;
  /** The template clip's duck, its sidechains already CLIP IDS in this piece
   *  (re-minted at apply, like a created clip's). */
  duck?: DuckSettings;
}

export interface PendingMusic {
  assetId: string;
  templateId: string;
  track: { title: string; artist?: string };
  sourceUrl?: string;
  clips: PendingMusicClip[];
}

export const PENDING_MUSIC_NOTE =
  "This template's music was not included (pendingMusic lists it). Tell the user which song, ask whether to download it, and on their yes call libi.fetch_template_music({ pieceId, assetId }) for each entry. An entry with no sourceUrl needs a file or link from the user.";
