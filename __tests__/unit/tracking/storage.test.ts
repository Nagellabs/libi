import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Track } from "@/lib/tracking/types";
import { normalizeTrack } from "@/lib/tracking/segments";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "libi-track-"));
  process.env.LIBI_HOME = tmp;
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
  delete process.env.LIBI_HOME;
});

describe("track storage", () => {
  it("writes and reads back a track JSON sidecar", async () => {
    const mod = await import("@/lib/tracking/storage");
    const t: Track = {
      id: "trk-1",
      fileId: "file-1",
      method: "mediapipe-face",
      framerate: 30,
      durationSec: 1,
      samples: [
        { t: 0, x: 1, y: 2, w: 3, h: 4, confidence: 0.9, visible: true },
      ],
    };
    await mod.writeTrack("piece-1", t);
    const back = await mod.readTrack("piece-1", "trk-1");
    // readTrack now normalizes on read (adds the legacy segment + derived
    // samples) — the round-trip preserves all original data in normalized form.
    expect(back).toEqual(normalizeTrack(t));
  });

  it("returns null when the track file is missing", async () => {
    const mod = await import("@/lib/tracking/storage");
    expect(await mod.readTrack("piece-x", "nope")).toBeNull();
  });

  it("deleteTrack removes the file", async () => {
    const mod = await import("@/lib/tracking/storage");
    const t: Track = {
      id: "trk-2",
      fileId: "f",
      method: "manual",
      framerate: 1,
      durationSec: 0,
      samples: [],
    };
    await mod.writeTrack("piece-1", t);
    await mod.deleteTrack("piece-1", "trk-2");
    expect(await mod.readTrack("piece-1", "trk-2")).toBeNull();
  });
});

// RC-D: the path builders normalize `..`, so an unvalidated pieceId/trackId
// would escape the storage root. Every read/write/delete must reject a
// traversal-shaped id BEFORE touching the filesystem, and never write, read
// back, or unlink anything outside <LIBI_HOME>/storage.
describe("track storage — path-traversal guard", () => {
  const EVIL_PIECE_IDS = [
    "../../../../etc",
    "..",
    "a/b",
    "a\\b",
    "/abs/path",
    "with space",
    "nul\0byte",
    // Over-long, but the traversal payload is what makes it dangerous:
    "../".repeat(60) + "etc",
  ];
  const EVIL_TRACK_IDS = [
    "../../../../etc/passwd",
    "..",
    "a/b",
    "a.json",
    "/abs/trk",
    "nul\0byte",
  ];

  it("writeTrack rejects a traversal pieceId", async () => {
    const mod = await import("@/lib/tracking/storage");
    const t: Track = {
      id: "trk-1",
      fileId: "f",
      method: "manual",
      framerate: 1,
      durationSec: 0,
      samples: [],
    };
    for (const pid of EVIL_PIECE_IDS) {
      await expect(mod.writeTrack(pid, t)).rejects.toThrow(/unsafe_piece_id/);
    }
  });

  it("writeTrack rejects a traversal trackId (via track.id)", async () => {
    const mod = await import("@/lib/tracking/storage");
    for (const tid of EVIL_TRACK_IDS) {
      const t: Track = {
        id: tid,
        fileId: "f",
        method: "manual",
        framerate: 1,
        durationSec: 0,
        samples: [],
      };
      await expect(mod.writeTrack("piece-1", t)).rejects.toThrow(/unsafe_track_id/);
    }
  });

  it("readTrack rejects traversal pieceId / trackId", async () => {
    const mod = await import("@/lib/tracking/storage");
    for (const pid of EVIL_PIECE_IDS) {
      await expect(mod.readTrack(pid, "trk-1")).rejects.toThrow(/unsafe_piece_id/);
    }
    for (const tid of EVIL_TRACK_IDS) {
      await expect(mod.readTrack("piece-1", tid)).rejects.toThrow(/unsafe_track_id/);
    }
  });

  it("deleteTrack rejects traversal pieceId / trackId", async () => {
    const mod = await import("@/lib/tracking/storage");
    for (const pid of EVIL_PIECE_IDS) {
      await expect(mod.deleteTrack(pid, "trk-1")).rejects.toThrow(/unsafe_piece_id/);
    }
    for (const tid of EVIL_TRACK_IDS) {
      await expect(mod.deleteTrack("piece-1", tid)).rejects.toThrow(/unsafe_track_id/);
    }
  });

  it("still round-trips a legitimate id (guard does not regress)", async () => {
    const mod = await import("@/lib/tracking/storage");
    const t: Track = {
      id: "trk-legit-9",
      fileId: "f",
      method: "manual",
      framerate: 1,
      durationSec: 0,
      samples: [],
    };
    await mod.writeTrack("piece-ok_1", t);
    expect(await mod.readTrack("piece-ok_1", "trk-legit-9")).not.toBeNull();
    await mod.deleteTrack("piece-ok_1", "trk-legit-9");
    expect(await mod.readTrack("piece-ok_1", "trk-legit-9")).toBeNull();
  });

  it("accepts a long but well-formed id (the guard caps the charset, not the length)", async () => {
    // Documents intended behaviour: a long all-[A-Za-z0-9_-] id is NOT a
    // traversal vector, so the guard admits it. Length is bounded by the OS
    // (ENAMETOOLONG), not this guard — no path escape is possible.
    const { isSafePieceId } = await import("@/lib/security/pieceId");
    expect(isSafePieceId("a".repeat(300))).toBe(true);
  });
});
