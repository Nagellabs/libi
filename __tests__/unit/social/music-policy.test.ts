import { describe, it, expect } from "vitest";
import {
  confidentMatch, normalizeArtist, normalizeSongTitle, planToTargetMusic, resolveMusicPlan,
  canAttachOn, catalogQueryFor, copyrightedDefaultFor, PLATFORM_MUSIC_RULES,
  songSocialRow, accountPerPlatform, songPlatformsLine, songPlatformNote,
  type AccountMusicFacts, type CatalogTrack,
} from "@/lib/social/music-policy";
import type { PieceAudio, PieceSong } from "@/lib/audio-rights/piece-audio";
import type { PlatformPick } from "@/lib/audio-rights/types";

const song = (over: Partial<PieceSong> = {}): PieceSong => ({
  fileId: "song", name: "song.mp3", clipSeconds: 20, firstStart: 0, firstTrimStart: 12.5, volume: 0.8,
  rights: { class: "copyrighted", track: { title: "Espresso", artist: "Sabrina Carpenter" }, decidedBy: "provenance", decidedAt: "x" },
  ...over,
});
const own = (title?: string): PieceSong => ({ ...song({ fileId: "own" }), rights: { class: "generated", ...(title ? { track: { title } } : {}), decidedBy: "provenance", decidedAt: "x" } });
const piece = (copyrighted: PieceSong[], ownMusic: PieceSong[] = [], durationSec = 30): PieceAudio => ({ copyrighted, ownMusic, durationSec });
const ESPRESSO: CatalogTrack = { id: "tt-1", title: "Espresso", artist: "Sabrina Carpenter", durationSec: 175, kind: "trending", rank: 3 };
const now = "2026-09-27T00:00:00.000Z";
const business: AccountMusicFacts = { tiktokKind: { value: "business", source: "detected", checkedAt: now } };
const personal: AccountMusicFacts = { tiktokKind: { value: "personal", source: "user", checkedAt: now } };
const fbLogin: AccountMusicFacts = { instagramFacebookLogin: { value: true, source: "detected", checkedAt: now } };
const igLogin: AccountMusicFacts = { instagramFacebookLogin: { value: false, source: "detected", checkedAt: now } };

describe("matching", () => {
  it("normalizes titles", () => {
    expect(normalizeSongTitle("Espresso (Official Video)")).toBe("espresso");
    expect(normalizeSongTitle("Please Please Please ft. Someone")).toBe("please please please");
    expect(normalizeSongTitle("Taste (feat. X)")).toBe("taste");
    expect(normalizeSongTitle("Don't Stop!")).toBe("don t stop");
  });
  it("needs title equal AND artist equal or contained", () => {
    expect(confidentMatch({ title: "Espresso (Official Video)", artist: "Sabrina Carpenter" }, [ESPRESSO])).toBe(ESPRESSO);
    expect(confidentMatch({ title: "Espresso", artist: "Sabrina" }, [ESPRESSO])).toBe(ESPRESSO);
    expect(confidentMatch({ title: "Espresso", artist: "Someone Else" }, [ESPRESSO])).toBeNull();
    expect(confidentMatch({ title: "Espresso" }, [ESPRESSO])).toBeNull();
    expect(confidentMatch(undefined, [ESPRESSO])).toBeNull();
  });

  it("'contained' is a whole-word token-run match, not a raw substring", () => {
    const STEVE: CatalogTrack = { id: "s-1", title: "Bad Habit", artist: "Steve Lacy", kind: "trending" };
    expect(confidentMatch({ title: "Bad Habit", artist: "Eve" }, [STEVE])).toBeNull();
    const JOANNA: CatalogTrack = { id: "j-1", title: "Sapokanikan", artist: "Joanna Newsom", kind: "trending" };
    expect(confidentMatch({ title: "Sapokanikan", artist: "Ann" }, [JOANNA])).toBeNull();
    const XX: CatalogTrack = { id: "xx-1", title: "Crystalised", artist: "The xx", kind: "trending" };
    expect(confidentMatch({ title: "Crystalised", artist: "X" }, [XX])).toBeNull();
    expect(
      confidentMatch({ title: "Espresso", artist: "Sabrina Carpenter" }, [{ ...ESPRESSO, artist: "Sabrina Carpenter, Someone" }]),
    ).not.toBeNull();
    expect(
      confidentMatch({ title: "Espresso", artist: "Sabrina Carpenter" }, [{ ...ESPRESSO, artist: "Sabrina Carpenter feat. X" }]),
    ).not.toBeNull();
  });

  it("folds diacritics and treats '&' as 'and' when normalizing", () => {
    expect(normalizeSongTitle("Café")).toBe(normalizeSongTitle("Cafe"));
    expect(confidentMatch({ title: "Halo", artist: "Beyoncé" }, [{ id: "b-1", title: "Halo", artist: "Beyonce", kind: "trending" }])).not.toBeNull();
    expect(normalizeArtist("Simon & Garfunkel")).toBe(normalizeArtist("Simon and Garfunkel"));
  });

});

