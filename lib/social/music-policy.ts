/**
 * Music at posting (spec §6.1): the rules for all five known platforms (D9),
 * the confident-match rule, and `resolveMusicPlan` — the one function the
 * composer, the Posting tab and `libi.post_piece` all build a post's music
 * through. Pure and client-safe.
 */
import { PLATFORM_CATALOG, platformLabel, type KnownPlatform } from "./catalog";
import type { PieceAudio, PieceSong } from "@/lib/audio-rights/piece-audio";
import { songLabel } from "@/lib/audio-rights/types";
import type { PickTrack, PlatformPick, PlatformPicks } from "@/lib/audio-rights/types";

export type MusicMode = "attach" | "draft" | "include" | "strip";
export type ExportVariant = "with-song" | "without-song";

export interface AccountMusicFacts {
  tiktokKind?: { value: "business" | "personal"; source: "detected" | "user"; checkedAt: string };
  instagramFacebookLogin?: { value: boolean; source: "detected"; checkedAt: string };
}

export interface CatalogTrack {
  id: string;
  title: string;
  artist?: string;
  durationSec?: number;
  previewUrl?: string;
  artworkUrl?: string;
  kind: "search" | "trending";
  rank?: number;
}

export type MusicUnavailableReason = "not_business" | "needs_facebook_login" | "unsupported" | "error";
export type MusicCatalogResult = { tracks: CatalogTrack[] } | { unavailable: { reason: MusicUnavailableReason; detail?: string } };

export interface TargetMusicTrack {
  id: string;
  title: string;
  artist?: string;
}

export type TargetMusic = (
  | { mode: "attach"; track: TargetMusicTrack; musicVolume: number; originalVolume: number; startMs?: number; endMs?: number }
  | { mode: "draft" }
  | { mode: "include" }
  | { mode: "strip" }
) & { soundName?: string };

export interface PlatformMusicRules {
  platform: KnownPlatform;
  catalog: "search" | "trending" | "none";
  /** Whether THIS account can attach from the catalog (TikTok Business lane, Instagram via Facebook Login). */
  canAttach(facts: AccountMusicFacts): boolean;
  /** Why THIS account can't attach (null = it can). Read by the matcher, the picker and the details rows. */
  attachBlocker(facts: AccountMusicFacts): MusicUnavailableReason | null;
  /** How a `not_found` pick reads in the details panel ("not in the top 100"). */
  notFoundLabel?: string;
  /** A `trending` catalog changes daily: how a stored pick that left the list reads ("is no longer in …"). */
  pickGoneNote?: string;
  /** Where attach looks, for a song not yet matched: "attaches it <this>" ("if it's in the top 100"). */
  attachIfFound?: string;
  /** Shown above the picker's list, always. */
  pickerNote?: string;
  /** Appended to "keep it in" where keeping has a known consequence. */
  includeNote?: string;
  /** A draft the user finishes in the platform's own editor. */
  draftHandoff: boolean;
  /** Instagram `audioName`. */
  nameOriginalSound: boolean;
  copyrightedDefault(facts: AccountMusicFacts): MusicMode;
  /** When attach finds nothing and the user picks nothing. */
  fallback(facts: AccountMusicFacts): MusicMode;
  /** What the account lacks for THIS plan's mode (a mode that needs no catalog may need nothing). */
  requirement?(facts: AccountMusicFacts, mode: MusicMode): string | null;
  /** Shown when the user picks include against the default. */
  includeWarning: string;
  finishLink?: "tiktok-inbox" | "youtube-studio-editor" | "instagram-app";
}

export const YOUTUBE_CLAIM_SENTENCE =
  "Keeps the song in the video. YouTube will likely claim it: the owner may run ads on it or block it in some countries. It is not a strike.";

const isBusiness = (f: AccountMusicFacts) => f.tiktokKind?.value === "business";
const hasFbLogin = (f: AccountMusicFacts) => f.instagramFacebookLogin?.value === true;

