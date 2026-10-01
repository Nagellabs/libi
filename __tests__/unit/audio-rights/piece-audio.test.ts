import { describe, it, expect } from "vitest";
import { pieceAudioOf, type PieceFileLike } from "@/lib/audio-rights/piece-audio";
import { serializeAudioRights } from "@/lib/audio-rights/types";

const f = (id: string, rights: object | null, type = "audio", hasAudio = true): PieceFileLike => ({
  id, name: id, type, hasAudio, createdAt: "2026-09-27T00:00:00.000Z",
  audioRights: rights ? serializeAudioRights(rights as never) : null,
});
const clip = (id: string, fileId: string, startTime: number, duration: number, over: object = {}) =>
  ({ id, kind: "standalone" as const, fileId, startTime, duration, trimStart: 2, volume: 0.8, enabled: true, ...over });

describe("pieceAudioOf", () => {
  it("groups audible clips per file and sorts copyrighted songs by total clip time", () => {
    const files = [
      f("song-a", { class: "copyrighted", track: { title: "A" }, decidedBy: "provenance", decidedAt: "x" }),
      f("song-b", { class: "copyrighted", decidedBy: "provenance", decidedAt: "x" }),
      f("mine", { class: "generated", decidedBy: "provenance", decidedAt: "x" }),
      // Unstamped: the user's own upload (owner decision 2026-09-28).
      f("upload", null),
      f("pic", null, "image"),
    ];
    const r = pieceAudioOf(
      { audioClips: [clip("c1", "song-a", 3, 4), clip("c2", "song-b", 0, 10), clip("c3", "song-a", 9, 2), clip("c4", "mine", 0, 5), clip("c5", "song-b", 12, 3, { enabled: false }), clip("c6", "upload", 0, 4)], overlays: [] },
      files,
    );
    expect(r.copyrighted.map((s) => [s.fileId, s.clipSeconds])).toEqual([["song-b", 10], ["song-a", 6]]);
    expect(r.copyrighted[1]).toMatchObject({ firstStart: 3, firstTrimStart: 2, volume: 0.8 });
    expect(r.ownMusic.map((s) => [s.fileId, s.rights.class])).toEqual([["mine", "generated"], ["upload", "owned"]]);
    expect(r.durationSec).toBe(15);
  });

  it("ignores muted and zero-volume clips and files it cannot find", () => {
    const r = pieceAudioOf({ audioClips: [clip("c1", "x", 0, 3, { volume: 0 }), clip("c2", "gone", 0, 3)] }, [f("x", null)]);
    expect(r.copyrighted).toEqual([]);
  });

  it("a video overlay's native audio counts too, via its inline clip — gated by hasAudio", () => {
    const files = [
      f("vid-with-audio", { class: "copyrighted", track: { title: "V" }, decidedBy: "provenance", decidedAt: "x" }, "video", true),
      f("vid-silent", { class: "copyrighted", decidedBy: "provenance", decidedAt: "x" }, "video", false),
    ];
    const r = pieceAudioOf(
      {
        audioClips: [
          clip("ic1", "vid-with-audio", 0, 5, { kind: "inline", linkedOverlayId: "ov-a" }),
          clip("ic2", "vid-silent", 5, 5, { kind: "inline", linkedOverlayId: "ov-b" }),
        ],
        overlays: [],
      },
      files,
    );
    expect(r.copyrighted.map((s) => s.fileId)).toEqual(["vid-with-audio"]);
  });
});
