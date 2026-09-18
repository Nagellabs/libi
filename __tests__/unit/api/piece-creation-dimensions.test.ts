import { describe, it, expect, vi, beforeEach } from "vitest";

const created = { id: "p_new", name: "Untitled" };
vi.mock("@/lib/db/client", () => ({
  getDb: () => ({
    insert: () => ({ values: () => ({ returning: async () => [created] }) }),
  }),
}));

const getPieceDefaults = vi.fn(() => ({ aspectRatioId: "9:16" }));
// The real primitive's contract: true the first time a name is marked, false after.
const marked = new Set<string>();
const markAnalyticsMilestoneOnce = vi.fn((name: string) => {
  if (marked.has(name)) return false;
  marked.add(name);
  return true;
});
vi.mock("@/lib/db/settings", () => ({
  getPieceDefaults: () => getPieceDefaults(),
  markAnalyticsMilestoneOnce: (name: string) => markAnalyticsMilestoneOnce(name),
}));

const saveManifest = vi.fn(async () => {});
const saveCurrentSnapshot = vi.fn(async () => {});
vi.mock("@/lib/composition/persistence", async (orig) => {
  const actual = await orig<typeof import("@/lib/composition/persistence")>();
  return { ...actual, saveManifest: (id: string, m: unknown) => saveManifest(id, m) };
});
vi.mock("@/lib/composition/snapshots", () => ({
  saveCurrentSnapshot: (id: string, m: unknown) => saveCurrentSnapshot(id, m),
}));

vi.mock("@/lib/navigation-events", () => ({ navigationEmitter: { emit: vi.fn() } }));
const trackServerEvent = vi.fn<(name: string, params?: Record<string, unknown>) => void>();
vi.mock("@/lib/analytics/server", () => ({
  trackServerEvent: (name: string, params?: Record<string, unknown>) => trackServerEvent(name, params),
}));

import { POST } from "@/app/api/pieces/route";

beforeEach(() => {
  saveManifest.mockClear();
  saveCurrentSnapshot.mockClear();
  trackServerEvent.mockClear();
  marked.clear();
  markAnalyticsMilestoneOnce.mockClear();
  getPieceDefaults.mockReturnValue({ aspectRatioId: "9:16" });
});

describe("POST /api/pieces", () => {
  it("writes a manifest at the user's default ratio", async () => {
    await POST();
    expect(saveManifest).toHaveBeenCalledWith(
      "p_new",
      expect.objectContaining({ width: 1080, height: 1920 }),
    );
  });

  it("honours a landscape default", async () => {
    getPieceDefaults.mockReturnValue({ aspectRatioId: "16:9" });
    await POST();
    expect(saveManifest).toHaveBeenCalledWith(
      "p_new",
      expect.objectContaining({ width: 1920, height: 1080 }),
    );
  });

  it("counts every creation as piece_created but only the install's first as first_piece_created", async () => {
    await POST();
    await POST();
    expect(trackServerEvent.mock.calls.filter(([n]) => n === "piece_created")).toEqual([
      ["piece_created", { source: "ui" }],
      ["piece_created", { source: "ui" }],
    ]);
    expect(trackServerEvent.mock.calls.filter(([n]) => n === "first_piece_created")).toEqual([["first_piece_created", undefined]]);
    expect(markAnalyticsMilestoneOnce).toHaveBeenCalledWith("first_piece");
  });

  it("a milestone write that throws never fails the creation — the row is already committed", async () => {
    markAnalyticsMilestoneOnce.mockImplementationOnce(() => {
      throw new Error("settings table locked");
    });
    const res = await POST();
    expect(res.status).toBe(201);
    expect(trackServerEvent).not.toHaveBeenCalledWith("first_piece_created", undefined);
  });

  it("writes the snapshot too, so the two-state invariant holds from birth", async () => {
    // saveManifest does not touch snapshots. loadManifest would repair this on
    // first read, but depending on a legacy repair path for a brand-new piece
    // is not a contract worth having.
    await POST();
    expect(saveCurrentSnapshot).toHaveBeenCalledWith(
      "p_new",
      expect.objectContaining({ width: 1080, height: 1920 }),
    );
  });

  it("still returns 201 with the piece", async () => {
    const res = await POST();
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id: "p_new" });
  });

  it("still creates the piece when the default id is unusable", async () => {
    // A corrupt setting must not block piece creation — fall back, don't fail.
    getPieceDefaults.mockReturnValue({ aspectRatioId: "bogus" });
    const res = await POST();
    expect(res.status).toBe(201);
    expect(saveManifest).toHaveBeenCalledWith(
      "p_new",
      expect.objectContaining({ width: 1080, height: 1920 }),
    );
  });

  it("still returns 201 with the piece when saveManifest rejects", async () => {
    // The piece row is already committed by this point — a storage blip on
    // the manifest write must not turn into a failed creation / phantom row.
    saveManifest.mockRejectedValueOnce(new Error("storage unavailable"));
    const res = await POST();
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id: "p_new" });
  });

  it("still returns 201 with the piece when saveCurrentSnapshot rejects", async () => {
    saveCurrentSnapshot.mockRejectedValueOnce(new Error("storage unavailable"));
    const res = await POST();
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id: "p_new" });
  });
});
