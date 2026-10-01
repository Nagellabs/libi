/**
 * The ONE reader of a file's audio rights (spec §4.1). Timeline badge, export
 * policy, posting plans and templates all call `effectiveRights`, so "no
 * stamp" can never mean one thing in one place and another elsewhere.
 * Client-safe: no db, no fs.
 */
import { parseAudioRights, type AudioRights } from "./types";
import { generatedStamp, ownedByProvenance } from "./stamp";

export interface RightsFileLike {
  type: string | null;
  hasAudio: boolean | null;
  audioRights: string | null;
  createdAt?: Date | string | number | null;
  /** Provenance, read only when `audioRights` is null: a file made before
   *  rights existed (see `unstampedRights`). Every server-side row
   *  selection feeding this reader must carry both. */
  aiGeneration?: string | null;
  description?: string | null;
}

/** An audio file always does; a video does unless ffprobe said it has no audio stream. */
export function fileCarriesAudio(f: RightsFileLike): boolean {
  if (f.type === "audio") return true;
  if (f.type === "video") return f.hasAudio !== false;
  return false;
}

function isoOf(v: RightsFileLike["createdAt"]): string {
  if (v == null) return new Date(0).toISOString();
  const d = v instanceof Date ? v : new Date(typeof v === "number" && v < 1e12 ? v * 1000 : v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : new Date(0).toISOString();
}

/** `libi.generate_music` (ACE-Step) wrote this description before it stamped
 *  rights; it never set `aiGeneration`. */
const ACE_STEP_DESCRIPTION_PREFIX = "[Music] ";

/** The yt-dlp runner (`lib/jobs/runners/video-download.ts`) has always written
 *  this breadcrumb; before rights existed it was the only mark of a download. */
const DOWNLOAD_DESCRIPTION_PREFIX = "Downloaded from ";

/** The breadcrumb's url, when it is one: the download's source. */
function downloadSourceOf(description: string): AudioRights["source"] | undefined {
  const raw = description.slice(DOWNLOAD_DESCRIPTION_PREFIX.length).trim();
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    return { url: raw.slice(0, 2048), ...(u.host ? { site: u.host } : {}) };
  } catch {
    return undefined;
  }
}

function promptOf(aiGeneration: string): string | undefined {
  try {
    const prompt = (JSON.parse(aiGeneration) as { prompt?: unknown } | null)?.prompt;
    return typeof prompt === "string" ? prompt : undefined;
  } catch {
    return undefined;
  }
}

/** An audio-bearing file with `audioRights` null was stored before rights
 *  existed, or by a path that stamps nothing. Its provenance decides:
 *  - libi generated it — any `aiGeneration` record, or an ACE-Step track's
 *    `[Music] <prompt>` description → generated;
 *  - yt-dlp downloaded it — the `Downloaded from <url>` breadcrumb →
 *    copyrighted, that url as its source;
 *  - anything else → owned: an upload is the user's own (owner decision
 *    2026-09-28 — only downloads and remote imports count as copyrighted).
 *  All decided by provenance, at the file's creation time. */
function unstampedRights(f: RightsFileLike): AudioRights {
  const decidedAt = new Date(isoOf(f.createdAt));
  if (f.aiGeneration != null) return generatedStamp(promptOf(f.aiGeneration), decidedAt);
  if (f.description?.startsWith(ACE_STEP_DESCRIPTION_PREFIX)) {
    return generatedStamp(f.description.slice(ACE_STEP_DESCRIPTION_PREFIX.length), decidedAt);
  }
  if (f.description?.startsWith(DOWNLOAD_DESCRIPTION_PREFIX)) {
    const source = downloadSourceOf(f.description);
    return { class: "copyrighted", ...(source ? { source } : {}), decidedBy: "provenance", decidedAt: decidedAt.toISOString() };
  }
  return ownedByProvenance(decidedAt);
}

/** A stamp that is present but does not parse (hand-edited, or written by a
 *  newer libi) is read as copyrighted: something decided this file, and the
 *  reader cannot tell what — the safe reading. */
export function effectiveRights(f: RightsFileLike): AudioRights | null {
  if (!fileCarriesAudio(f)) return null;
  if (f.audioRights == null) return unstampedRights(f);
  return parseAudioRights(f.audioRights) ?? { class: "copyrighted", decidedBy: "provenance", decidedAt: isoOf(f.createdAt) };
}

export function isCopyrighted(f: RightsFileLike): boolean {
  return effectiveRights(f)?.class === "copyrighted";
}

/**
 * The rights of a file made FROM other files (trim, concat, extract-audio):
 * the most restrictive of its inputs' effective rights, decided by
 * provenance (each input read through `effectiveRights`, so an unstamped one
 * counts as whatever its provenance says). Any copyrighted input →
 * copyrighted, carrying that input's track and source when exactly one input
 * is copyrighted; else any generated input → generated; else owned. The
 * winning class's track is carried the same way (exactly one input of it).
 * Inputs without audio do not count; none with audio → null (no stamp).
 */
export function derivedRights(inputs: RightsFileLike[], now?: Date): AudioRights | null {
  const rights = inputs.map(effectiveRights).filter((r): r is AudioRights => r !== null);
  if (rights.length === 0) return null;
  const cls: AudioRights["class"] = rights.some((r) => r.class === "copyrighted")
    ? "copyrighted"
    : rights.some((r) => r.class === "generated")
      ? "generated"
      : "owned";
  const winners = rights.filter((r) => r.class === cls);
  const only = winners.length === 1 ? winners[0] : undefined;
  return {
    class: cls,
    ...(only?.track ? { track: only.track } : {}),
    ...(only?.source ? { source: only.source } : {}),
    decidedBy: "provenance",
    decidedAt: (now ?? new Date()).toISOString(),
  };
}
