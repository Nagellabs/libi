import { describe, it, expect } from "vitest";
import { buildLayersViewModel, groupFromRowHit, resolveZ } from "@/lib/overlays/layers-view-model";
import { buildLaneRows } from "@/lib/overlays/lanes";
import type { Overlay } from "@/lib/engine/types";

function bar(
  id: string,
  kind: Overlay["kind"],
  startTime: number,
  duration: number,
  group?: string,
  z = 0,
): Overlay {
  const base = {
    id, startTime, duration, z,
    rect: { x: 0, y: 0, width: 10, height: 10 }, opacity: 1,
    ...(group ? { group } : {}),
  };
  switch (kind) {
    case "text": return { ...base, kind, content: "", font: "", color: "", align: "left" } as Overlay;
    case "image": return { ...base, kind, fileId: "f" } as Overlay;
    case "video": return { ...base, kind, fileId: "f" } as Overlay;
    case "code": return { ...base, kind, drawFunction: "" } as Overlay;
    case "three": return { ...base, kind, sceneFunction: "" } as Overlay;
    case "tracked":
      return { ...base, kind, trackId: "t", content: { kind: "emoji", char: "x" }, fit: "tight", scale: 1, smoothing: "linear" } as Overlay;
  }
}

describe("buildLayersViewModel", () => {
  const overlays = [
    bar("cap1", "text", 0, 1),
    bar("cap2", "text", 1, 1),
    bar("stk1", "image", 0, 2),
  ];

  it("returns rows from buildLaneRows enriched with z + flags", () => {
    const vm = buildLayersViewModel(overlays, { selectedIds: new Set(["cap2"]), hidden: { stk1: true }, locked: {} });
    const captions = vm.rows.find((r) => r.group === "captions")!;
    const c2 = captions.layers.find((l) => l.id === "cap2")!;
    expect(c2.selected).toBe(true);
    expect(c2.hidden).toBe(false);
    expect(typeof c2.z).toBe("number");
    const stickers = vm.rows.find((r) => r.group === "stickers")!;
    expect(stickers.layers.find((l) => l.id === "stk1")!.hidden).toBe(true);
  });

  it("preserves explicit finite z verbatim (authoritative, not lane-derived)", () => {
    // stk1 is given a HIGHER z than the caption overlays even though it sits in
    // the alphabetically-later 'stickers' group — stored z wins.
    const withZ = [
      bar("cap1", "text", 0, 1, undefined, 5),
      bar("cap2", "text", 1, 1, undefined, 6),
      bar("stk1", "image", 0, 2, undefined, 9),
    ];
    const vm = buildLayersViewModel(withZ, { selectedIds: new Set(), hidden: {}, locked: {} });
    expect(vm.zById).toEqual({ cap1: 5, cap2: 6, stk1: 9 });
  });

  it("seeds overlays lacking finite z above the current max (front), in lane order", () => {
    // cap1 has explicit z=3; the image overlay lacks z (NaN) → must be seeded
    // strictly above 3 (rendered in front of the explicit one).
    const seedMe = [
      bar("cap1", "text", 0, 1, undefined, 3),
      bar("img1", "image", 0, 2, undefined, Number.NaN),
    ];
    const vm = buildLayersViewModel(seedMe, { selectedIds: new Set(), hidden: {}, locked: {} });
    expect(vm.zById.cap1).toBe(3);
    expect(vm.zById.img1).toBeGreaterThan(3);
  });

  it("falls back to lane-derived z when NO overlay has a finite z (front row higher)", () => {
    const rows = buildLaneRows(overlays);
    const noZ = overlays.map((o) => ({ ...o, z: Number.NaN }) as Overlay);
    const zById = resolveZ(noZ, rows);
    // captions vs stickers — stickers is the later (front) lane, higher z.
    expect(zById.stk1).toBeGreaterThan(zById.cap1);
  });

  it("locked layers are flagged", () => {
    const vm = buildLayersViewModel(overlays, { selectedIds: new Set(), hidden: {}, locked: { cap1: true } });
    const captions = vm.rows.find((r) => r.group === "captions")!;
    expect(captions.layers.find((l) => l.id === "cap1")!.locked).toBe(true);
  });
});

describe("groupFromRowHit", () => {
  it("returns the group label at a given row index, or null out of range", () => {
    const vm = buildLayersViewModel(
      [bar("a", "text", 0, 1), bar("b", "image", 0, 1)],
      { selectedIds: new Set(), hidden: {}, locked: {} },
    );
    expect(groupFromRowHit(vm, 0)).toBe("captions"); // rows sorted by group label
    expect(groupFromRowHit(vm, 1)).toBe("stickers");
    expect(groupFromRowHit(vm, 99)).toBe(null);
  });
});
