// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, act } from "@testing-library/react";
import type { Storyboard } from "@/lib/storyboard/types";

/**
 * Review of e40b9d0f (MINOR 3): after a failed Board drag the mutation's
 * invalidation refetches IDENTICAL data, React Query's structural sharing
 * hands back the same storyboard object, `rfNodes` doesn't recompute, and the
 * dragged node stays at the position that was never saved. The drag's own
 * onError must put the nodes back to the saved layout.
 *
 * React Flow is replaced by a prop-capturing stub (it needs a real layout
 * engine); useNodesState/useEdgesState keep React Flow's contract.
 */
type Pos = { x: number; y: number };
type N = { id: string; position: Pos };
const flow = vi.hoisted(() => ({
  props: null as null | {
    nodes: N[];
    onNodesChange: (c: Array<{ type: "position"; id: string; position: Pos }>) => void;
    onNodeDragStop: () => void;
  },
}));
const mutate = vi.hoisted(() => vi.fn());

vi.mock("@xyflow/react", async () => {
  const R = await import("react");
  const useState = <T,>(init: T[]) => {
    const [s, set] = R.useState(init);
    const onChange = (changes: Array<{ type: string; id: string; position?: Pos }>) =>
      set((cur) =>
        cur.map((n) => {
          const c = changes.find((x) => x.id === (n as unknown as N).id && x.type === "position" && x.position);
          return c ? { ...n, position: c.position } : n;
        }),
      );
    return [s, set, onChange] as const;
  };
  const Passthrough = ({ children }: { children?: React.ReactNode }) => R.createElement(R.Fragment, null, children);
  return {
    ReactFlow: (p: typeof flow.props & { children?: React.ReactNode }) => {
      flow.props = p;
      return R.createElement(R.Fragment, null, p?.children);
    },
    Background: () => null,
    Controls: Passthrough,
    ControlButton: Passthrough,
    MiniMap: () => null,
    Handle: () => null,
    Position: { Left: "left", Right: "right" },
    useNodesState: useState,
    useEdgesState: useState,
  };
});
vi.mock("@xyflow/react/dist/style.css", () => ({}));
vi.mock("@/lib/queries/storyboard", () => ({ useUpdateLayout: () => ({ mutate }) }));
vi.mock("@/components/storyboard/storyboard-card", () => ({ StoryboardCard: () => null }));

const { BoardView } = await import("@/components/storyboard/board-view");

// Stable across renders, as the real caller's query data is — a fresh `{}`
// each render re-derives the nodes every render.
const SCHEMAS = {};
const SKETCH_REVS = {};

const storyboard = {
  version: 2, cardOrder: ["a"], updatedAt: "t",
  layout: { positions: { a: { x: 10, y: 20 } } },
  cards: [{
    id: "a", order: 0, durationSec: 6, role: "r", kind: "canvas", title: "A", sketches: [],
    camera: { shot: "medium" }, promptFragment: "x", stage: "schematic", approvals: {},
  }],
} as unknown as Storyboard;

describe("BoardView — a drag whose save fails", () => {
  it("puts the node back at its saved position", () => {
    render(React.createElement(BoardView, { pieceId: "p1", storyboard, schemas: SCHEMAS, sketchRevs: SKETCH_REVS }));
    act(() => flow.props!.onNodesChange([{ type: "position", id: "a", position: { x: 500, y: 600 } }]));
    expect(flow.props!.nodes[0].position).toEqual({ x: 500, y: 600 });

    act(() => flow.props!.onNodeDragStop());
    expect(mutate).toHaveBeenCalledTimes(1);
    const [vars, opts] = mutate.mock.calls[0];
    expect(vars).toEqual({ positions: { a: { x: 500, y: 600 } } });

    // The save fails (409 busy). Same storyboard prop — nothing re-derives.
    act(() => opts?.onError?.(new Error("Storyboard is busy")));
    expect(flow.props!.nodes[0].position).toEqual({ x: 10, y: 20 });
  });

  // Re-review (MINOR 2): the 409 can land up to 60 s after the drag. If an SSE
  // refetch added a card meanwhile, restoring the nodes captured at drag END
  // would hide it. The reset must read the CURRENT saved nodes.
  it("restores the saved layout as it is when the error arrives, not at drag end", () => {
    mutate.mockClear();
    const { rerender } = render(React.createElement(BoardView, { pieceId: "p1", storyboard, schemas: SCHEMAS, sketchRevs: SKETCH_REVS }));
    act(() => flow.props!.onNodesChange([{ type: "position", id: "a", position: { x: 500, y: 600 } }]));
    act(() => flow.props!.onNodeDragStop());
    const [, opts] = mutate.mock.calls[0];

    const withB = {
      ...storyboard,
      cardOrder: ["a", "b"],
      layout: { positions: { a: { x: 10, y: 20 }, b: { x: 300, y: 20 } } },
      cards: [...storyboard.cards, { ...storyboard.cards[0], id: "b", order: 1, title: "B" }],
    } as unknown as Storyboard;
    rerender(React.createElement(BoardView, { pieceId: "p1", storyboard: withB, schemas: SCHEMAS, sketchRevs: SKETCH_REVS }));
    expect(flow.props!.nodes.map((n) => n.id)).toEqual(["a", "b"]);

    act(() => opts?.onError?.(new Error("Storyboard is busy")));
    expect(flow.props!.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(flow.props!.nodes[0].position).toEqual({ x: 10, y: 20 });
  });
});

