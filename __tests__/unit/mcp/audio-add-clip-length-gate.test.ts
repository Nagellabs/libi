import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock factories are hoisted above this file's imports, so the fns they
// close over must be created via vi.hoisted rather than plain top-level
// consts (which would still be in the TDZ when the factories run).
const { loadManifest, saveManifest, dbAll } = vi.hoisted(() => ({
  loadManifest: vi.fn(),
  saveManifest: vi.fn(),
  dbAll: vi.fn(),
}));
vi.mock("@/lib/composition/persistence", () => ({ loadManifest, saveManifest }));

vi.mock("@/lib/db/client", () => ({
  getDb: () => ({ select: () => ({ from: () => ({ where: () => ({ limit: () => ({ all: dbAll }) }) }) }) }),
}));

import { audioAddClip } from "@/mcp/tools/audio-clip-tools";

const ctx = { pieceId: "p1" };
const base = { fileId: "f1", kind: "standalone" as const, startTime: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  dbAll.mockReturnValue([{ id: "f1", pieceId: "p1", mediaDuration: 229 }]);
  saveManifest.mockResolvedValue(undefined);
});

describe("audioAddClip length gate", () => {
  it("refuses when the asset is longer than the piece and no intent was given", async () => {
    loadManifest.mockResolvedValue({ overlays: [{ startTime: 0, duration: 3 }] });
    const r = await audioAddClip(ctx, base as never);
    expect(r.success).toBe(false);
    expect(r.error).toBe("asset_longer_than_piece");
    expect(r.data).toMatchObject({ assetDurationSec: 229, pieceDurationSec: 3 });
    expect(saveManifest).not.toHaveBeenCalled();
  });

  it("adds at full length with lengthPolicy 'extend'", async () => {
    loadManifest.mockResolvedValue({ overlays: [{ startTime: 0, duration: 3 }] });
    const r = await audioAddClip(ctx, { ...base, lengthPolicy: "extend" } as never);
    expect(r.success).toBe(true);
    expect(saveManifest.mock.calls[0][1].audioClips[0].duration).toBe(229);
  });

  it("trims to the piece length with lengthPolicy 'trim'", async () => {
    loadManifest.mockResolvedValue({ overlays: [{ startTime: 0, duration: 3 }] });
    const r = await audioAddClip(ctx, { ...base, lengthPolicy: "trim" } as never);
    expect(r.success).toBe(true);
    expect(saveManifest.mock.calls[0][1].audioClips[0].duration).toBe(3);
  });

  it("honours an explicit duration without asking", async () => {
    loadManifest.mockResolvedValue({ overlays: [{ startTime: 0, duration: 3 }] });
    const r = await audioAddClip(ctx, { ...base, duration: 12 } as never);
    expect(r.success).toBe(true);
    expect(saveManifest.mock.calls[0][1].audioClips[0].duration).toBe(12);
  });

  it("does not gate an asset that fits inside the piece", async () => {
    dbAll.mockReturnValue([{ id: "f1", pieceId: "p1", mediaDuration: 2 }]);
    loadManifest.mockResolvedValue({ overlays: [{ startTime: 0, duration: 10 }] });
    const r = await audioAddClip(ctx, base as never);
    expect(r.success).toBe(true);
  });

  it("does not gate an EMPTY piece — there is no length to exceed", async () => {
    loadManifest.mockResolvedValue({ overlays: [], audioClips: [] });
    const r = await audioAddClip(ctx, base as never);
    expect(r.success).toBe(true);
    expect(saveManifest.mock.calls[0][1].audioClips[0].duration).toBe(229);
  });

  it("gates on the clip's END, not its raw length (startTime counts)", async () => {
    dbAll.mockReturnValue([{ id: "f1", pieceId: "p1", mediaDuration: 5 }]);
    loadManifest.mockResolvedValue({ overlays: [{ startTime: 0, duration: 8 }] });
    const r = await audioAddClip(ctx, { ...base, startTime: 6 } as never);
    expect(r.success).toBe(false);
    expect(r.error).toBe("asset_longer_than_piece");
  });

  it("does not gate a clip that lands EXACTLY on the piece end", async () => {
    // clip end === pieceEnd. The gate is `>`, not `>=` — an exact fit is not
    // "would extend" and must succeed with no lengthPolicy at all.
    dbAll.mockReturnValue([{ id: "f1", pieceId: "p1", mediaDuration: 3 }]);
    loadManifest.mockResolvedValue({ overlays: [{ startTime: 0, duration: 3 }] });
    const r = await audioAddClip(ctx, base as never);
    expect(r.success).toBe(true);
    expect(saveManifest.mock.calls[0][1].audioClips[0].duration).toBe(3);
  });

  it("lengthPolicy 'trim' clamps to 0, never negative, when startTime is past the piece end", async () => {
    loadManifest.mockResolvedValue({ overlays: [{ startTime: 0, duration: 3 }] });
    const r = await audioAddClip(ctx, { ...base, startTime: 10, lengthPolicy: "trim" } as never);
    expect(r.success).toBe(true);
    expect(saveManifest.mock.calls[0][1].audioClips[0].duration).toBe(0);
  });
});
