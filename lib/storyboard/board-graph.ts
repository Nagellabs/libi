import type { Storyboard } from "./types";

export type BoardNode = { id: string; position: { x: number; y: number }; cardId: string };
export type BoardEdge = { id: string; source: string; target: string };
export type BoardGraph = { nodes: BoardNode[]; edges: BoardEdge[] };

// COL_W must exceed the rendered node width (w-[420px] in board-view) plus a
// gutter, or auto-grid columns overlap.
const COL_W = 460;
const ROW_H = 580;
const COLS = 4;

/** Pure: cards → React-Flow-shaped nodes (positioned from persisted layout or an
 *  auto-grid by order) + a sequence edge chain following cardOrder. */
export function deriveBoardGraph(sb: Storyboard): BoardGraph {
  const byId = new Map(sb.cards.map((c) => [c.id, c]));
  const ordered = sb.cardOrder.filter((id) => byId.has(id));
  const positions = sb.layout?.positions ?? {};
  const nodes: BoardNode[] = ordered.map((id, i) => ({
    id,
    cardId: id,
    position: positions[id] ?? { x: (i % COLS) * COL_W, y: Math.floor(i / COLS) * ROW_H },
  }));
  const edges: BoardEdge[] = [];
  for (let i = 0; i < ordered.length - 1; i++) {
    edges.push({ id: `${ordered[i]}->${ordered[i + 1]}`, source: ordered[i], target: ordered[i + 1] });
  }
  return { nodes, edges };
}