export const PLATFORM_MUSIC_RULES: Record<KnownPlatform, PlatformMusicRules> = {
  tiktok: {
    platform: "tiktok",
    catalog: "trending",
    canAttach: isBusiness,
    attachBlocker: (f) => (isBusiness(f) ? null : f.tiktokKind ? "not_business" : "error"),
    notFoundLabel: "not in the top 100",
    pickGoneNote: "no longer in TikTok's top 100",
    attachIfFound: "if it's in the top 100",
    pickerNote:
      "These are TikTok's current top 100 trending tracks — the only ones TikTok lets apps attach. There's no search. If your song isn't here, send the post as a TikTok draft and pick the sound in the TikTok app.",
    draftHandoff: true,
    nameOriginalSound: false,
    copyrightedDefault: (f) => (isBusiness(f) ? "attach" : "draft"),
    fallback: (f) => (isBusiness(f) ? "draft" : "include"),
    requirement: (f) => (f.tiktokKind ? null : "Set this TikTok account's type (Business or Personal) in Social → Settings."),
    includeWarning: "TikTok will likely mute the song or post the video without sound.",
    finishLink: "tiktok-inbox",
  },
  instagram: {
    platform: "instagram",
    catalog: "search",
    canAttach: hasFbLogin,
    attachBlocker: (f) => (hasFbLogin(f) ? null : f.instagramFacebookLogin ? "needs_facebook_login" : "error"),
    notFoundLabel: "not found in Instagram's music",
    attachIfFound: "if Instagram's music has it",
    draftHandoff: false,
    nameOriginalSound: true,
    copyrightedDefault: (f) => (hasFbLogin(f) ? "attach" : "strip"),
    fallback: () => "strip",
    // Facebook Login is what the audio CATALOG needs; keeping the song in the
    // video (`include`) uses no catalog, so it needs no reconnect.
    requirement: (f, mode) =>
      mode !== "include" && f.instagramFacebookLogin?.value === false ? "Reconnect Instagram with Facebook Login to attach licensed music." : null,
    includeWarning: "Instagram may mute the song or block the Reel in some countries.",
    finishLink: "instagram-app",
  },
  youtube: {
    platform: "youtube",
    catalog: "none",
    canAttach: () => false,
    attachBlocker: () => "unsupported",
    includeNote: "likely claimed",
    draftHandoff: false,
    nameOriginalSound: false,
    copyrightedDefault: () => "include",
    fallback: () => "strip",
    includeWarning: "YouTube will likely claim it: the owner may run ads on it or block it in some countries.",
    finishLink: "youtube-studio-editor",
  },
  facebook: {
    platform: "facebook",
    catalog: "none",
    canAttach: () => false,
    attachBlocker: () => "unsupported",
    draftHandoff: false,
    nameOriginalSound: false,
    copyrightedDefault: () => "strip",
    fallback: () => "include",
    includeWarning: "Facebook Pages can't use commercial music: Facebook may mute the video or block it.",
  },
  twitter: {
    platform: "twitter",
    catalog: "none",
    canAttach: () => false,
    attachBlocker: () => "unsupported",
    draftHandoff: false,
    nameOriginalSound: false,
    copyrightedDefault: () => "strip",
    fallback: () => "include",
    includeWarning: "X disables a video on a copyright report, and reports count toward suspending the account.",
  },
};

const BLOCKER_SHORT: Record<MusicUnavailableReason, string> = {
  needs_facebook_login: "needs Facebook Login",
  not_business: "needs a Business account",
  unsupported: "no music library",
  error: "couldn't check this account",
};

export interface SongSocialRow {
  platform: KnownPlatform;
  text: string;
  action: "choose" | "change" | null;
  track?: PickTrack;
}

/** One row of the details panel's "On social" block (addendum §6). */
export function songSocialRow(platform: KnownPlatform, facts: AccountMusicFacts, pick?: PlatformPick): SongSocialRow {
  const P = platformLabel(platform);
  const rules = PLATFORM_MUSIC_RULES[platform];
  if (!canAttachOn(platform, facts)) return { platform, text: `${P} · ${BLOCKER_SHORT[rules.attachBlocker(facts) ?? "unsupported"]}`, action: null };
  if (pick?.status === "picked" && pick.track) return { platform, text: `${P} · ${songLabel(pick.track)}`, action: "change", track: pick.track };
  if (pick?.status === "draft") return { platform, text: `${P} · you'll pick the sound in the ${P} app`, action: "change" };
  if (pick?.status === "not_found") {
    return { platform, text: `${P} · ${rules.notFoundLabel ?? "not found"} — ${rules.fallback(facts) === "draft" ? "will go as a draft" : "will be left out"}`, action: "choose" };
  }
  return { platform, text: `${P} · not matched yet`, action: "choose" };
}

