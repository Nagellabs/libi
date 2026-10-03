import { describe, it, expect, vi, beforeEach } from "vitest";

const { loadManifest, saveManifest, dbAll, requestSongMatch } = vi.hoisted(() => ({
  loadManifest: vi.fn(),
  saveManifest: vi.fn(),
  dbAll: vi.fn(),
  requestSongMatch: vi.fn(),
}));
vi.mock("@/lib/composition/persistence", () => ({ loadManifest, saveManifest }));
vi.mock("@/lib/db/client", () => ({
  getDb: () => ({ select: () => ({ from: () => ({ where: () => ({ limit: () => ({ all: dbAll }) }) }) }) }),
}));
vi.mock("@/mcp/tools/audio-rights-tools", () => ({ requestSongMatch }));

import { audioAddClip } from "@/mcp/tools/audio-clip-tools";
import { runInBatchContext } from "@/mcp/tools/batch-context";

const copyrighted = JSON.stringify({ class: "copyrighted", decidedBy: "agent", track: { title: "Song", artist: "Artist" } });

beforeEach(() => {
  vi.clearAllMocks();
  dbAll.mockReturnValue([{ id: "f1", pieceId: "p1", type: "audio", hasAudio: true, audioRights: copyrighted, mediaDuration: 60 }]);
  loadManifest.mockResolvedValue({ overlays: [], audioClips: [] });
  saveManifest.mockResolvedValue(undefined);
  requestSongMatch.mockResolvedValue({ summary: "matched" });
});

describe("audio_add_clip inside a batch", () => {
  it("outside a batch a copyrighted, never-matched file is matched against the platforms", async () => {
    const r = await audioAddClip({ pieceId: "p1" }, { fileId: "f1", kind: "standalone", startTime: 0 } as never);
    expect(r.success).toBe(true);
    expect(requestSongMatch).toHaveBeenCalledWith("f1");
    expect(r.data).toMatchObject({ music: { summary: "matched" } });
    expect(r.data).not.toHaveProperty("musicMatchSkipped");
  });

  it("inside one the clip is added and the platform call is left, and the result says so", async () => {
    const r = await runInBatchContext(() => audioAddClip({ pieceId: "p1" }, { fileId: "f1", kind: "standalone", startTime: 0 } as never));
    expect(r.success).toBe(true);
    expect(requestSongMatch).not.toHaveBeenCalled();
    expect(r.data).toMatchObject({ musicMatchSkipped: true });
    expect(saveManifest).toHaveBeenCalledTimes(1);
  });
});
