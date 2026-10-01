/**
 * What a file's audio IS, for rights purposes (spec §4). Rights live on the
 * FILE (D7), never the clip. `null` on an audio-bearing file means "no
 * stamp" and is read by provenance — generated, a legacy download
 * (copyrighted), or else the user's own (owned; owner decision 2026-09-28) —
 * see `read.ts#effectiveRights`, the one reader every consumer goes through.
 *
 * Client-safe: zod only.
 */
import { z } from "zod/v3";
import type { KnownPlatform } from "@/lib/social/catalog";

export type AudioRightsClass = "copyrighted" | "generated" | "owned";

export interface AudioTrack {
  title: string;
  artist?: string;
  album?: string;
  isrc?: string;
  /** "low" when the title came from a page title (yt-dlp `title`), not a track tag. */
  trackConfidence?: "high" | "low";
}

export type PickStatus = "picked" | "not_found" | "draft";

/** A catalog track as a pick remembers it. No preview or artwork URL: those
 *  expire; the UI re-reads them through `/api/social/music/*` by id. */
export interface PickTrack {
  id: string;
  title: string;
  artist?: string;
  durationSec?: number;
}

/** One song's choice on one platform (addendum §1). One pick per song per
 *  platform: the Posting tab, the details panel and the agent's match all
 *  write the same field, through `platform-picks.ts#setPlatformPick`. */
export interface PlatformPick {
  /** `draft` = the user chose to finish in the platform's own app. */
  status: PickStatus;
  track?: PickTrack;
  decidedBy: "auto" | "agent" | "user";
  /** ISO */
  decidedAt: string;
  /** The social provider whose catalog was read. */
  providerId?: string;
  /** The account whose catalog was read. */
  accountId?: string;
}

/** Keyed by platform — never a hardcoded pair: which platforms can hold a pick
 *  is `PLATFORM_MUSIC_RULES`' call (a catalog), decided at write time. */
export type PlatformPicks = Partial<Record<KnownPlatform, PlatformPick>>;

export interface AudioRights {
  class: AudioRightsClass;
  track?: AudioTrack;
  /** Where it was downloaded from. */
  source?: { url: string; site?: string };
  decidedBy: "provenance" | "agent" | "user";
  /** ISO */
  decidedAt: string;
  platformPicks?: PlatformPicks;
}

export const audioTrackSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    artist: z.string().trim().max(200).optional(),
    album: z.string().trim().max(200).optional(),
    isrc: z.string().trim().max(20).optional(),
    trackConfidence: z.enum(["high", "low"]).optional(),
  })
  .strict();

/** A platform key: today's five, and whatever a later rules table adds. */
export const PLATFORM_KEY = /^[a-z][a-z0-9_-]{0,31}$/;

export const pickTrackSchema = z
  .object({
    id: z.string().min(1).max(64),
    title: z.string().trim().min(1).max(200),
    artist: z.string().trim().max(200).optional(),
    durationSec: z.number().nonnegative().max(86_400).optional(),
  })
  .strict();

export const platformPickSchema = z
  .object({
    status: z.enum(["picked", "not_found", "draft"]),
    track: pickTrackSchema.optional(),
    decidedBy: z.enum(["auto", "agent", "user"]),
    decidedAt: z.string().min(1),
    providerId: z.string().max(64).optional(),
    accountId: z.string().max(128).optional(),
  })
  .strict()
  .refine((p) => (p.status === "picked") === (p.track !== undefined), {
    message: "a picked status needs a track; not_found and draft carry none",
    path: ["track"],
  });

export const audioRightsSchema = z
  .object({
    class: z.enum(["copyrighted", "generated", "owned"]),
    track: audioTrackSchema.optional(),
    source: z.object({ url: z.string().max(2048), site: z.string().max(100).optional() }).strict().optional(),
    decidedBy: z.enum(["provenance", "agent", "user"]),
    decidedAt: z.string().min(1),
    platformPicks: z.record(z.string().regex(PLATFORM_KEY), platformPickSchema).optional(),
  })
  .strict();

/** For `files.audio_rights`. Null in, null out. Throws on an invalid value — a writer's bug. */
export function serializeAudioRights(r: AudioRights | null | undefined): string | null {
  if (!r) return null;
  return JSON.stringify(audioRightsSchema.parse(r));
}

/** Tolerant: malformed or unknown-shaped JSON parses as null; `effectiveRights`
 *  reads such a present-but-unreadable stamp as copyrighted. A bad PICK only
 *  costs the picks: they cache a decision, the class IS the decision. */
export function parseAudioRights(raw: string | null | undefined): AudioRights | null {
  if (!raw) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const r = audioRightsSchema.safeParse(json);
  if (r.success) return r.data as AudioRights;
  if (json && typeof json === "object" && "platformPicks" in json) {
    const { platformPicks: _dropped, ...rest } = json as Record<string, unknown>;
    void _dropped;
    const again = audioRightsSchema.safeParse(rest);
    if (again.success) return again.data as AudioRights;
  }
  return null;
}

/** "Title — Artist" for the plan sentences and notices. */
export function songLabel(track: { title: string; artist?: string } | undefined): string {
  if (!track?.title) return "an unnamed song";
  return track.artist ? `${track.title} — ${track.artist}` : track.title;
}
