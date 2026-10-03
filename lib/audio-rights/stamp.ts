/** The stamp each ingest path writes (spec §4.2). Pure. */
import type { AudioRights, AudioTrack } from "./types";

const iso = (now?: Date) => (now ?? new Date()).toISOString();
const clean = (s: unknown, max = 200): string | undefined =>
  typeof s === "string" && s.trim() ? s.trim().slice(0, max) : undefined;

export function generatedStamp(title?: string, now?: Date): AudioRights {
  const t = clean(title, 80);
  return { class: "generated", ...(t ? { track: { title: t } } : {}), decidedBy: "provenance", decidedAt: iso(now) };
}

export function ownedByProvenance(now?: Date): AudioRights {
  return { class: "owned", decidedBy: "provenance", decidedAt: iso(now) };
}

/** A file the user uploaded — a UI upload route, or `libi.upload_file` taking
 *  a file from the user's disk — is theirs (owner decision 2026-09-28). Only
 *  downloads (`downloadStamp`) and remote imports (`remoteFetchStamp`) count
 *  as copyrighted by provenance; the user can still flip any file in its
 *  details panel. */
export function uploadedStamp(now?: Date): AudioRights {
  return ownedByProvenance(now);
}

/** The fields of yt-dlp's info json this reads. */
export interface YtDlpInfo {
  webpage_url?: string;
  extractor?: string;
  extractor_key?: string;
  track?: string;
  artist?: string;
  creator?: string;
  album?: string;
  title?: string;
  /** Seconds. */
  duration?: number;
  uploader?: string;
  channel?: string;
}

export function downloadStamp(info: YtDlpInfo | null, fallbackUrl: string, now?: Date): AudioRights {
  const url = clean(info?.webpage_url, 2048) ?? fallbackUrl;
  const site = clean(info?.extractor, 100) ?? clean(info?.extractor_key, 100);
  let track: AudioTrack | undefined;
  const tagged = clean(info?.track);
  if (tagged) {
    const artist = clean(info?.artist);
    const album = clean(info?.album);
    track = { title: tagged, ...(artist ? { artist } : {}), ...(album ? { album } : {}), trackConfidence: "high" };
  } else if (clean(info?.title)) {
    // The uploader is NOT the artist; the agent confirms the identity (skill §1).
    track = { title: clean(info?.title)!, trackConfidence: "low" };
  }
  return {
    class: "copyrighted",
    ...(track ? { track } : {}),
    source: { url, ...(site ? { site } : {}) },
    decidedBy: "provenance",
    decidedAt: iso(now),
  };
}

export function remoteFetchStamp(url: string, now?: Date): AudioRights {
  let site: string | undefined;
  try {
    site = new URL(url).host || undefined;
  } catch {
    site = undefined;
  }
  return { class: "copyrighted", source: { url: url.slice(0, 2048), ...(site ? { site } : {}) }, decidedBy: "provenance", decidedAt: iso(now) };
}
