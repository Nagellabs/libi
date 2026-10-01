import { describe, it, expect } from "vitest";
import { applyAudioExclusion, purposeRequiredMessage, resolveExportAudio, sameDecision } from "@/lib/export/audio-policy";
import { pieceAudioOf, type PieceFileLike } from "@/lib/audio-rights/piece-audio";
import { serializeAudioRights } from "@/lib/audio-rights/types";

const file = (id: string, cls: "copyrighted" | "generated" | null, title?: string): PieceFileLike => ({
  id, name: `${id}.mp3`, type: "audio", hasAudio: true, createdAt: "2026-09-27T00:00:00.000Z",
  audioRights: cls ? serializeAudioRights({ class: cls, ...(title ? { track: { title, artist: "Sabrina Carpenter" } } : {}), decidedBy: "provenance", decidedAt: "x" }) : null,
});
const clip = (id: string, fileId: string) => ({ id, kind: "standalone" as const, fileId, startTime: 0, duration: 3, trimStart: 0, volume: 1, enabled: true });
// "fetched": a remote import (copyrighted, no track). "upload": unstamped, so
// the user's own (owner decision 2026-09-28) — it always travels.
const files = [file("song", "copyrighted", "Espresso"), file("fetched", "copyrighted"), file("upload", null), file("mine", "generated")];
const manifest = { audioClips: [clip("a", "song"), clip("b", "fetched"), clip("u", "upload"), clip("c", "mine")] };

describe("resolveExportAudio", () => {
  it("social excludes every copyrighted file and keeps generated music and the user's unstamped upload", () => {
    const r = resolveExportAudio(manifest, files, { purpose: "social" });
    expect(r.excludedFileIds).toEqual(["fetched", "song"]);
    expect(r.carriesCopyrighted).toBe(false);
    expect(r.decision).toEqual({ purpose: "social", excludedFileIds: ["fetched", "song"], carriesCopyrighted: false });
  });

  it("personal includes everything", () => {
    const r = resolveExportAudio(manifest, files, { purpose: "personal" });
    expect(r.excludedFileIds).toEqual([]);
    expect(r.carriesCopyrighted).toBe(true);
  });

  it("includeFileIds re-includes one file on top of exclude (a dialog switch)", () => {
    const r = resolveExportAudio(manifest, files, { purpose: "social", copyrightedAudio: "exclude", includeFileIds: ["song"] });
    expect(r.excludedFileIds).toEqual(["fetched"]);
    expect(r.carriesCopyrighted).toBe(true);
  });

  it("an explicit copyrightedAudio beats the purpose default", () => {
    expect(resolveExportAudio(manifest, files, { purpose: "social", copyrightedAudio: "include" }).excludedFileIds).toEqual([]);
  });

  it("a piece with no copyrighted audio decides nothing", () => {
    const r = resolveExportAudio({ audioClips: [clip("c", "mine")] }, files, {});
    expect(r.decision).toEqual({ purpose: null, excludedFileIds: [], carriesCopyrighted: false });
  });

  it("excludeFileIds drops any file's clips, not only copyrighted ones, and the decision records it", () => {
    const r = resolveExportAudio(manifest, files, { purpose: "social", excludeFileIds: ["mine", "upload"] });
    expect(r.excludedFileIds).toEqual(["fetched", "mine", "song", "upload"]);
    expect(r.decision).toEqual({ purpose: "social", excludedFileIds: ["fetched", "mine", "song", "upload"], carriesCopyrighted: false });
  });

  it("excludeFileIds wins over includeFileIds, and names only files the piece plays", () => {
    const r = resolveExportAudio(manifest, files, { purpose: "personal", includeFileIds: ["song"], excludeFileIds: ["song", "ghost"] });
    expect(r.excludedFileIds).toEqual(["song"]);
    expect(r.carriesCopyrighted).toBe(true); // "fetched" still plays
  });
});

describe("helpers", () => {
  it("applyAudioExclusion drops clips (standalone and a video's inline sound) of excluded files", () => {
    const clips = [clip("a", "song"), { ...clip("v", "vid"), kind: "inline" as const, linkedOverlayId: "o1" }, clip("c", "mine")];
    expect(applyAudioExclusion(clips, ["song", "vid"]).map((c) => c.id)).toEqual(["c"]);
    expect(applyAudioExclusion(undefined, ["x"])).toEqual([]);
  });

  it("sameDecision compares what the file carries, not why", () => {
    const a = { purpose: "social" as const, excludedFileIds: ["b", "a"], carriesCopyrighted: false };
    expect(sameDecision(a, { purpose: null, excludedFileIds: ["a", "b"], carriesCopyrighted: false })).toBe(true);
    expect(sameDecision(a, { ...a, carriesCopyrighted: true })).toBe(false);
    expect(sameDecision(undefined, a)).toBe(false);
  });

  it("the refusal names the songs", () => {
    const songs = pieceAudioOf(manifest, files).copyrighted;
    expect(purposeRequiredMessage(songs)).toBe(
      "This piece has copyrighted music (Espresso — Sabrina Carpenter, fetched.mp3). Ask the user what this export is for — a social post or personal use — then pass `purpose`. If they asked to post it, use libi.post_piece instead, which exports per platform.",
    );
  });
});
