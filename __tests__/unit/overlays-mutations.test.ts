import { describe, it, expect } from "vitest";
import { addOverlay, updateOverlay, removeOverlay } from "@/lib/engine/overlays";
import type { Composition, TextOverlay } from "@/lib/engine/types";

function mkComp(overlays: TextOverlay[] = []): Composition {
  return { id: "c", name: "", width: 100, height: 100, fps: 30, overlays };
}

function mkText(overrides: Partial<TextOverlay>): TextOverlay {
  return {
    id: "o", kind: "text", content: "", font: "", color: "", align: "left", opacity: 1,
    rect: { x: 0, y: 0, width: 0, height: 0 }, startTime: 0, duration: 1, z: 0, ...overrides,
  };
}

describe("composition overlay mutations", () => {
  it("addOverlay returns a new composition with the overlay appended", () => {
    const before = mkComp();
    const after = addOverlay(before, mkText({ id: "a" }));
    expect(before.overlays).toEqual([]);
    expect(after.overlays?.map((o) => o.id)).toEqual(["a"]);
    expect(after).not.toBe(before); // new reference
  });

  it("updateOverlay patches only the target overlay", () => {
    const comp = mkComp([mkText({ id: "a", content: "x" }), mkText({ id: "b", content: "y" })]);
    const after = updateOverlay(comp, "a", { content: "X" } as Partial<TextOverlay>);
    const findText = (id: string) =>
      after.overlays?.find((o): o is TextOverlay => o.id === id && o.kind === "text");
    expect(findText("a")?.content).toBe("X");
    expect(findText("b")?.content).toBe("y");
    // Untouched overlay keeps identity.
    expect(after.overlays?.find((o) => o.id === "b")).toBe(comp.overlays?.find((o) => o.id === "b"));
  });

  it("removeOverlay drops the matching id", () => {
    const comp = mkComp([mkText({ id: "a" }), mkText({ id: "b" })]);
    const after = removeOverlay(comp, "a");
    expect(after.overlays?.map((o) => o.id)).toEqual(["b"]);
  });

  it("round-trips through JSON without loss for declarative overlays", () => {
    const comp = mkComp([mkText({ id: "a", content: "hello" })]);
    const round = JSON.parse(JSON.stringify(comp));
    expect(round).toEqual(comp);
  });
});