/**
 * One account per connected platform, in the platform catalog's display
 * order (`PLATFORM_CATALOG` — instagram before tiktok, matching every other
 * platform-ordered list in the UI): the first account on that platform that
 * can attach from the catalog, else the first.
 */
export function accountPerPlatform(
  accounts: Array<{ id: string; platform: KnownPlatform; active: boolean }>,
  facts: Record<string, AccountMusicFacts>,
): Array<{ platform: KnownPlatform; accountId: string; facts: AccountMusicFacts }> {
  const out: Array<{ platform: KnownPlatform; accountId: string; facts: AccountMusicFacts }> = [];
  for (const { id: platform } of PLATFORM_CATALOG) {
    const on = accounts.filter((a) => a.active && a.platform === platform);
    if (on.length === 0) continue;
    const chosen = on.find((a) => canAttachOn(platform, facts[a.id] ?? {})) ?? on[0];
    out.push({ platform, accountId: chosen.id, facts: facts[chosen.id] ?? {} });
  }
  return out;
}

// ── matching ────────────────────────────────────────────────────────────────

const FEAT_TAIL = /\s(feat\.?|ft\.?|featuring)\s.*$/;
const FEAT_PAREN = /[([](feat\.?|ft\.?|featuring)[^)\]]*[)\]]/g;
const OFFICIAL = /[([](official|lyric|lyrics|audio|visuali[sz]er|music video|video|explicit|clean)[^)\]]*[)\]]/g;
/** Diacritics fold to their base letter (NFD, then strip the combining marks). */
const foldDiacritics = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
const ampersand = (s: string) => s.replace(/&/g, " and ");
const squash = (s: string) => s.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

export function normalizeSongTitle(s: string): string {
  const base = ampersand(foldDiacritics(s).toLowerCase());
  return squash(base.replace(OFFICIAL, " ").replace(FEAT_PAREN, " ").replace(FEAT_TAIL, " "));
}

export function normalizeArtist(s: string): string {
  const base = ampersand(foldDiacritics(s).toLowerCase());
  return squash(base.replace(FEAT_PAREN, " ").replace(FEAT_TAIL, " "));
}

/** Whole-word token-run containment: "eve" must not match inside "steve lacy". */
function tokenRunContains(haystack: string, needle: string): boolean {
  return ` ${haystack} `.includes(` ${needle} `);
}

export function confidentMatch(song: { title: string; artist?: string } | undefined, catalog: CatalogTrack[]): CatalogTrack | null {
  if (!song?.title || !song.artist) return null;
  const t = normalizeSongTitle(song.title);
  const a = normalizeArtist(song.artist);
  if (!t || !a) return null;
  for (const c of catalog) {
    if (normalizeSongTitle(c.title) !== t || !c.artist) continue;
    const ca = normalizeArtist(c.artist);
    if (ca && (ca === a || tokenRunContains(ca, a) || tokenRunContains(a, ca))) return c;
  }
  return null;
}

// ── the plan ────────────────────────────────────────────────────────────────

export interface MusicTarget {
  platform: KnownPlatform;
  /** The catalog to match against; `null` = it could not be read; absent = not asked. */
  catalog?: CatalogTrack[] | null;
}

export interface MusicOverride {
  mode?: MusicMode;
  track?: CatalogTrack;
  soundName?: string;
}

export interface MusicPlan {
  mode: MusicMode;
  track?: TargetMusicTrack;
  volumes?: { music: number; original: number };
  startMs?: number;
  endMs?: number;
  soundName?: string;
  exportVariant: ExportVariant;
  sentence: string;
  warnings: string[];
  needs?: string;
  /** No confident match: the picker opens (UI) / the agent offers a choice. */
  needsChoice?: boolean;
  /**
   * Attaching is what this target is set to, but no track is decided — no
   * confident match, a `not_found` song, or a pick that left a trending list —
   * and the catalog can be picked from. `mode` stays the fallback an agent's
   * post uses; the Music step instead shows attach with nothing picked and
   * holds Next until the user picks a track or chooses another option.
   */
  awaitingPick?: boolean;
  /** What the "Change" menu may offer. */
  allowedModes: MusicMode[];
  trackSource?: "user" | "auto" | "agent" | "override" | "matched";
}

