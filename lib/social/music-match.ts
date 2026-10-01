/**
 * Match a copyrighted song on every connected platform that can attach a
 * licensed copy (addendum §3). Provider-agnostic by construction: it speaks
 * only `SocialAdapter` (listAccounts, the music-facts probe, musicCatalog) and
 * `PLATFORM_MUSIC_RULES` — which platform searches and which lists trending
 * tracks is a rule, never a branch on a provider. With more than one connected
 * provider this loops their adapters; today `withAdapter` hands the one.
 * Server-only.
 */
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { effectiveRights } from "@/lib/audio-rights/read";
import { setPlatformPick } from "@/lib/audio-rights/platform-picks";
import { songLabel, type PickTrack, type PlatformPick } from "@/lib/audio-rights/types";
import { sameSong } from "@/lib/audio-rights/write";
import { navigationEmitter } from "@/lib/navigation-events";
import { serverLogger as logger } from "@/lib/logger";
import type { SocialAdapter } from "./adapter";
import { isComposablePlatform, platformLabel, type KnownPlatform } from "./catalog";
import { isSocialError } from "./errors";
import { resolveAccountFacts } from "./music-facts";
import {
  PLATFORM_MUSIC_RULES,
  catalogQueryFor,
  confidentMatch,
  type AccountMusicFacts,
  type CatalogTrack,
  type MusicMode,
  type MusicUnavailableReason,
} from "./music-policy";
import { getSocialService, withAdapter } from "./service";
import type { SocialAccount } from "./types";

export const MATCH_BUDGET_MS = 8_000;
export const REMATCH_DELAY_MS = 2_000;

export type PlatformMatch =
  | { status: "picked"; accountId: string; track: PickTrack }
  | { status: "not_found"; accountId: string; fallback: MusicMode }
  | { status: "kept_user_pick"; pick: PlatformPick }
  | { status: "cannot_attach"; accountId: string; reason: MusicUnavailableReason }
  | { status: "error"; accountId?: string; reason: "timeout" | "provider_error" | "song_changed" };

export type MatchSkip = "file_not_found" | "not_copyrighted" | "no_song_identity" | "identity_unconfirmed" | "social_not_connected";

type Matched = { platforms: Partial<Record<KnownPlatform, PlatformMatch>>; incomplete?: "timeout" | "provider_error" | "unauthorized" };
export type SongMatchResult = ({ skipped: MatchSkip } | Matched) & { summary: string[] };

/** Every platform whose rules name a catalog. */
export function attachPlatforms(): KnownPlatform[] {
  return (Object.keys(PLATFORM_MUSIC_RULES) as KnownPlatform[]).filter((p) => PLATFORM_MUSIC_RULES[p].catalog !== "none");
}

const toPickTrack = (t: CatalogTrack): PickTrack => ({
  id: t.id,
  title: t.title,
  ...(t.artist ? { artist: t.artist } : {}),
  ...(t.durationSec !== undefined ? { durationSec: t.durationSec } : {}),
});

const REASON_PHRASE: Record<MusicUnavailableReason, string> = {
  needs_facebook_login: "it needs Facebook Login — reconnect the account choosing Facebook",
  not_business: "it isn't connected as a Business account",
  unsupported: "it has no music library libi can reach",
  error: "its music library couldn't be read",
};

const SKIP_LINE: Record<MatchSkip, string> = {
  file_not_found: "File not found.",
  not_copyrighted: "This audio isn't copyrighted — nothing to match.",
  no_song_identity: "The song's title and artist aren't both known, so it wasn't matched — confirm them with the user, then call libi.set_audio_rights.",
  identity_unconfirmed: "The song's identity is only a guess from a page title, so it wasn't matched — confirm it with the user, then call libi.set_audio_rights.",
  social_not_connected: "Social posting isn't connected in libi, so the song wasn't matched on any platform.",
};

