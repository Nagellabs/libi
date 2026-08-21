// __tests__/integration/storyboard/place-overlay.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { createTempStorageDir, cleanupTempDir } from "@/__tests__/helpers/test-storage";
import { saveStoryboard, loadCard, saveCard } from "@/lib/storyboard/repo";
import { placeCardOverlay } from "@/lib/storyboard/place-overlay";
import { loadManifest, saveManifest } from "@/lib/composition/persistence";
import type { Storyboard } from "@/lib/storyboard/types";
import type { PersistedOverlay, PersistedAudioClip } from "@/lib/composition/persistence";

afterEach(() => cleanupTempDir());

function sb(): Storyboard {
  return {
    version: 2, cardOrder: ["c1", "c2"], updatedAt: "t",
    cards: [
      { id: "c1", order: 0, durationSec: 6, role: "hook", kind: "canvas", title: "Hook",
        sketches: [{ id: "sk_1", role: "start", paramKey: "start_frame", render: { kind: "satori", file: "sketches/sk_1/unit.jsx" } }],
        camera: { shot: "medium" },
        promptFragment: "x", stage: "clip", approvals: {}, clipFileId: "file-c1" },
      { id: "c2", order: 1, durationSec: 4, role: "demo", kind: "canvas", title: "Demo",
        sketches: [{ id: "sk_1", role: "start", paramKey: "start_frame", render: { kind: "satori", file: "sketches/sk_1/unit.jsx" } }],
        camera: { shot: "medium" },
        promptFragment: "x", stage: "clip", approvals: {}, clipFileId: "file-c2" },
    ],
  };
}

/** Place every card of the fixture storyboard, in cardOrder. */
async function placeAll(pieceId: string, cardIds = ["c1", "c2"]) {
  for (const id of cardIds) {
    await placeCardOverlay(pieceId, (await loadCard(pieceId, id))!);
  }
}