const label = (s: PieceSong) => (s.rights.track ? songLabel(s.rights.track) : s.name);
const trackLabel = (t: { title: string; artist?: string }) => songLabel(t);
const SOUND_NAME_MAX = 60;

function ownSoundName(audio: PieceAudio, override?: string): string | undefined {
  const v = (override ?? audio.ownMusic.find((s) => s.rights.track?.title)?.rights.track?.title)?.trim();
  return v ? v.slice(0, SOUND_NAME_MAX) : undefined;
}

/** Whether this account can attach from the platform's catalog — the rules decide, never the provider. */
export function canAttachOn(platform: KnownPlatform, facts: AccountMusicFacts): boolean {
  const rules = PLATFORM_MUSIC_RULES[platform];
  return rules.catalog !== "none" && rules.canAttach(facts);
}

/** A search catalog is searched for "title artist"; a trending list takes no query. */
export function catalogQueryFor(platform: KnownPlatform, song?: { title: string; artist?: string }): string | undefined {
  if (PLATFORM_MUSIC_RULES[platform].catalog !== "search" || !song?.title) return undefined;
  return `${song.title} ${song.artist ?? ""}`.trim();
}

/** The copyrighted default once the song's own pick is read (addendum §2). */
export function copyrightedDefaultFor(platform: KnownPlatform, facts: AccountMusicFacts, pick?: PlatformPick): MusicMode {
  const rules = PLATFORM_MUSIC_RULES[platform];
  if (pick?.status === "draft" && rules.draftHandoff) return "draft";
  // "not_found" = the automatic match already looked: don't re-guess.
  if (pick?.status === "not_found" && canAttachOn(platform, facts)) return rules.fallback(facts);
  return rules.copyrightedDefault(facts);
}

export function pickToCatalogTrack(t: PickTrack, platform: KnownPlatform): CatalogTrack {
  return {
    id: t.id,
    title: t.title,
    ...(t.artist ? { artist: t.artist } : {}),
    ...(t.durationSec !== undefined ? { durationSec: t.durationSec } : {}),
    kind: PLATFORM_MUSIC_RULES[platform].catalog === "search" ? "search" : "trending",
  };
}