/** What the agent relays, one line per platform. */
export function describeMatch(r: { skipped: MatchSkip } | Matched): string[] {
  if ("skipped" in r) return [SKIP_LINE[r.skipped]];
  const lines: string[] = [];
  // Rules order, not completion order: the same result always reads the same.
  for (const platform of Object.keys(PLATFORM_MUSIC_RULES) as KnownPlatform[]) {
    const m = r.platforms[platform];
    if (!m) continue;
    const P = platformLabel(platform);
    const rules = PLATFORM_MUSIC_RULES[platform];
    if (m.status === "picked") lines.push(`Matched on ${P}: *${songLabel(m.track)}*.`);
    else if (m.status === "not_found") {
      const noun = rules.catalog === "trending" ? "trending list" : "results";
      const outcome = m.fallback === "draft" ? `the ${P} post goes as a draft to finish in the app` : "it'll be left out there";
      lines.push(`Not in ${P}'s ${noun} — ${outcome} unless the user picks a track.`);
    } else if (m.status === "kept_user_pick") {
      lines.push(
        m.pick.status === "picked" && m.pick.track
          ? `${P}: keeping the track the user picked (*${songLabel(m.pick.track)}*).`
          : m.pick.status === "draft"
            ? `${P}: the user chose to finish in the ${P} app.`
            : `${P}: keeping the user's choice.`,
      );
    } else if (m.status === "cannot_attach") lines.push(`${P} can't attach licensed music on this account: ${REASON_PHRASE[m.reason]}.`);
    else {
      lines.push(
        m.reason === "timeout"
          ? `${P}'s music library didn't answer in time — the user can pick a track when posting.`
          : m.reason === "song_changed"
            ? `The song changed while ${P} was still looking — matching it again will pick up the new one.`
            : `${P}'s music library couldn't be read — the user can pick a track when posting.`,
      );
    }
  }
  // The call as a whole stopping short is said even when some platforms
  // answered: the agent must not read a partial result as the whole story.
  const some = lines.length > 0;
  if (r.incomplete === "unauthorized") {
    lines.push("Libi's connection to social posting was revoked — ask the user to reconnect it, then match the song again.");
  } else if (r.incomplete) {
    lines.push(
      `The social provider didn't answer${r.incomplete === "timeout" ? " in time" : ""}; ${some ? "the rest wasn't matched — match the song again later." : "nothing was matched."}`,
    );
  } else if (!some) {
    lines.push("No connected account is on a platform that attaches licensed music.");
  }
  return lines;
}

const skipped = (reason: MatchSkip): SongMatchResult => ({ skipped: reason, summary: describeMatch({ skipped: reason }) });

