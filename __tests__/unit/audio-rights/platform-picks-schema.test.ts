import { describe, it, expect } from "vitest";
import { parseAudioRights, serializeAudioRights, type AudioRights } from "@/lib/audio-rights/types";
import { derivedRights, effectiveRights } from "@/lib/audio-rights/read";

const base: AudioRights = { class: "copyrighted", track: { title: "Espresso", artist: "Sabrina Carpenter" }, decidedBy: "agent", decidedAt: "2026-09-28T00:00:00.000Z" };
const picked = { status: "picked" as const, track: { id: "tt-1", title: "Espresso", artist: "Sabrina Carpenter", durationSec: 175 }, decidedBy: "auto" as const, decidedAt: "2026-09-28T00:00:01.000Z", providerId: "acme", accountId: "tt" };

describe("AudioRights.platformPicks", () => {
  it("an old row without picks parses unchanged", () => {
    expect(parseAudioRights(JSON.stringify(base))).toEqual(base);
  });

  it("round-trips picks keyed by platform, including a platform this build has never heard of", () => {
    const r: AudioRights = { ...base, platformPicks: { tiktok: picked, instagram: { status: "not_found", decidedBy: "auto", decidedAt: "x" } } };
    expect(parseAudioRights(serializeAudioRights(r))).toEqual(r);
    const future = JSON.stringify({ ...base, platformPicks: { threads: { status: "not_found", decidedBy: "auto", decidedAt: "x" } } });
    expect(parseAudioRights(future)?.platformPicks).toEqual({ threads: { status: "not_found", decidedBy: "auto", decidedAt: "x" } });
  });

  it("'picked' needs a track; 'not_found' and 'draft' carry none (a writer's bug throws)", () => {
    expect(() => serializeAudioRights({ ...base, platformPicks: { tiktok: { status: "picked", decidedBy: "user", decidedAt: "x" } } })).toThrow();
    expect(() => serializeAudioRights({ ...base, platformPicks: { tiktok: { status: "draft", track: picked.track, decidedBy: "user", decidedAt: "x" } } })).toThrow();
  });

  it("a malformed pick costs the file its picks, never its class or song", () => {
    const bad = JSON.stringify({ ...base, platformPicks: { tiktok: { status: "picked", decidedBy: "auto", decidedAt: "x" } } });
    expect(parseAudioRights(bad)).toEqual(base);
    const badKey = JSON.stringify({ ...base, platformPicks: { "TikTok!": picked } });
    expect(parseAudioRights(badKey)).toEqual(base);
  });

  it("effectiveRights carries the picks through; derivedRights never has any", () => {
    const row = { type: "audio", hasAudio: true, audioRights: serializeAudioRights({ ...base, platformPicks: { tiktok: picked } }) };
    expect(effectiveRights(row)?.platformPicks).toEqual({ tiktok: picked });
    expect(derivedRights([row])?.platformPicks).toBeUndefined();
  });
});