describe("resolveMusicPlan — copyrighted", () => {
  it("instagram (Facebook Login): attach the confident match, the spec's sentence", () => {
    const p = resolveMusicPlan({ platform: "instagram", catalog: [{ ...ESPRESSO, kind: "search", id: "ig-9" }] }, fbLogin, piece([song()]));
    expect(p).toMatchObject({ mode: "attach", track: { id: "ig-9", title: "Espresso" }, volumes: { music: 80, original: 100 }, exportVariant: "without-song" });
    expect(p.sentence).toBe("Posts without *Espresso — Sabrina Carpenter* and attaches Instagram's licensed version.");
  });

  it("instagram (Instagram Login): strip, and needs a reconnect", () => {
    const p = resolveMusicPlan({ platform: "instagram" }, igLogin, piece([song()]));
    expect(p.mode).toBe("strip");
    expect(p.needs).toBe("Reconnect Instagram with Facebook Login to attach licensed music.");
    expect(p.allowedModes).toEqual(["include", "strip"]);
  });

  it("instagram: no confident match → needs a choice, falls back to strip", () => {
    const p = resolveMusicPlan({ platform: "instagram", catalog: [] }, fbLogin, piece([song()]));
    expect(p).toMatchObject({ mode: "strip", needsChoice: true });
    expect(p.warnings[0]).toBe("No exact match for *Espresso — Sabrina Carpenter* in Instagram's library — pick a track to attach it instead.");
  });

  it("tiktok business: attach with start/end in ms, capped at the track", () => {
    const p = resolveMusicPlan({ platform: "tiktok", catalog: [ESPRESSO] }, business, piece([song()], [], 30));
    expect(p).toMatchObject({ mode: "attach", startMs: 12500, endMs: 42500, exportVariant: "without-song" });
    const capped = resolveMusicPlan({ platform: "tiktok", catalog: [{ ...ESPRESSO, durationSec: 20 }] }, business, piece([song()], [], 30));
    expect(capped.endMs).toBe(20000);
  });

  it("tiktok business, no match → draft (the fallback)", () => {
    const p = resolveMusicPlan({ platform: "tiktok", catalog: [] }, business, piece([song()]));
    expect(p.mode).toBe("draft");
    expect(p.warnings[0]).toBe("No exact match for *Espresso — Sabrina Carpenter* in TikTok's trending list — pick a track to attach it instead.");
  });

  it("tiktok business, catalog unavailable (null) → draft with a warning", () => {
    const p = resolveMusicPlan({ platform: "tiktok", catalog: null }, business, piece([song()]));
    expect(p.mode).toBe("draft");
    expect(p.warnings[0]).toBe("TikTok's music library couldn't be read, so this uses the fallback.");
  });

  it("tiktok personal: a Creator Inbox draft, the spec's sentence", () => {
    const p = resolveMusicPlan({ platform: "tiktok" }, personal, piece([song()]));
    expect(p.mode).toBe("draft");
    expect(p.sentence).toBe("Sends a TikTok draft without the song. Open it in TikTok and add *Espresso* from the sound library.");
    expect(p.allowedModes).toEqual(["draft", "include", "strip"]);
  });

  it("tiktok unknown kind: draft, and asks for the account type", () => {
    const p = resolveMusicPlan({ platform: "tiktok" }, {}, piece([song()]));
    expect(p.mode).toBe("draft");
    expect(p.needs).toBe("Set this TikTok account's type (Business or Personal) in Social → Settings.");
  });

  it("tiktok personal, include chosen: with-song, and warns it likely posts silent", () => {
    const p = resolveMusicPlan({ platform: "tiktok" }, personal, piece([song()]), { mode: "include" });
    expect(p).toMatchObject({ mode: "include", exportVariant: "with-song" });
    expect(p.warnings).toContain("TikTok will likely mute the song or post the video without sound.");
  });

  it("youtube: keeps the song (with-song), the Content ID sentence, no warning", () => {
    const p = resolveMusicPlan({ platform: "youtube" }, {}, piece([song()]));
    expect(p).toMatchObject({ mode: "include", exportVariant: "with-song", warnings: [] });
    expect(p.sentence).toBe("Keeps the song in the video. YouTube will likely claim it: the owner may run ads on it or block it in some countries. It is not a strike.");
  });

  it("facebook and X strip by default; include is explicit and warned", () => {
    expect(resolveMusicPlan({ platform: "facebook" }, {}, piece([song()])).mode).toBe("strip");
    const x = resolveMusicPlan({ platform: "twitter" }, {}, piece([song()]), { mode: "include" });
    expect(x.warnings).toContain("X disables a video on a copyright report, and reports count toward suspending the account.");
    expect(resolveMusicPlan({ platform: "twitter" }, {}, piece([song()])).sentence).toBe("Posts without *Espresso — Sabrina Carpenter*; the video keeps its other sound.");
  });

  it("an override the platform does not allow is ignored", () => {
    expect(resolveMusicPlan({ platform: "youtube" }, {}, piece([song()]), { mode: "attach" }).mode).toBe("include");
  });

  it("several songs: attaches the longest, says the rest are left out", () => {
    const p = resolveMusicPlan({ platform: "tiktok", catalog: [ESPRESSO] }, business, piece([song(), song({ fileId: "b", clipSeconds: 5, rights: { class: "copyrighted", track: { title: "Taste" }, decidedBy: "provenance", decidedAt: "x" } })]));
    expect(p.sentence).toBe("Posts without *Espresso — Sabrina Carpenter* and attaches TikTok's licensed version. Only one song can be attached; *Taste* is left out.");
  });

  it("a song that starts late: the platform copy starts at the beginning", () => {
    const p = resolveMusicPlan({ platform: "tiktok", catalog: [ESPRESSO] }, business, piece([song({ firstStart: 3 })]));
    expect(p.sentence).toMatch(/TikTok's copy starts at the beginning of the video\.$/);
  });

  it("a picked track that is not the song says which one it attaches", () => {
    const other: CatalogTrack = { id: "tt-2", title: "Self Aware", artist: "Mark Allan Wolfe", kind: "trending" };
    const p = resolveMusicPlan({ platform: "tiktok", catalog: [ESPRESSO, other] }, business, piece([song()]), { track: other });
    expect(p.sentence).toBe("Posts without *Espresso — Sabrina Carpenter* and attaches *Self Aware — Mark Allan Wolfe* from TikTok's library. It's the track you picked.");
  });

  it("tiktok attach: a substitute track (not the piece's own song) starts at 0", () => {
    const other: CatalogTrack = { id: "tt-2", title: "Self Aware", artist: "Mark Allan Wolfe", durationSec: 200, kind: "trending" };
    const p = resolveMusicPlan({ platform: "tiktok", catalog: [ESPRESSO, other] }, business, piece([song({ firstTrimStart: 12.5 })], [], 30), { track: other });
    expect(p.startMs).toBe(0);
    expect(p.endMs).toBe(30000);
  });

  it("tiktok attach: startMs at/after the track's duration resets to 0, and endMs is never <= startMs", () => {
    const p = resolveMusicPlan({ platform: "tiktok", catalog: [{ ...ESPRESSO, durationSec: 10 }] }, business, piece([song({ firstTrimStart: 12.5 })], [], 30));
    expect(p.startMs).toBe(0);
    expect(p.endMs).toBe(10000);
    expect(p.endMs!).toBeGreaterThan(p.startMs!);
  });

  it("tiktok business, catalog not asked (undefined) → draft, says the catalog wasn't checked", () => {
    const p = resolveMusicPlan({ platform: "tiktok" }, business, piece([song()]));
    expect(p.mode).toBe("draft");
    expect(p.warnings[0]).toBe("TikTok's music library wasn't checked, so this uses the fallback.");
  });

  it("a low-confidence track guess (e.g. a yt-dlp title) is never auto-attached", () => {
    const guess = song({
      rights: { class: "copyrighted", track: { title: "Espresso", artist: "Sabrina Carpenter", trackConfidence: "low" }, decidedBy: "provenance", decidedAt: "x" },
    });
    const p = resolveMusicPlan({ platform: "tiktok", catalog: [ESPRESSO] }, business, piece([guess]));
    expect(p.mode).toBe("draft");
    expect(p.needsChoice).toBe(true);
    expect(p.warnings[0]).toBe("*Espresso — Sabrina Carpenter*'s identity needs confirming before it can be matched automatically — pick a track to attach it instead.");
  });

  it("volume above 1 is capped at 100", () => {
    const p = resolveMusicPlan({ platform: "tiktok", catalog: [ESPRESSO] }, business, piece([song({ volume: 1.5 })]));
    expect(p.volumes?.music).toBe(100);
  });

  it("instagram attach carries no startMs/endMs", () => {
    const p = resolveMusicPlan({ platform: "instagram", catalog: [{ ...ESPRESSO, kind: "search", id: "ig-9" }] }, fbLogin, piece([song()]));
    expect(p.startMs).toBeUndefined();
    expect(p.endMs).toBeUndefined();
  });

  it("instagram: include chosen against the default is warned", () => {
    const p = resolveMusicPlan({ platform: "instagram" }, igLogin, piece([song()]), { mode: "include" });
    expect(p.warnings).toContain("Instagram may mute the song or block the Reel in some countries.");
  });

  it("instagram (Instagram Login), the user keeps the song: no Facebook-Login reconnect — include needs no catalog", () => {
    const p = resolveMusicPlan({ platform: "instagram" }, igLogin, piece([song()], [own("lofi rain")]), { mode: "include" });
    expect(p.mode).toBe("include");
    expect(p.needs).toBeUndefined();
  });

  it("instagram (Instagram Login), no copyrighted song: no reconnect either", () => {
    const p = resolveMusicPlan({ platform: "instagram" }, igLogin, piece([], [own("lofi rain")]));
    expect(p.needs).toBeUndefined();
  });

  it("instagram: the song kept in the video is never named as the post's own sound", () => {
    // The Reel's audio IS the copyrighted song: calling it "lofi rain" (the
    // generated bed's title) would mislabel someone else's music (QA F3).
    const p = resolveMusicPlan({ platform: "instagram" }, igLogin, piece([song()], [own("lofi rain")]), { mode: "include", soundName: "my mix" });
    expect(p.soundName).toBeUndefined();
    expect(planToTargetMusic(p)).toEqual({ mode: "include" });
  });

  it("instagram: stripping the song keeps the own music, and names it", () => {
    const p = resolveMusicPlan({ platform: "instagram" }, igLogin, piece([song()], [own("lofi rain")]));
    expect(p).toMatchObject({ mode: "strip", soundName: "lofi rain", needs: "Reconnect Instagram with Facebook Login to attach licensed music." });
  });

  it("facebook: include chosen against the default is warned", () => {
    const p = resolveMusicPlan({ platform: "facebook" }, {}, piece([song()]), { mode: "include" });
    expect(p.warnings).toContain("Facebook Pages can't use commercial music: Facebook may mute the video or block it.");
  });

  it("tiktok personal, several songs, draft: says the others are left out too", () => {
    const p = resolveMusicPlan(
      { platform: "tiktok" },
      personal,
      piece([song(), song({ fileId: "b", clipSeconds: 5, rights: { class: "copyrighted", track: { title: "Taste" }, decidedBy: "provenance", decidedAt: "x" } })]),
    );
    expect(p.sentence).toBe("Sends a TikTok draft without the song. Open it in TikTok and add *Espresso* from the sound library. *Taste* is left out too.");
  });
});

describe("resolveMusicPlan — awaitingPick: attach set, no track decided", () => {
  const nf: PlatformPick = { status: "not_found", decidedBy: "auto", decidedAt: "x" };
  it("no confident match in a list that was read: awaits a pick (the fallback stays an agent's mode)", () => {
    const p = resolveMusicPlan({ platform: "tiktok", catalog: [{ id: "tt-2", title: "Other", artist: "Someone", kind: "trending" }] }, business, piece([song()]));
    expect(p).toMatchObject({ mode: "draft", needsChoice: true, awaitingPick: true });
    expect(resolveMusicPlan({ platform: "instagram", catalog: [] }, fbLogin, piece([song()])).awaitingPick).toBe(true);
  });
  it("a list that couldn't be read (or wasn't) can't be picked from: the fallback stands", () => {
    expect(resolveMusicPlan({ platform: "tiktok", catalog: null }, business, piece([song()])).awaitingPick).toBeUndefined();
    expect(resolveMusicPlan({ platform: "tiktok" }, business, piece([song()])).awaitingPick).toBeUndefined();
  });
  it("a 'not_found' song awaits a pick; the user's own other option ends the wait", () => {
    expect(resolveMusicPlan({ platform: "tiktok" }, business, piece([withPick("tiktok", nf)])).awaitingPick).toBe(true);
    expect(resolveMusicPlan({ platform: "tiktok" }, business, piece([withPick("tiktok", nf)]), { mode: "draft" }).awaitingPick).toBeUndefined();
    expect(resolveMusicPlan({ platform: "tiktok" }, business, piece([withPick("tiktok", nf)]), { mode: "include" }).awaitingPick).toBeUndefined();
  });
  it("the post's own Attach beats the song's draft pick: a match attaches, no match awaits a pick", () => {
    const draft: PlatformPick = { status: "draft", decidedBy: "user", decidedAt: "x" };
    const matched = resolveMusicPlan({ platform: "tiktok", catalog: [ESPRESSO] }, business, piece([withPick("tiktok", draft)]), { mode: "attach" });
    expect(matched).toMatchObject({ mode: "attach", track: { id: "tt-1" } });
    const none = resolveMusicPlan({ platform: "tiktok", catalog: [] }, business, piece([withPick("tiktok", draft)]), { mode: "attach" });
    expect(none.awaitingPick).toBe(true);
  });
  it("a stored pick that left today's trending list awaits a new one", () => {
    const p = resolveMusicPlan({ platform: "tiktok", catalog: [ESPRESSO] }, business, piece([withPick("tiktok", userPick)]));
    expect(p.awaitingPick).toBe(true);
  });
  it("never where the account can't attach, or once a track is decided", () => {
    expect(resolveMusicPlan({ platform: "tiktok" }, personal, piece([withPick("tiktok", nf)])).awaitingPick).toBeUndefined();
    expect(resolveMusicPlan({ platform: "tiktok", catalog: [ESPRESSO] }, business, piece([song()])).awaitingPick).toBeUndefined();
    expect(resolveMusicPlan({ platform: "tiktok" }, business, piece([withPick("tiktok", userPick)])).awaitingPick).toBeUndefined();
  });
});

describe("resolveMusicPlan — generated / owned / none", () => {
  it("own music: always include; Instagram names the sound", () => {
    const ig = resolveMusicPlan({ platform: "instagram" }, fbLogin, piece([], [own("lofi rain")]));
    expect(ig).toMatchObject({ mode: "include", soundName: "lofi rain", allowedModes: ["include"], exportVariant: "with-song" });
    expect(ig.sentence).toBe("Keeps your music in the video; Instagram names its sound *lofi rain*.");
    const noSong = resolveMusicPlan({ platform: "tiktok" }, business, piece([], [own()]));
    expect(noSong.sentence).toBe("Keeps your music in the video; it becomes this post's original sound.");
    expect(noSong.exportVariant).toBe("with-song");
  });
  it("no music at all", () => {
    expect(resolveMusicPlan({ platform: "tiktok" }, business, piece([])).sentence).toBe("This piece has no music to handle.");
  });
});

describe("planToTargetMusic", () => {
  it("carries the attach payload", () => {
    const p = resolveMusicPlan({ platform: "tiktok", catalog: [ESPRESSO] }, business, piece([song()]));
    expect(planToTargetMusic(p)).toEqual({ mode: "attach", track: { id: "tt-1", title: "Espresso", artist: "Sabrina Carpenter" }, musicVolume: 80, originalVolume: 100, startMs: 12500, endMs: 42500 });
    expect(planToTargetMusic(resolveMusicPlan({ platform: "tiktok" }, personal, piece([song()])))).toEqual({ mode: "draft" });
  });
});

const withPick = (platform: "tiktok" | "instagram", p: PlatformPick) =>
  song({ rights: { ...song().rights, platformPicks: { [platform]: p } } });
const userPick: PlatformPick = { status: "picked", track: { id: "tt-9", title: "Self Aware", artist: "Mark Allan Wolfe", durationSec: 227 }, decidedBy: "user", decidedAt: "x" };
const autoPick: PlatformPick = { status: "picked", track: { id: "tt-1", title: "Espresso", artist: "Sabrina Carpenter", durationSec: 175 }, decidedBy: "auto", decidedAt: "x" };

describe("resolveMusicPlan — the song's own pick (addendum §2)", () => {
  it("a stored user pick attaches without a catalog, and says it is the user's", () => {
    const p = resolveMusicPlan({ platform: "tiktok" }, business, piece([withPick("tiktok", userPick)]));
    expect(p).toMatchObject({ mode: "attach", track: { id: "tt-9" }, trackSource: "user" });
    expect(p.needsChoice).toBeUndefined();
    expect(p.sentence).toBe("Posts without *Espresso — Sabrina Carpenter* and attaches *Self Aware — Mark Allan Wolfe* from TikTok's library. It's the track you picked.");
  });

  it("a stored automatic match keeps the binding sentence and adds where it came from", () => {
    const p = resolveMusicPlan({ platform: "tiktok" }, business, piece([withPick("tiktok", autoPick)]));
    expect(p.sentence).toBe("Posts without *Espresso — Sabrina Carpenter* and attaches TikTok's licensed version. Matched automatically.");
    expect(p.startMs).toBe(12500);
  });

  it("the post's own override beats the song's pick", () => {
    const override = { id: "tt-7", title: "Other", artist: "Someone", kind: "trending" as const };
    const p = resolveMusicPlan({ platform: "tiktok" }, business, piece([withPick("tiktok", autoPick)]), { mode: "attach", track: override });
    expect(p).toMatchObject({ track: { id: "tt-7" }, trackSource: "override" });
  });

  it("a live confident match (no stored pick) keeps the binding sentence verbatim", () => {
    const p = resolveMusicPlan({ platform: "instagram", catalog: [{ ...ESPRESSO, kind: "search", id: "ig-9" }] }, fbLogin, piece([song()]));
    expect(p.sentence).toBe("Posts without *Espresso — Sabrina Carpenter* and attaches Instagram's licensed version.");
    expect(p.trackSource).toBe("matched");
  });

  it("a 'draft' pick makes TikTok's default the draft, with the spec sentence", () => {
    const p = resolveMusicPlan({ platform: "tiktok" }, business, piece([withPick("tiktok", { status: "draft", decidedBy: "user", decidedAt: "x" })]));
    expect(p.mode).toBe("draft");
    expect(p.sentence).toBe("Sends a TikTok draft without the song. Open it in TikTok and add *Espresso* from the sound library.");
    expect(p.warnings).toEqual([]);
  });

  it("'not_found' does not re-guess: TikTok → draft, Instagram → strip, decided (no needsChoice)", () => {
    const nf: PlatformPick = { status: "not_found", decidedBy: "auto", decidedAt: "x" };
    const tt = resolveMusicPlan({ platform: "tiktok", catalog: [ESPRESSO] }, business, piece([withPick("tiktok", nf)]));
    expect(tt.mode).toBe("draft");
    expect(tt.needsChoice).toBeUndefined();
    expect(tt.warnings).toEqual(["No exact match for *Espresso — Sabrina Carpenter* in TikTok's trending list — pick a track to attach it instead."]);
    const ig = resolveMusicPlan({ platform: "instagram" }, fbLogin, piece([withPick("instagram", nf)]));
    expect(ig.mode).toBe("strip");
    expect(ig.sentence).toBe("Posts without *Espresso — Sabrina Carpenter*; the video keeps its other sound.");
    expect(ig.needsChoice).toBeUndefined();
  });

  it("a stored TikTok pick that left today's trending list is not attached: the draft fallback, saying why (I2)", () => {
    const other: CatalogTrack = { id: "tt-2", title: "Other", artist: "Someone", kind: "trending" };
    const p = resolveMusicPlan({ platform: "tiktok", catalog: [other] }, business, piece([withPick("tiktok", userPick)]));
    expect(p.mode).toBe("draft");
    expect(p.track).toBeUndefined();
    expect(p.needsChoice).toBeUndefined();
    expect(p.warnings).toEqual(["*Self Aware — Mark Allan Wolfe* is no longer in TikTok's top 100 — pick another track to attach it instead."]);
    // Not re-guessed from the list either, even when the piece's own song is in it.
    expect(resolveMusicPlan({ platform: "tiktok", catalog: [ESPRESSO] }, business, piece([withPick("tiktok", userPick)])).mode).toBe("draft");
  });

  it("a stored TikTok pick still in the list attaches; an unread list can't tell, so the pick is trusted", () => {
    const listed: CatalogTrack = { id: "tt-9", title: "Self Aware", artist: "Mark Allan Wolfe", kind: "trending" };
    expect(resolveMusicPlan({ platform: "tiktok", catalog: [listed] }, business, piece([withPick("tiktok", userPick)]))).toMatchObject({ mode: "attach", track: { id: "tt-9" } });
    expect(resolveMusicPlan({ platform: "tiktok", catalog: null }, business, piece([withPick("tiktok", userPick)]))).toMatchObject({ mode: "attach", track: { id: "tt-9" } });
  });

  it("a stored Instagram (search) pick is never judged by one search's results", () => {
    const igPick: PlatformPick = { ...userPick, track: { id: "ig-9", title: "Self Aware", artist: "Mark Allan Wolfe" } };
    expect(resolveMusicPlan({ platform: "instagram", catalog: [] }, fbLogin, piece([withPick("instagram", igPick)]))).toMatchObject({ mode: "attach", track: { id: "ig-9" } });
  });

  it("a pick on an account that cannot attach is ignored", () => {
    const p = resolveMusicPlan({ platform: "instagram" }, igLogin, piece([withPick("instagram", { ...autoPick, track: { id: "ig-1", title: "Espresso", artist: "Sabrina Carpenter" } })]));
    expect(p.mode).toBe("strip");
    expect(p.needs).toBe("Reconnect Instagram with Facebook Login to attach licensed music.");
  });
});

describe("rules-derived helpers", () => {
  it("attach capability, the blocker, and the search query come from the rules", () => {
    expect(canAttachOn("tiktok", business)).toBe(true);
    expect(canAttachOn("tiktok", personal)).toBe(false);
    expect(canAttachOn("youtube", business)).toBe(false);
    expect(PLATFORM_MUSIC_RULES.tiktok.attachBlocker(personal)).toBe("not_business");
    expect(PLATFORM_MUSIC_RULES.tiktok.attachBlocker({})).toBe("error");
    expect(PLATFORM_MUSIC_RULES.instagram.attachBlocker(igLogin)).toBe("needs_facebook_login");
    expect(PLATFORM_MUSIC_RULES.instagram.attachBlocker(fbLogin)).toBeNull();
    expect(PLATFORM_MUSIC_RULES.youtube.attachBlocker({})).toBe("unsupported");
    expect(catalogQueryFor("instagram", { title: "Espresso", artist: "Sabrina Carpenter" })).toBe("Espresso Sabrina Carpenter");
    expect(catalogQueryFor("tiktok", { title: "Espresso", artist: "Sabrina Carpenter" })).toBeUndefined();
  });

  it("copyrightedDefaultFor reads the pick", () => {
    expect(copyrightedDefaultFor("tiktok", business)).toBe("attach");
    expect(copyrightedDefaultFor("tiktok", business, { status: "draft", decidedBy: "user", decidedAt: "x" })).toBe("draft");
    expect(copyrightedDefaultFor("tiktok", business, { status: "not_found", decidedBy: "auto", decidedAt: "x" })).toBe("draft");
    expect(copyrightedDefaultFor("instagram", fbLogin, { status: "not_found", decidedBy: "auto", decidedAt: "x" })).toBe("strip");
  });

  it("invariant: wherever an account can attach, the copyrighted default IS attach (M7)", () => {
    const factSets: AccountMusicFacts[] = [{}, business, personal, fbLogin, igLogin, { ...business, ...fbLogin }, { ...personal, ...igLogin }];
    for (const platform of Object.keys(PLATFORM_MUSIC_RULES) as Array<keyof typeof PLATFORM_MUSIC_RULES>) {
      for (const facts of factSets) {
        if (canAttachOn(platform, facts)) expect(PLATFORM_MUSIC_RULES[platform].copyrightedDefault(facts), `${platform} ${JSON.stringify(facts)}`).toBe("attach");
      }
    }
  });

  it("carries the addendum's TikTok picker note verbatim", () => {
    expect(PLATFORM_MUSIC_RULES.tiktok.pickerNote).toBe(
      "These are TikTok's current top 100 trending tracks — the only ones TikTok lets apps attach. There's no search. If your song isn't here, send the post as a TikTok draft and pick the sound in the TikTok app.",
    );
  });
});

describe("the details panel's rows", () => {
  it("reads each platform's state in the addendum's words", () => {
    expect(songSocialRow("tiktok", business, { status: "picked", track: { id: "t", title: "Blinding Lights", artist: "The Weeknd" }, decidedBy: "auto", decidedAt: "x" }))
      .toEqual({ platform: "tiktok", text: "TikTok · Blinding Lights — The Weeknd", action: "change", track: { id: "t", title: "Blinding Lights", artist: "The Weeknd" } });
    expect(songSocialRow("tiktok", business, { status: "not_found", decidedBy: "auto", decidedAt: "x" }))
      .toEqual({ platform: "tiktok", text: "TikTok · not in the top 100 — will go as a draft", action: "choose" });
    expect(songSocialRow("instagram", igLogin)).toEqual({ platform: "instagram", text: "Instagram · needs Facebook Login", action: null });
    expect(songSocialRow("instagram", fbLogin, { status: "not_found", decidedBy: "auto", decidedAt: "x" }).text).toBe("Instagram · not found in Instagram's music — will be left out");
    expect(songSocialRow("tiktok", business, { status: "draft", decidedBy: "user", decidedAt: "x" })).toEqual({ platform: "tiktok", text: "TikTok · you'll pick the sound in the TikTok app", action: "change" });
    expect(songSocialRow("tiktok", business)).toEqual({ platform: "tiktok", text: "TikTok · not matched yet", action: "choose" });
  });

  it("one account per platform, in rules order: the first that can attach, else the first", () => {
    const accounts = [
      { id: "ig1", platform: "instagram" as const, active: true },
      { id: "ig2", platform: "instagram" as const, active: true },
      { id: "tt1", platform: "tiktok" as const, active: true },
      { id: "yt1", platform: "youtube" as const, active: false },
    ];
    expect(accountPerPlatform(accounts, { ig1: igLogin, ig2: fbLogin, tt1: personal })).toEqual([
      { platform: "instagram", accountId: "ig2", facts: fbLogin },
      { platform: "tiktok", accountId: "tt1", facts: personal },
    ]);
  });
});

describe("the export dialog's platform line", () => {
  it("says what each connected platform does with the song", () => {
    const tiktokPick: PlatformPick = { status: "picked", track: { id: "t", title: "Espresso" }, decidedBy: "auto", decidedAt: "x" };
    expect(songPlatformsLine([{ platform: "tiktok", facts: business }, { platform: "instagram", facts: fbLogin }, { platform: "youtube", facts: {} }], {
      tiktok: tiktokPick, instagram: { status: "not_found", decidedBy: "auto", decidedAt: "x" },
    })).toBe("TikTok attaches it at posting · Instagram: left out · YouTube: keep it in (likely claimed)");
    expect(songPlatformsLine([{ platform: "tiktok", facts: personal }])).toBe("TikTok: sent as a draft to finish in the app");
  });

  it("with no picked track, attach is not promised: it depends on the catalog having the song (M8)", () => {
    expect(songPlatformNote("tiktok", business)).toBe("TikTok attaches it if it's in the top 100");
    expect(songPlatformNote("instagram", fbLogin)).toBe("Instagram attaches it if Instagram's music has it");
    const picked: PlatformPick = { status: "picked", track: { id: "t", title: "Espresso" }, decidedBy: "auto", decidedAt: "x" };
    expect(songPlatformNote("tiktok", business, picked)).toBe("TikTok attaches it at posting");
  });

  it("a draft pick sends it as a TikTok draft regardless of account facts", () => {
    const draftPick: PlatformPick = { status: "draft", decidedBy: "user", decidedAt: "x" };
    expect(songPlatformNote("tiktok", personal, draftPick)).toBe("TikTok: sent as a draft to finish in the app");
    expect(songPlatformNote("tiktok", business, draftPick)).toBe("TikTok: sent as a draft to finish in the app");
  });

  it("a platform with no includeNote shows a plain line, never a stray parenthetical", () => {
    // Only youtube's rules carry an includeNote, and only youtube's
    // copyrightedDefault ever resolves to "include" — so the ternary's
    // no-note branch is exercised through the plain "left out" line
    // instead, verified against the SAME `includeNote` field it guards.
    expect(PLATFORM_MUSIC_RULES.twitter.includeNote).toBeUndefined();
    expect(songPlatformNote("twitter", {})).toBe("X: left out");
  });
});
