/** The export dialog's audio choices (addendum §7). Pure. */
import type { AudioRightsClass } from "@/lib/audio-rights/types";
/** One `ExportPurpose` type for the whole feature — `lib/export/audio-policy.ts`
 *  defines it (the export API's own options shape); re-exported here so the
 *  dialog and its pure helpers don't redefine an identical union. */
import type { ExportPurpose } from "@/lib/export/audio-policy";

export type { ExportPurpose };

export interface ExportAudioTrack {
  fileId: string;
  label: string;
  /** "audio" | "video" — the row's icon. */
  fileType: string | null;
  /** null = unknown (read as not copyrighted: on by default). */
  rights: AudioRightsClass | null;
  /** Under a copyrighted track: what each connected platform does with it. */
  platformsLine?: string;
}

/** The user's own toggles, by file. */
export type IncludeOverrides = Readonly<Record<string, boolean>>;

export function defaultIncluded(t: ExportAudioTrack, purpose: ExportPurpose): boolean {
  return t.rights !== "copyrighted" || purpose === "personal";
}

export function isIncluded(t: ExportAudioTrack, purpose: ExportPurpose, overrides: IncludeOverrides): boolean {
  return overrides[t.fileId] ?? defaultIncluded(t, purpose);
}

/** A purpose switch re-applies the default to copyrighted tracks only; every other toggle survives. */
export function overridesAfterPurpose(tracks: ExportAudioTrack[], overrides: IncludeOverrides): IncludeOverrides {
  const out: Record<string, boolean> = { ...overrides };
  for (const t of tracks) if (t.rights === "copyrighted") delete out[t.fileId];
  return out;
}

export function audioRequest(tracks: ExportAudioTrack[], purpose: ExportPurpose, overrides: IncludeOverrides) {
  return {
    purpose,
    copyrightedAudio: "exclude" as const,
    includeFileIds: tracks.filter((t) => t.rights === "copyrighted" && isIncluded(t, purpose, overrides)).map((t) => t.fileId),
    excludeFileIds: tracks.filter((t) => t.rights !== "copyrighted" && !isIncluded(t, purpose, overrides)).map((t) => t.fileId),
  };
}

/** "MP4 · 1080p · 2 of 3 audio tracks" */
export function exportSummary(format: "mp4" | "webm", qualityLabel: string, tracks: ExportAudioTrack[], purpose: ExportPurpose, overrides: IncludeOverrides): string {
  const on = tracks.filter((t) => isIncluded(t, purpose, overrides)).length;
  const audio = tracks.length === 0 ? "no audio" : `${on} of ${tracks.length} audio track${tracks.length === 1 ? "" : "s"}`;
  return `${format.toUpperCase()} · ${qualityLabel} · ${audio}`;
}
