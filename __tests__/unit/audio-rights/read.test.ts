import { describe, it, expect, afterEach } from "vitest";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { files } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";
import { effectiveRights, fileCarriesAudio, isCopyrighted } from "@/lib/audio-rights/read";
import { filesForManifest } from "@/lib/audio-rights/piece-reader";
import { parseAudioRights, serializeAudioRights, songLabel, type AudioRights } from "@/lib/audio-rights/types";

const GENERATED: AudioRights = {
  class: "generated",
  track: { title: "lofi rain" },
  decidedBy: "provenance",
  decidedAt: "2026-09-27T10:00:00.000Z",
};

afterEach(() => resetTestDb());

describe("effectiveRights", () => {
  it("is null for a file that carries no audio", () => {
    expect(effectiveRights({ type: "image", hasAudio: null, audioRights: null })).toBeNull();
    expect(effectiveRights({ type: "video", hasAudio: false, audioRights: null })).toBeNull();
    expect(effectiveRights({ type: "font", hasAudio: null, audioRights: null })).toBeNull();
  });

  it("reads an unstamped audio file as the user's own (owner decision 2026-09-28: uploads are theirs)", () => {
    const r = effectiveRights({ type: "audio", hasAudio: true, audioRights: null, createdAt: new Date("2026-09-01T00:00:00Z") });
    expect(r).toEqual({ class: "owned", decidedBy: "provenance", decidedAt: "2026-09-01T00:00:00.000Z" });
  });

  it("treats a video whose audio is unknown (hasAudio null) as audio-bearing", () => {
    expect(fileCarriesAudio({ type: "video", hasAudio: null, audioRights: null })).toBe(true);
    expect(effectiveRights({ type: "video", hasAudio: null, audioRights: null })?.class).toBe("owned");
    expect(isCopyrighted({ type: "video", hasAudio: null, audioRights: null, description: "Downloaded from https://youtu.be/x" })).toBe(true);
  });

  it("returns the stored rights when they parse, and reads a stamp that does not parse as copyrighted", () => {
    expect(effectiveRights({ type: "audio", hasAudio: true, audioRights: serializeAudioRights(GENERATED) })).toEqual(GENERATED);
    expect(effectiveRights({ type: "audio", hasAudio: true, audioRights: "{not json" })?.class).toBe("copyrighted");
    expect(effectiveRights({ type: "audio", hasAudio: true, audioRights: JSON.stringify({ class: "mine" }) })?.class).toBe("copyrighted");
  });
});

/** Review finding: files made before audio rights existed carry `audioRights`
 *  null, so libi's own earlier music would read as copyrighted and be stripped
 *  from every social export. Provenance still on the row says otherwise. */