export async function matchSongOnPlatforms(fileId: string, opts: { budgetMs?: number; now?: () => Date } = {}): Promise<SongMatchResult> {
  const row = getDb().select().from(files).where(eq(files.id, fileId)).get();
  if (!row) return skipped("file_not_found");
  const rights = effectiveRights(row);
  if (!rights || rights.class !== "copyrighted") return skipped("not_copyrighted");
  const song = rights.track;
  if (!song?.title || !song.artist) return skipped("no_song_identity");
  if (song.trackConfidence === "low") return skipped("identity_unconfirmed");
  if (!(await getSocialService().status()).connected) return skipped("social_not_connected");

  const now = opts.now ?? (() => new Date());
  const platforms: Matched["platforms"] = {};
  const started = new Map<KnownPlatform, string>();
  let expired = false;

  const matchOn = async (a: SocialAdapter, platform: KnownPlatform, accounts: SocialAccount[]): Promise<void> => {
    const onPlatform = accounts.filter((x) => x.platform === platform);
    if (onPlatform.length === 0 || !isComposablePlatform(platform)) return;
    const existing = rights.platformPicks?.[platform];
    if (existing?.decidedBy === "user") {
      platforms[platform] = { status: "kept_user_pick", pick: existing };
      return;
    }
    const rules = PLATFORM_MUSIC_RULES[platform];
    let blocked: { accountId: string; reason: MusicUnavailableReason } | null = null;
    let chosen: { account: SocialAccount; facts: AccountMusicFacts } | null = null;
    // One account per platform: the first that can attach.
    for (const account of onPlatform) {
      // Recorded BEFORE the probe: a probe stuck past the deadline still
      // times this platform out, rather than vanishing from the result.
      started.set(platform, account.id);
      const facts = await resolveAccountFacts(a, a.providerId, account);
      if (expired) return; // the probe answered after the deadline; no catalog call now
      if (rules.canAttach(facts)) {
        chosen = { account, facts };
        break;
      }
      blocked ??= { accountId: account.id, reason: rules.attachBlocker(facts) ?? "unsupported" };
    }
    if (!chosen) {
      if (blocked) platforms[platform] = { status: "cannot_attach", ...blocked };
      return;
    }
    const accountId = chosen.account.id;
    started.set(platform, accountId);
    const query = catalogQueryFor(platform, song);
    const r = await a.musicCatalog(accountId, { platform, ...(query ? { query } : {}) });
    if (expired) return;
    if ("unavailable" in r) {
      platforms[platform] =
        r.unavailable.reason === "error" ? { status: "error", accountId, reason: "provider_error" } : { status: "cannot_attach", accountId, reason: r.unavailable.reason };
      return;
    }
    const hit = confidentMatch(song, r.tracks);
    // The song may have been renamed while this call was in flight: re-read
    // its identity right before writing, so a late answer never attaches the
    // OLD song's track to whatever the file is now.
    const freshRow = getDb().select().from(files).where(eq(files.id, fileId)).get();
    const freshRights = freshRow ? effectiveRights(freshRow) : null;
    if (!freshRights || freshRights.class !== "copyrighted" || !sameSong(freshRights.track, song)) {
      platforms[platform] = { status: "error", accountId, reason: "song_changed" };
      return;
    }
    const meta = { decidedBy: "auto" as const, decidedAt: now().toISOString(), providerId: a.providerId, accountId };
    const pick: PlatformPick = hit ? { status: "picked", track: toPickTrack(hit), ...meta } : { status: "not_found", ...meta };
    const w = setPlatformPick(fileId, platform, pick, "auto");
    if (!w.ok) {
      // The write itself failed (the file was deleted, or lost its audio,
      // mid-match): never report picked/not_found for a pick that was never
      // saved.
      platforms[platform] = { status: "error", accountId, reason: "provider_error" };
      logger.warn({ tag: "social-music", op: "match_failed", fileId, platform, err: w.message }, "song match failed to write a platform pick");
      return;
    }
    if (!w.written) {
      const kept = w.rights.platformPicks?.[platform];
      if (kept) platforms[platform] = { status: "kept_user_pick", pick: kept };
      return;
    }
    platforms[platform] = hit ? { status: "picked", accountId, track: toPickTrack(hit) } : { status: "not_found", accountId, fallback: rules.fallback(chosen.facts) };
  };

  const work = withAdapter(async (a) => {
    const accounts = (await a.listAccounts()).filter((x) => x.active);
    await Promise.all(
      attachPlatforms().map(async (platform) => {
        try {
          await matchOn(a, platform, accounts);
        } catch (err) {
          if (isSocialError(err) && err.kind === "unauthorized") {
            expired = true; // stop every other still-running platform from writing once this settles
            throw err; // withAdapter marks the grant
          }
          if (!expired) {
            const accountId = started.get(platform);
            platforms[platform] = { status: "error", ...(accountId ? { accountId } : {}), reason: "provider_error" };
          }
          logger.warn({ tag: "social-music", op: "match_failed", fileId, platform, err: err instanceof Error ? err.message : String(err) }, "song match failed on a platform");
        }
      }),
    );
  });
  // After the deadline nothing more is written; the late settle is swallowed.
  work.catch(() => {});

  let incomplete: Matched["incomplete"];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((res) => {
    timer = setTimeout(() => res("timeout"), opts.budgetMs ?? MATCH_BUDGET_MS);
  });
  try {
    if ((await Promise.race([work.then(() => "done" as const), deadline])) === "timeout") {
      expired = true;
      incomplete = "timeout";
      for (const [platform, accountId] of started) if (!platforms[platform]) platforms[platform] = { status: "error", accountId, reason: "timeout" };
    }
  } catch (err) {
    incomplete = isSocialError(err) && err.kind === "unauthorized" ? "unauthorized" : "provider_error";
    logger.warn({ tag: "social-music", op: "match_failed", fileId, err: err instanceof Error ? err.message : String(err) }, "song match failed");
  } finally {
    clearTimeout(timer);
  }
  const result: Matched = { platforms, ...(incomplete ? { incomplete } : {}) };
  logger.info(
    { tag: "social-music", op: "song_matched", fileId, statuses: Object.fromEntries(Object.entries(platforms).map(([p, m]) => [p, m!.status])), incomplete: incomplete ?? null },
    "song matched on the connected platforms",
  );
  return { ...result, summary: describeMatch(result) };
}

const g = globalThis as unknown as { __libiSongRematch?: Map<string, ReturnType<typeof setTimeout>> };

/** A renamed song is matched again — once, `delayMs` after the LAST rename
 *  (the details panel autosaves while the user types). Server-only. */
export function scheduleSongRematch(fileId: string, pieceId: string | null, delayMs = REMATCH_DELAY_MS): void {
  const timers = (g.__libiSongRematch ??= new Map());
  const prev = timers.get(fileId);
  if (prev) clearTimeout(prev);
  timers.set(
    fileId,
    setTimeout(() => {
      timers.delete(fileId);
      void matchSongOnPlatforms(fileId)
        .then(() => {
          navigationEmitter.emit("refresh_query", { queryKey: "files", ...(pieceId ? { pieceId } : {}), fileId });
          navigationEmitter.emit("refresh_query", { queryKey: "social", ...(pieceId ? { pieceId } : {}) });
        })
        .catch((err) => logger.warn({ tag: "social-music", op: "rematch_failed", fileId, err: err instanceof Error ? err.message : String(err) }, "re-match after a rename failed"));
    }, delayMs),
  );
}
