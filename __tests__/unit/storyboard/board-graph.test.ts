import { describe, it, expect } from "vitest";
import { deriveBoardGraph } from "@/lib/storyboard/board-graph";
import type { Storyboard } from "@/lib/storyboard/types";

function sb(over: Partial<Storyboard> = {}): Storyboard {
  return {
    version: 2, cardOrder: ["a", "b", "c"], updatedAt: "t",
    cards: ["a", "b", "c"].map((id, i) => ({
      id, order: i, durationSec: 6, role: "r", kind: "canvas", title: id.toUpperCase(),
      sketches: [{ id: "sk_1", role: "start" as const, paramKey: "start_frame", render: { kind: "satori" as const, file: "sketches/sk_1/unit.jsx" } }],
      camera: { shot: "medium" as const },
      promptFragment: "x", stage: "schematic" as const, approvals: {},
    })),
    ...over,
  };
}

describe("deriveBoardGraph", () => {
  it("one node per card + a sequence edge chain following cardOrder", () => {
    const g = deriveBoardGraph(sb());
    expect(g.nodes.map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(g.edges.map((e) => [e.source, e.target])).toEqual([["a", "b"], ["b", "c"]]);
  });
  it("auto-grid positions when no layout, left→right by order", () => {
    const g = deriveBoardGraph(sb());
    expect(g.nodes[0].position.x).toBeLessThan(g.nodes[1].position.x);
    expect(g.nodes[0].position.y).toBe(g.nodes[1].position.y); // same row
  });
  it("honors persisted layout positions when present", () => {
    const g = deriveBoardGraph(sb({ layout: { positions: { b: { x: 999, y: 42 } } } }));
    const b = g.nodes.find((n) => n.id === "b")!;
    expect(b.position).toEqual({ x: 999, y: 42 });
  });
});