describe("effectiveRights — files made before audio rights existed", () => {
  const at = new Date("2026-08-01T00:00:00Z");
  const aiGeneration = JSON.stringify({ provider: "fal", model: "fal-ai/lyria2", prompt: "  upbeat synthwave  ", source: "tool" });

  it("reads a legacy file with generation provenance as generated, decided by provenance", () => {
    expect(effectiveRights({ type: "audio", hasAudio: true, audioRights: null, aiGeneration, description: "", createdAt: at })).toEqual({
      class: "generated", track: { title: "upbeat synthwave" }, decidedBy: "provenance", decidedAt: "2026-08-01T00:00:00.000Z",
    });
  });

  it("still reads it generated when the provenance JSON no longer parses (non-null is the signal)", () => {
    const r = effectiveRights({ type: "video", hasAudio: true, audioRights: null, aiGeneration: "{legacy", description: null, createdAt: at });
    expect(r).toEqual({ class: "generated", decidedBy: "provenance", decidedAt: "2026-08-01T00:00:00.000Z" });
  });

  it("reads a legacy ACE-Step track (description \"[Music] <prompt>\", no aiGeneration) as generated", () => {
    const r = effectiveRights({ type: "audio", hasAudio: true, audioRights: null, aiGeneration: null, description: "[Music] lofi rain on a window", createdAt: at });
    expect(r).toEqual({ class: "generated", track: { title: "lofi rain on a window" }, decidedBy: "provenance", decidedAt: "2026-08-01T00:00:00.000Z" });
  });

  it("reads a legacy yt-dlp download (\"Downloaded from <url>\") as copyrighted, its source parsed from the breadcrumb", () => {
    expect(effectiveRights({ type: "video", hasAudio: true, audioRights: null, aiGeneration: null, description: "Downloaded from https://youtu.be/x", createdAt: at })).toEqual({
      class: "copyrighted", source: { url: "https://youtu.be/x", site: "youtu.be" }, decidedBy: "provenance", decidedAt: "2026-08-01T00:00:00.000Z",
    });
  });

  it("still reads a legacy download copyrighted when its breadcrumb holds no parseable url", () => {
    expect(effectiveRights({ type: "audio", hasAudio: true, audioRights: null, aiGeneration: null, description: "Downloaded from ", createdAt: at })).toEqual({
      class: "copyrighted", decidedBy: "provenance", decidedAt: "2026-08-01T00:00:00.000Z",
    });
  });

  it("reads any other unmarked legacy file as the user's own upload", () => {
    expect(effectiveRights({ type: "audio", hasAudio: true, audioRights: null, aiGeneration: null, description: "my song [Music] ", createdAt: at })).toEqual({
      class: "owned", decidedBy: "provenance", decidedAt: "2026-08-01T00:00:00.000Z",
    });
    expect(effectiveRights({ type: "audio", hasAudio: true, audioRights: null, aiGeneration: null, description: null })?.class).toBe("owned");
    expect(effectiveRights({ type: "audio", hasAudio: true, audioRights: null, aiGeneration: null, description: "mixed; Downloaded from https://youtu.be/x" })?.class).toBe("owned");
  });

  it("a stored stamp always wins over provenance", () => {
    const stamped = { class: "copyrighted", decidedBy: "user", decidedAt: "2026-09-27T00:00:00.000Z" } as const;
    expect(effectiveRights({ type: "audio", hasAudio: true, audioRights: serializeAudioRights(stamped), aiGeneration, description: "[Music] x" })).toEqual(stamped);
  });

  it("gives no rights to a legacy generated file that carries no audio", () => {
    expect(effectiveRights({ type: "image", hasAudio: null, audioRights: null, aiGeneration, description: "" })).toBeNull();
  });
});

describe("serialize / parse", () => {
  it("round-trips and refuses unknown keys", () => {
    expect(parseAudioRights(serializeAudioRights(GENERATED))).toEqual(GENERATED);
    expect(serializeAudioRights(null)).toBeNull();
    expect(parseAudioRights(JSON.stringify({ ...GENERATED, trusted: true }))).toBeNull();
  });

  it("labels a song for sentences", () => {
    expect(songLabel({ title: "Espresso", artist: "Sabrina Carpenter" })).toBe("Espresso — Sabrina Carpenter");
    expect(songLabel({ title: "Espresso" })).toBe("Espresso");
    expect(songLabel(undefined)).toBe("an unnamed song");
  });
});

describe("files.audio_rights column", () => {
  it("stores and reads back the JSON", () => {
    const db = createTestDb();
    seedPiece(db);
    db.insert(files).values({
      id: "f1", pieceId: "test-piece-1", filename: "a.mp3", name: "a", description: "",
      type: "audio", storagePath: "test-piece-1/a.mp3", hasAudio: true,
      audioRights: serializeAudioRights(GENERATED),
    }).run();
    const row = db.select().from(files).where(eq(files.id, "f1")).get()!;
    expect(effectiveRights(row)).toEqual(GENERATED);
  });

  it("filesForManifest selects the provenance fields, so a legacy ACE-Step track reads generated on the export path", () => {
    const db = createTestDb();
    seedPiece(db);
    db.insert(files).values({
      id: "legacy", pieceId: "test-piece-1", filename: "m.wav", name: "m", description: "[Music] lofi rain",
      type: "audio", storagePath: "test-piece-1/m.wav", hasAudio: true, audioRights: null,
    }).run();
    const [row] = filesForManifest({ audioClips: [{ id: "c", kind: "standalone", fileId: "legacy", startTime: 0, duration: 3, trimStart: 0, volume: 1, enabled: true }] });
    expect(effectiveRights(row)?.class).toBe("generated");
  });
});