export function resolveMusicPlan(target: MusicTarget, facts: AccountMusicFacts, pieceAudio: PieceAudio, override?: MusicOverride): MusicPlan {
  const rules = PLATFORM_MUSIC_RULES[target.platform];
  const P = platformLabel(target.platform);
  const songs = pieceAudio.copyrighted;
  const soundName = rules.nameOriginalSound && pieceAudio.ownMusic.length > 0 ? ownSoundName(pieceAudio, override?.soundName) : undefined;

  if (songs.length === 0) {
    const sentence =
      pieceAudio.ownMusic.length === 0
        ? "This piece has no music to handle."
        : soundName
          ? `Keeps your music in the video; ${P} names its sound *${soundName}*.`
          : "Keeps your music in the video; it becomes this post's original sound.";
    return { mode: "include", ...(soundName ? { soundName } : {}), exportVariant: "with-song", sentence, warnings: [], allowedModes: ["include"] };
  }

  const main = songs[0];
  const mainLabel = label(main);
  const pick = main.rights.platformPicks?.[target.platform];
  const canAttach = canAttachOn(target.platform, facts);
  const allowedModes: MusicMode[] = [...(canAttach ? (["attach"] as const) : []), ...(rules.draftHandoff ? (["draft"] as const) : []), "include", "strip"];
  const warnings: string[] = [];
  const defaultMode = copyrightedDefaultFor(target.platform, facts, pick);
  let mode: MusicMode = override?.mode && allowedModes.includes(override.mode) ? override.mode : defaultMode;
  let needsChoice = false;
  let awaitingPick = false;
  let picked: CatalogTrack | undefined;
  let trackSource: MusicPlan["trackSource"];

  if (mode === "attach") {
    const lowConfidence = main.rights.track?.trackConfidence === "low";
    // Post override → the song's own pick → a confident match (addendum §2).
    const stored = pick?.status === "picked" && pick.track ? pickToCatalogTrack(pick.track, target.platform) : undefined;
    // A trending list is only what the platform offers TODAY: a stored pick
    // that left it can't be attached. Like a `not_found` pick, it is not
    // re-guessed — the fallback, saying why. (An unread list can't tell: trust it.)
    const storedGone =
      !override?.track && !!stored && rules.catalog === "trending" && !!target.catalog && !target.catalog.some((c) => c.id === stored.id);
    if (override?.track) {
      picked = override.track;
      trackSource = "override";
    } else if (stored && !storedGone) {
      picked = stored;
      trackSource = pick!.decidedBy;
    } else if (!storedGone && !lowConfidence && target.catalog) {
      picked = confidentMatch(main.rights.track, target.catalog) ?? undefined;
      if (picked) trackSource = "matched";
    }
    if (!picked && storedGone) {
      warnings.push(`*${trackLabel(stored!)}* is ${rules.pickGoneNote ?? `no longer in ${P}'s library`} — pick another track to attach it instead.`);
      mode = rules.fallback(facts);
      awaitingPick = true;
    } else if (!picked) {
      needsChoice = true;
      // An unread list can't be picked from: there the fallback stands.
      awaitingPick = Array.isArray(target.catalog);
      warnings.push(
        lowConfidence
          ? `*${mainLabel}*'s identity needs confirming before it can be matched automatically — pick a track to attach it instead.`
          : target.catalog === null
            ? `${P}'s music library couldn't be read, so this uses the fallback.`
            : target.catalog === undefined
              ? `${P}'s music library wasn't checked, so this uses the fallback.`
              : `No exact match for *${mainLabel}* in ${P}'s ${rules.catalog === "trending" ? "trending list" : "library"} — pick a track to attach it instead.`,
      );
      mode = rules.fallback(facts);
    }
  }

  // A "not_found" pick decided the fallback already: say so. A decided plan
  // for an agent's post; the Music step still waits for a pick or another option.
  if (!override?.mode && pick?.status === "not_found" && canAttach && mode === defaultMode && mode !== "attach") {
    awaitingPick = true;
    warnings.push(`No exact match for *${mainLabel}* in ${P}'s ${rules.catalog === "trending" ? "trending list" : "library"} — pick a track to attach it instead.`);
  }

  const needs = rules.requirement?.(facts, mode) ?? undefined;
  // `audioName` names the post's ORIGINAL sound — the user's own music. When
  // the video keeps a copyrighted song, that song is what plays: never name
  // it as the user's.
  const namedSound = mode === "include" ? undefined : soundName;
  const base: Omit<MusicPlan, "sentence"> = {
    mode,
    exportVariant: mode === "include" ? "with-song" : "without-song",
    warnings,
    allowedModes,
    ...(needs ? { needs } : {}),
    ...(needsChoice ? { needsChoice } : {}),
    ...(awaitingPick ? { awaitingPick } : {}),
    ...(namedSound ? { soundName: namedSound } : {}),
    ...(trackSource ? { trackSource } : {}),
  };

  if (mode === "attach" && picked) {
    const same = confidentMatch(main.rights.track, [picked]) !== null;
    let sentence = same
      ? `Posts without *${mainLabel}* and attaches ${P}'s licensed version.`
      : `Posts without *${mainLabel}* and attaches *${trackLabel(picked)}* from ${P}'s library.`;
    const others = songs.slice(1).map((s) => `*${label(s)}*`);
    if (others.length > 0) sentence += ` Only one song can be attached; ${others.join(", ")} ${others.length === 1 ? "is" : "are"} left out.`;
    if (main.firstStart > 0.5) sentence += ` ${P}'s copy starts at the beginning of the video.`;
    if (trackSource === "user" || trackSource === "override") sentence += " It's the track you picked.";
    else if (trackSource === "auto" || trackSource === "agent") sentence += " Matched automatically.";
    const plan: MusicPlan = {
      ...base,
      sentence,
      track: { id: picked.id, title: picked.title, ...(picked.artist ? { artist: picked.artist } : {}) },
      volumes: { music: Math.min(100, Math.round(main.volume * 100)), original: 100 },
    };
    if (target.platform === "tiktok") {
      // The platform's copy only makes sense trimmed to the piece's own song;
      // a picked substitute (not a confident match to that song) starts at 0.
      let startMs = same ? Math.round(main.firstTrimStart * 1000) : 0;
      const trackMs = picked.durationSec !== undefined ? Math.round(picked.durationSec * 1000) : undefined;
      if (trackMs !== undefined && startMs >= trackMs) startMs = 0;
      let endMs = startMs + Math.round(pieceAudio.durationSec * 1000);
      if (trackMs !== undefined) endMs = Math.min(endMs, trackMs);
      if (endMs <= startMs) endMs = startMs + 1;
      plan.startMs = startMs;
      plan.endMs = endMs;
    }
    return plan;
  }
  if (mode === "draft") {
    const title = main.rights.track?.title ?? main.name;
    let sentence = `Sends a ${P} draft without the song. Open it in ${P} and add *${title}* from the sound library.`;
    const others = songs.slice(1).map((s) => `*${label(s)}*`);
    if (others.length > 0) sentence += ` ${others.join(", ")} ${others.length === 1 ? "is" : "are"} left out too.`;
    return { ...base, sentence };
  }
  if (mode === "include") {
    if (defaultMode !== "include") warnings.push(rules.includeWarning);
    return { ...base, sentence: target.platform === "youtube" ? YOUTUBE_CLAIM_SENTENCE : `Keeps *${mainLabel}* in the video.` };
  }
  return {
    ...base,
    sentence: songs.length === 1 ? `Posts without *${mainLabel}*; the video keeps its other sound.` : `Posts without its ${songs.length} copyrighted songs; the video keeps its other sound.`,
  };
}

export function planToTargetMusic(plan: MusicPlan): TargetMusic {
  const extra = plan.soundName ? { soundName: plan.soundName } : {};
  if (plan.mode === "attach" && plan.track && plan.volumes) {
    return {
      mode: "attach",
      track: plan.track,
      musicVolume: plan.volumes.music,
      originalVolume: plan.volumes.original,
      ...(plan.startMs !== undefined ? { startMs: plan.startMs } : {}),
      ...(plan.endMs !== undefined ? { endMs: plan.endMs } : {}),
      ...extra,
    };
  }
  return { mode: plan.mode === "attach" ? "strip" : plan.mode, ...extra } as TargetMusic;
}

/**
 * What one connected platform does with a copyrighted song — the export
 * dialog's line (addendum §7). The mode is `copyrightedDefaultFor`'s alone —
 * for every platform whose rules can attach at all, its `copyrightedDefault`
 * already reads "attach" under the exact facts that make `canAttachOn` true
 * (an invariant test holds every platform to it). Only a `picked` track is a
 * promise; with none, attach still depends on the catalog having the song, so
 * the line says where it looks.
 */
export function songPlatformNote(platform: KnownPlatform, facts: AccountMusicFacts, pick?: PlatformPick): string {
  const P = platformLabel(platform);
  const rules = PLATFORM_MUSIC_RULES[platform];
  const mode = copyrightedDefaultFor(platform, facts, pick);
  switch (mode) {
    case "attach":
      return pick?.status === "picked" || !rules.attachIfFound ? `${P} attaches it at posting` : `${P} attaches it ${rules.attachIfFound}`;
    case "draft":
      return `${P}: sent as a draft to finish in the app`;
    case "include":
      return `${P}: keep it in${rules.includeNote ? ` (${rules.includeNote})` : ""}`;
    default:
      return `${P}: left out`;
  }
}

export function songPlatformsLine(entries: Array<{ platform: KnownPlatform; facts: AccountMusicFacts }>, picks?: PlatformPicks): string {
  return entries.map((e) => songPlatformNote(e.platform, e.facts, picks?.[e.platform])).join(" · ");
}
