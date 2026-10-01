/**
 * Which audio an export carries (spec §5; addendum §7: any file can be left
 * out). Pure.
 *
 * Applied to the MANIFEST by `renderExport` (lib/jobs/runners/export.ts), not
 * inside `audio-mix.ts`: a video layer's sound is an inline AudioClip, so
 * dropping the clips of an excluded file removes a standalone song AND a
 * video's soundtrack while the picture stays — for every backend at once.
 */
import type { CompositionManifest } from "@/lib/composition/persistence";
import { pieceAudioOf, type PieceFileLike, type PieceSong } from "@/lib/audio-rights/piece-audio";
import { songLabel } from "@/lib/audio-rights/types";

export type ExportPurpose = "social" | "personal";

export interface ExportAudioOptions {
  purpose?: ExportPurpose;
  copyrightedAudio?: "exclude" | "include";
  includeFileIds?: string[];
  /** Any files to leave out (the dialog's Include switches), copyrighted or
   *  not. Wins over includeFileIds. */
  excludeFileIds?: string[];
}

export interface AudioDecision {
  purpose: ExportPurpose | null;
  excludedFileIds: string[];
  carriesCopyrighted: boolean;
}

export interface ResolvedExportAudio {
  excludedFileIds: string[];
  carriesCopyrighted: boolean;
  decision: AudioDecision;
}

export function resolveExportAudio(
  manifest: Pick<CompositionManifest, "overlays" | "audioClips">,
  files: PieceFileLike[],
  opts: ExportAudioOptions,
): ResolvedExportAudio {
  const songs = pieceAudioOf(manifest, files).copyrighted;
  const mode = opts.copyrightedAudio ?? (opts.purpose === "social" ? "exclude" : "include");
  const keep = new Set(opts.includeFileIds ?? []);
  const plays = new Set((manifest.audioClips ?? []).map((c) => c.fileId));
  const dropped = (opts.excludeFileIds ?? []).filter((id) => plays.has(id));
  const copyrightedOut = mode === "exclude" ? songs.filter((s) => !keep.has(s.fileId)).map((s) => s.fileId) : [];
  const excludedFileIds = [...new Set([...copyrightedOut, ...dropped])].sort();
  const carriesCopyrighted = songs.some((s) => !excludedFileIds.includes(s.fileId));
  return { excludedFileIds, carriesCopyrighted, decision: { purpose: opts.purpose ?? null, excludedFileIds, carriesCopyrighted } };
}

export function applyAudioExclusion<C extends { fileId: string }>(clips: C[] | undefined, excludedFileIds: readonly string[]): C[] {
  if (!clips) return [];
  if (excludedFileIds.length === 0) return clips;
  const out = new Set(excludedFileIds);
  return clips.filter((c) => !out.has(c.fileId));
}

export function sameDecision(a: AudioDecision | null | undefined, b: AudioDecision): boolean {
  if (!a) return false;
  if (a.carriesCopyrighted !== b.carriesCopyrighted) return false;
  const x = [...a.excludedFileIds].sort();
  const y = [...b.excludedFileIds].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

export function songsLabel(songs: PieceSong[]): string {
  return songs.map((s) => (s.rights.track ? songLabel(s.rights.track) : s.name)).join(", ");
}

export function purposeRequiredMessage(songs: PieceSong[]): string {
  return (
    `This piece has copyrighted music (${songsLabel(songs)}). ` +
    "Ask the user what this export is for — a social post or personal use — then pass `purpose`. " +
    "If they asked to post it, use libi.post_piece instead, which exports per platform."
  );
}
