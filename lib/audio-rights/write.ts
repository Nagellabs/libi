/** The one writer of `files.audio_rights` (spec §4.3). */
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import type { KnownPlatform } from "@/lib/social/catalog";
import { effectiveRights } from "./read";
import {
  serializeAudioRights,
  type AudioRights,
  type AudioRightsClass,
  type AudioTrack,
  type PlatformPick,
  type PlatformPicks,
} from "./types";

export const OWNED_REFUSAL = "only the user can mark a track as their own — ask them to use the file's details panel";
export const USER_DECIDED_REFUSAL =
  "the user set this file's rights themselves — ask them before changing it; they can change it in the file's details panel";

export type RightsPatch = {
  class?: AudioRightsClass;
  track?: AudioTrack | null;
  /** One platform's pick — written only by `platform-picks.ts#setPlatformPick`. */
  platformPick?: { platform: KnownPlatform; pick: PlatformPick | null };
};
export type UpdateRightsResult =
  | { ok: true; rights: AudioRights; pieceId: string | null; trackChanged: boolean }
  | { ok: false; code: "not_found" | "no_audio" | "owned_user_only" | "user_decided"; message: string };

/** The user's details panel sends the whole track (a cleared field means
 *  cleared). An agent names what it confirmed: merged into the known track,
 *  so album / isrc survive unless given. A stored `trackConfidence` described
 *  where the OLD name came from (a page title), so it goes unless given. */
function nextTrack(current: AudioTrack | undefined, patch: AudioTrack, actor: "agent" | "user"): AudioTrack {
  if (actor === "user" || !current) return patch;
  const { trackConfidence: _stale, ...kept } = current;
  void _stale;
  return { ...kept, ...patch };
}

/** The same song, read the way a person would: title and artist, case and outer space ignored. */
export function sameSong(a?: { title: string; artist?: string }, b?: { title: string; artist?: string }): boolean {
  const key = (t?: { title: string; artist?: string }) => `${(t?.title ?? "").trim().toLowerCase()}\u0000${(t?.artist ?? "").trim().toLowerCase()}`;
  return key(a) === key(b);
}

/** A match was made for the song the file WAS: a rename keeps only the user's own picks. */
function nextPicks(current: PlatformPicks | undefined, trackChanged: boolean, patch: RightsPatch["platformPick"]): PlatformPicks | undefined {
  const picks: PlatformPicks = {};
  for (const [platform, p] of Object.entries(current ?? {}) as Array<[KnownPlatform, PlatformPick | undefined]>) {
    if (p && (!trackChanged || p.decidedBy === "user")) picks[platform] = p;
  }
  if (patch) {
    if (patch.pick) picks[patch.platform] = patch.pick;
    else delete picks[patch.platform];
  }
  return Object.keys(picks).length > 0 ? picks : undefined;
}

export function updateAudioRights(
  fileId: string,
  patch: RightsPatch,
  actor: "agent" | "user",
  opts: { pieceId?: string } = {},
): UpdateRightsResult {
  if (actor === "agent" && patch.class === "owned") return { ok: false, code: "owned_user_only", message: OWNED_REFUSAL };
  const db = getDb();
  const row = db.select().from(files).where(eq(files.id, fileId)).get();
  if (!row || (opts.pieceId !== undefined && row.pieceId !== opts.pieceId)) {
    return { ok: false, code: "not_found", message: `File not found: ${fileId}` };
  }
  const current = effectiveRights(row);
  if (!current) return { ok: false, code: "no_audio", message: "This file has no audio." };
  // The user's class decision is theirs: the agent may name the track, never re-class it.
  const userDecided = actor === "agent" && current.decidedBy === "user";
  if (userDecided && patch.class !== undefined && patch.class !== current.class) {
    return { ok: false, code: "user_decided", message: USER_DECIDED_REFUSAL };
  }
  const cls = patch.class ?? current.class;
  // An agent is never the decider of `owned` (only the user, or provenance for
  // an upload): a track edit on an owned file keeps who decided it.
  const keepDecider = actor === "agent" && (userDecided || cls === "owned");
  const track = patch.track === null ? undefined : patch.track ? nextTrack(current.track, patch.track, actor) : current.track;
  const trackChanged = !sameSong(current.track, track);
  const picks = nextPicks(current.platformPicks, trackChanged, patch.platformPick);
  // A pick is not a rights decision: who decided the class, and when, stays.
  const onlyPick = patch.class === undefined && patch.track === undefined && patch.platformPick !== undefined;
  const next: AudioRights = {
    class: cls,
    ...(track ? { track } : {}),
    ...(current.source ? { source: current.source } : {}),
    ...(picks ? { platformPicks: picks } : {}),
    // A track edit on a user-decided file keeps the class the user's (and so still locked).
    decidedBy: onlyPick || keepDecider ? current.decidedBy : actor,
    decidedAt: onlyPick ? current.decidedAt : new Date().toISOString(),
  };
  db.update(files).set({ audioRights: serializeAudioRights(next) }).where(eq(files.id, fileId)).run();
  return { ok: true, rights: next, pieceId: row.pieceId, trackChanged };
}
