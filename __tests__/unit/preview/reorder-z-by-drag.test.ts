import { describe, it, expect } from "vitest";
import { crossRowDeltaFromY, reorderZByDrag } from "@/lib/preview/track-stack-view-model";
import { overlaysActiveAt } from "@/lib/engine/overlays";
import type { Overlay } from "@/lib/engine/types";

describe("crossRowDeltaFromY (variable-height rows)", () => {
  // Three rows top→bottom (z desc): a TALL video (z2), a SHORT text (z1), a TALL
  // image (z0), each separated by a 4px gap. A constant-height divisor would
  // miscount a drag across the tall rows — this maps the pointer Y to the row
  // actually under it.
  const rows = [
    { id: "A", top: 0, bottom: 44 }, // video TALL
    { id: "B", top: 48, bottom: 74 }, // text SHORT
    { id: "C", top: 78, bottom: 122 }, // image TALL
  ];

  it("dragging the bottom row's pointer into the TOP row = delta to move it to front", () => {
    // Pointer at y=20 lands in row A (the top). C is at index 2 → delta = 2.
    expect(crossRowDeltaFromY(rows, "C", 20)).toBe(2);
  });

  it("pointer within the middle row targets that row regardless of tall neighbors", () => {
    expect(crossRowDeltaFromY(rows, "C", 60)).toBe(1); // into B → 2-1
    expect(crossRowDeltaFromY(rows, "A", 60)).toBe(-1); // A down into B → 0-1
  });

  it("clamps below all rows to the last row; same-row = 0", () => {
    expect(crossRowDeltaFromY(rows, "A", 999)).toBe(-2); // A → last
    expect(crossRowDeltaFromY(rows, "B", 60)).toBe(0); // B stays in B
  });

  it("composes with reorderZByDrag to land the dragged row where the pointer is", () => {
    // Drag C (z0, bottom) so the pointer is over the top row → it should become
    // front-most (highest z).
    const delta = crossRowDeltaFromY(rows, "C", 20); // 2
    const res = reorderZByDrag({ A: 2, B: 1, C: 0 }, "C", delta);
    expect(res).not.toBeNull();
    expect(res!.zById.C).toBe(2); // C now front-most
    // Back→front order is B, A, C.
    expect(res!.overlayIdsInZOrder).toEqual(["B", "A", "C"]);
  });

  it("returns 0 for an unknown id or a <2-row stack", () => {
    expect(crossRowDeltaFromY(rows, "Z", 20)).toBe(0);
    expect(crossRowDeltaFromY([{ id: "A", top: 0, bottom: 44 }], "A", 20)).toBe(0);
  });
});

function overlay(id: string, z: number): Overlay {
  return {
    id,
    kind: "image",
    startTime: 0,
    duration: 10,
    z,
    rect: { x: 0, y: 0, width: 10, height: 10 },
    opacity: 1,
    fileId: "f",
  } as Overlay;
}

describe("reorderZByDrag", () => {
  it("returns null for a no-op (single overlay, missing id, or clamped end)", () => {
    expect(reorderZByDrag({ a: 0 }, "a", 1)).toBeNull();
    expect(reorderZByDrag({ a: 0, b: 1 }, "missing", 1)).toBeNull();
    // 'b' is already front-most (z=1); dragging further toward front is a no-op.
    expect(reorderZByDrag({ a: 0, b: 1 }, "b", 1)).toBeNull();
    // 'a' is already back-most; dragging further toward back is a no-op.
    expect(reorderZByDrag({ a: 0, b: 1 }, "a", -1)).toBeNull();
  });

  it("dragging A (back) up above B (front) makes A.z > B.z", () => {
    // a:z0 (back), b:z1 (front). Drag a one row toward front (+1).
    const res = reorderZByDrag({ a: 0, b: 1 }, "a", 1);
    expect(res).not.toBeNull();
    expect(res!.zById.a).toBeGreaterThan(res!.zById.b);
    // Dense, back-most = 0.
    expect(res!.overlayIdsInZOrder).toEqual(["b", "a"]); // back→front
    expect(res!.zById).toEqual({ b: 0, a: 1 });
  });

  it("render order (overlaysActiveAt, ascending z) matches the new manual order", () => {
    // Start: a behind b. Drag a in front of b. Render must now draw a LAST.
    const before = [overlay("a", 0), overlay("b", 1)];
    const renderedBefore = overlaysActiveAt(before, 1).map((o) => o.id);
    expect(renderedBefore).toEqual(["a", "b"]); // ascending z: a(0) then b(1)

    const res = reorderZByDrag({ a: 0, b: 1 }, "a", 1)!;
    const after = before.map((o) => overlay(o.id, res.zById[o.id]));
    const renderedAfter = overlaysActiveAt(after, 1).map((o) => o.id);
    // a now has the higher z → drawn LAST → in FRONT.
    expect(renderedAfter).toEqual(["b", "a"]);
  });

  it("multi-overlay: moving a middle overlay two rows toward back re-densifies z", () => {
    // front→back by z desc: c(2), b(1), a(0). Drag c two toward back.
    const res = reorderZByDrag({ a: 0, b: 1, c: 2 }, "c", -2)!;
    // back→front after move: c, a, b → z c=0, a=1, b=2.
    expect(res.overlayIdsInZOrder).toEqual(["c", "a", "b"]);
    expect(res.zById).toEqual({ c: 0, a: 1, b: 2 });
  });
});
