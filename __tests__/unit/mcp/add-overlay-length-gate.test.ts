import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock factories are hoisted above this file's imports, so the fns they
// close over must be created via vi.hoisted rather than plain top-level
// consts (which would still be in the TDZ when the factories run).
const { loadManifest, addOverlayToManifest, dbAll } = vi.hoisted(() => ({
  loadManifest: vi.fn(),
  addOverlayToManifest: vi.fn(),
  dbAll: vi.fn(),
}));

// addOverlay needs loadManifest (the gate) + addOverlayToManifest (the write).
// loadComposition (used by loadFrame, for the rect clamp / full-frame default /
// aspect check) is a thin wrapper over loadManifest here too, so it stays
// consistent with whatever a test sets on loadManifest without touching real
// storage.
vi.mock("@/lib/composition/persistence", () => ({
  loadManifest,
  addOverlayToManifest,
  loadComposition: async (pieceId: string) => ({ manifest: await loadManifest(pieceId) }),
}));

// addOverlay hits the DB to validate the overlay's fileId (validateOverlayFileId)
// and to look up the file for the auto-inline-audio-clip / aspect-mismatch checks
// (lookupPieceFile). Both end in select().from().where().limit().all().
vi.mock("@/lib/db/client", () => ({
  getDb: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: () => ({ all: dbAll }) }) }) }),
  }),
}));

import { addOverlay } from "@/mcp/tools/overlay-tools";

// addOverlay takes ONE params object — `pieceId` is a field on it, there is no
// separate ToolContext argument.
const video = (over: Record<string, unknown> = {}) => ({
  pieceId: "p1",
  kind: "video" as const,
  fileId: "f1",
  startTime: 0,
  duration: 60,
  z: 0,
  opacity: 1,
  rect: { x: 0, y: 0, width: 100, height: 100 },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  addOverlayToManifest.mockResolvedValue(undefined);
  dbAll.mockReturnValue([{ id: "f1", pieceId: "p1", hasAudio: false }]);
});

describe("addOverlay length gate", () => {
  it("refuses a video overlay that would extend the piece", async () => {
    loadManifest.mockResolvedValue({ overlays: [{ startTime: 0, duration: 10 }] });
    const r = await addOverlay(video() as never);
    expect(r.success).toBe(false);
    expect(r.error).toBe("asset_longer_than_piece");
    expect(r.data).toMatchObject({ assetDurationSec: 60, pieceDurationSec: 10 });
    expect(addOverlayToManifest).not.toHaveBeenCalled();
  });

  it("keeps the full length with lengthPolicy 'extend'", async () => {
    loadManifest.mockResolvedValue({ overlays: [{ startTime: 0, duration: 10 }] });
    const r = await addOverlay(video({ lengthPolicy: "extend" }) as never);
    expect(r.success).toBe(true);
  });

  it("trims to the piece end with lengthPolicy 'trim'", async () => {
    loadManifest.mockResolvedValue({ overlays: [{ startTime: 0, duration: 10 }] });
    const r = await addOverlay(video({ lengthPolicy: "trim" }) as never);
    expect(r.success).toBe(true);
    expect(addOverlayToManifest.mock.calls[0][1].duration).toBe(10);
  });

  it("does not gate an overlay that fits", async () => {
    loadManifest.mockResolvedValue({ overlays: [{ startTime: 0, duration: 100 }] });
    const r = await addOverlay(video() as never);
    expect(r.success).toBe(true);
  });

  it("does not gate the FIRST overlay on an empty piece", async () => {
    loadManifest.mockResolvedValue({ overlays: [], audioClips: [] });
    const r = await addOverlay(video() as never);
    expect(r.success).toBe(true);
  });

  it("does not gate a text overlay — it has no asset length", async () => {
    loadManifest.mockResolvedValue({ overlays: [{ startTime: 0, duration: 10 }] });
    const r = await addOverlay({ pieceId: "p1", kind: "text", startTime: 0, duration: 60, z: 0, opacity: 1, rect: { x: 0, y: 0, width: 10, height: 10 }, content: "hi" } as never);
    expect(r.success).toBe(true);
  });

  it("does not gate an overlay that lands EXACTLY on the piece end", async () => {
    // startTime + duration === pieceEnd. The gate is `>`, not `>=` — an exact
    // fit is not "would exceed" and must succeed with no lengthPolicy at all.
    loadManifest.mockResolvedValue({ overlays: [{ startTime: 0, duration: 60 }] });
    const r = await addOverlay(video() as never);
    expect(r.success).toBe(true);
    expect(addOverlayToManifest.mock.calls[0][1].duration).toBe(60);
  });

  it("lengthPolicy 'trim' on an overlay that already fits leaves duration unchanged", async () => {
    // Regression test for the "trim can stretch" bug: the piece is longer
    // than the overlay being added, so trim must be a no-op, never a stretch
    // up to pieceEnd.
    loadManifest.mockResolvedValue({ overlays: [{ startTime: 0, duration: 100 }] });
    const r = await addOverlay(video({ lengthPolicy: "trim" }) as never);
    expect(r.success).toBe(true);
    expect(addOverlayToManifest.mock.calls[0][1].duration).toBe(60);
  });

  it("lengthPolicy 'trim' clamps to 0, never negative, when startTime is past the piece end", async () => {
    loadManifest.mockResolvedValue({ overlays: [{ startTime: 0, duration: 100 }] });
    const r = await addOverlay(video({ startTime: 150, lengthPolicy: "trim" }) as never);
    expect(r.success).toBe(true);
    expect(addOverlayToManifest.mock.calls[0][1].duration).toBe(0);
  });
});