describe("placeCardOverlay", () => {
  it("upserts a full-frame VIDEO OVERLAY keyed sb-<cardId>", async () => {
    createTempStorageDir();
    await saveStoryboard("p1", sb());
    const overlayId = await placeCardOverlay("p1", (await loadCard("p1", "c1"))!);
    expect(overlayId).toBe("sb-c1");
    const m = await loadManifest("p1");

    // Exactly ONE layer, and it is the card's video overlay.
    expect(m.overlays ?? []).toHaveLength(1);

    const o = (m.overlays ?? []).find((x) => x.id === "sb-c1") as PersistedOverlay & { fileId: string };
    expect(o).toBeDefined();
    expect(o.kind).toBe("video");
    expect(o.fileId).toBe("file-c1");
    expect(o.duration).toBe(6);
    expect(o.startTime).toBe(0);
    expect(o.rect).toEqual({ x: 0, y: 0, width: m.width, height: m.height });
  });

  it("packs storyboard overlays back-to-back in cardOrder regardless of placement order", async () => {
    createTempStorageDir();
    await saveStoryboard("p1", sb());
    // place c2 first, then c1
    await placeAll("p1", ["c2", "c1"]);
    const m = await loadManifest("p1");
    const byId = Object.fromEntries((m.overlays ?? []).map((o) => [o.id, o]));
    expect(byId["sb-c1"].startTime).toBe(0);
    expect(byId["sb-c2"].startTime).toBe(6);
    // z follows card order too
    expect(byId["sb-c1"].z).toBeLessThan(byId["sb-c2"].z);
  });

  it("re-flows later cards when an earlier card gets longer", async () => {
    createTempStorageDir();
    await saveStoryboard("p1", sb());
    await placeAll("p1");
    expect((await loadManifest("p1")).overlays!.find((o) => o.id === "sb-c2")!.startTime).toBe(6);

    // Lengthen c1 and re-place ONLY c1 — c2 must be pushed.
    const c1 = (await loadCard("p1", "c1"))!;
    c1.durationSec = 10;
    await saveCard("p1", c1);
    await placeCardOverlay("p1", c1);

    const m = await loadManifest("p1");
    const byId = Object.fromEntries((m.overlays ?? []).map((o) => [o.id, o]));
    expect(byId["sb-c1"].startTime).toBe(0);
    expect(byId["sb-c1"].duration).toBe(10);
    expect(byId["sb-c2"].startTime).toBe(10);
  });

  it("keeps each placed overlay's inline audio in lock-step with its re-flow", async () => {
    createTempStorageDir();
    await saveStoryboard("p1", sb());
    await placeAll("p1");

    // Attach an inline audio clip to each placed overlay (mirrors what video
    // import does when the source file carries an audio stream).
    const m0 = await loadManifest("p1");
    m0.audioClips = (m0.overlays ?? []).map((o, i): PersistedAudioClip => ({
      id: `a${i}`,
      kind: "inline",
      fileId: `file-${o.id}`,
      startTime: o.startTime,
      duration: o.duration,
      trimStart: 0,
      volume: 1,
      enabled: true,
      linkedOverlayId: o.id,
    }));
    await saveManifest("p1", m0);

    const c1 = (await loadCard("p1", "c1"))!;
    c1.durationSec = 9;
    await saveCard("p1", c1);
    await placeCardOverlay("p1", c1);

    const m = await loadManifest("p1");
    expect(m.overlays!.find((o) => o.id === "sb-c2")!.startTime).toBe(9);
    for (const o of m.overlays ?? []) {
      const clip = (m.audioClips ?? []).find((c) => c.linkedOverlayId === o.id);
      expect(clip).toBeDefined();
      expect(clip!.startTime).toBe(o.startTime);
    }
  });

  it("does not disturb a non-storyboard overlay, and keeps it above the storyboard's", async () => {
    createTempStorageDir();
    await saveStoryboard("p1", sb());
    const m0 = await loadManifest("p1");
    m0.overlays = [
      {
        id: "user-text", kind: "text", startTime: 2.5, duration: 3,
        rect: { x: 10, y: 10, width: 100, height: 50 }, z: 0, opacity: 1,
        content: "hi", font: "48px sans-serif", color: "#fff", align: "center",
      },
    ];
    await saveManifest("p1", m0);

    await placeAll("p1");

    const m = await loadManifest("p1");
    const user = m.overlays!.find((o) => o.id === "user-text")!;
    // Position untouched…
    expect(user.startTime).toBe(2.5);
    expect(user.rect).toEqual({ x: 10, y: 10, width: 100, height: 50 });
    // …and it still stacks above every storyboard overlay.
    const sbZ = m.overlays!.filter((o) => o.id.startsWith("sb-")).map((o) => o.z);
    expect(Math.min(...sbZ.map((z) => user.z - z))).toBeGreaterThan(0);
  });

  it("preserves the RELATIVE stacking of user overlays whose z inverts their array order", async () => {
    createTempStorageDir();
    await saveStoryboard("p1", sb());
    const m0 = await loadManifest("p1");
    const userOverlay = (id: string, z: number): PersistedOverlay => ({
      id, kind: "text", startTime: 0, duration: 3,
      rect: { x: 0, y: 0, width: 100, height: 50 }, z, opacity: 1,
      content: id, font: "48px sans-serif", color: "#fff", align: "center",
    });
    // Array order [A, B]; the user then reordered so A stacks ABOVE B.
    // `reorderOverlaysInManifest` rewrites z only — the array stays as-is.
    m0.overlays = [userOverlay("user-a", 5), userOverlay("user-b", 3)];
    await saveManifest("p1", m0);

    await placeAll("p1");

    const m = await loadManifest("p1");
    const a = m.overlays!.find((o) => o.id === "user-a")!;
    const b = m.overlays!.find((o) => o.id === "user-b")!;
    expect(a.z).toBeGreaterThan(b.z);
    // …and both still sit above every storyboard overlay.
    const sbMaxZ = Math.max(...m.overlays!.filter((o) => o.id.startsWith("sb-")).map((o) => o.z));
    expect(Math.min(a.z, b.z)).toBeGreaterThan(sbMaxZ);
  });

  it("keeps an overlay orphaned by a deleted card BELOW the user's overlays", async () => {
    createTempStorageDir();
    await saveStoryboard("p1", sb());
    await placeAll("p1");

    // The user adds an overlay, then card c2 is deleted from the storyboard —
    // `sb-c2` is left behind on the timeline with no owning card.
    const m0 = await loadManifest("p1");
    // Deliberately FIRST in the array: array order alone would rank the orphan
    // above it, which is the promotion bug this guards.
    m0.overlays = [
      {
        id: "user-text", kind: "text", startTime: 0, duration: 3,
        rect: { x: 0, y: 0, width: 100, height: 50 }, z: 99, opacity: 1,
        content: "hi", font: "48px sans-serif", color: "#fff", align: "center",
      },
      ...(m0.overlays ?? []),
    ];
    await saveManifest("p1", m0);
    const board = sb();
    board.cardOrder = ["c1"];
    board.cards = board.cards.filter((c) => c.id === "c1");
    await saveStoryboard("p1", board);

    await placeCardOverlay("p1", (await loadCard("p1", "c1"))!);

    const m = await loadManifest("p1");
    const byId = Object.fromEntries((m.overlays ?? []).map((o) => [o.id, o]));
    // Orphan stays above the live storyboard overlay but below the user's.
    expect(byId["sb-c2"].z).toBeGreaterThan(byId["sb-c1"].z);
    expect(byId["user-text"].z).toBeGreaterThan(byId["sb-c2"].z);
  });

  it("drops a stale trim when the card's selected take swaps to another file", async () => {
    createTempStorageDir();
    await saveStoryboard("p1", sb());
    const c1 = (await loadCard("p1", "c1"))!;
    c1.clips = [
      { id: "t1", fileId: "take-1", label: "v1", createdAt: 1 },
      { id: "t2", fileId: "take-2", label: "v2", createdAt: 2 },
    ];
    c1.selectedClipId = "t1";
    await saveCard("p1", c1);
    await placeCardOverlay("p1", c1);

    // A trim set against take-1 — meaningless on a different file of a
    // different length.
    const m0 = await loadManifest("p1");
    const i = m0.overlays!.findIndex((o) => o.id === "sb-c1");
    m0.overlays![i] = { ...m0.overlays![i], trim: { start: 1, end: 4 } } as PersistedOverlay;
    await saveManifest("p1", m0);

    c1.selectedClipId = "t2";
    await saveCard("p1", c1);
    await placeCardOverlay("p1", c1);

    const m = await loadManifest("p1");
    const o = m.overlays!.find((x) => x.id === "sb-c1") as PersistedOverlay & {
      fileId: string;
      trim?: { start: number; end: number };
    };
    expect(o.fileId).toBe("take-2");
    expect(o.trim).toBeUndefined();
  });

  it("is idempotent (re-placing updates in place, no duplicate)", async () => {
    createTempStorageDir();
    await saveStoryboard("p1", sb());
    const c1 = (await loadCard("p1", "c1"))!;
    await placeCardOverlay("p1", c1);
    await placeCardOverlay("p1", c1);
    const m = await loadManifest("p1");
    expect((m.overlays ?? []).filter((o) => o.id === "sb-c1")).toHaveLength(1);
  });

  it("prefers the selected visible take over the legacy clipFileId", async () => {
    createTempStorageDir();
    await saveStoryboard("p1", sb());
    const c1 = (await loadCard("p1", "c1"))!;
    c1.clips = [
      { id: "t1", fileId: "take-1", label: "v1", createdAt: 1 },
      { id: "t2", fileId: "take-2", label: "v2", createdAt: 2 },
    ];
    c1.selectedClipId = "t2";
    await saveCard("p1", c1);
    await placeCardOverlay("p1", c1);
    const m = await loadManifest("p1");
    const o = m.overlays!.find((x) => x.id === "sb-c1") as PersistedOverlay & { fileId: string };
    expect(o.fileId).toBe("take-2");
  });

  it("returns null/no-op when the card has no clip", async () => {
    createTempStorageDir();
    await saveStoryboard("p1", sb());
    const c = (await loadCard("p1", "c1"))!;
    c.clipFileId = undefined;
    c.clips = undefined;
    c.selectedClipId = undefined;
    await saveCard("p1", c);
    expect(await placeCardOverlay("p1", c)).toBeNull();
    const m = await loadManifest("p1");
    expect(m.overlays ?? []).toHaveLength(0);
  });
});
