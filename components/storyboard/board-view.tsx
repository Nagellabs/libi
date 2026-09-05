"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  ControlButton,
  MiniMap,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Maximize, LayoutGrid } from "lucide-react";
import { deriveBoardGraph } from "@/lib/storyboard/board-graph";
import { gridLayout } from "@/lib/storyboard/board-layout";
import { useUpdateLayout, type SchemasMap } from "@/lib/queries/storyboard";
import { StoryboardBoardSkeleton } from "@/components/skeletons/storyboard-skeleton";
import { cn } from "@/lib/utils";
import { StoryboardCard } from "./storyboard-card";
import type { Storyboard, StoryboardCard as Card } from "@/lib/storyboard/types";

// ---------------------------------------------------------------------------
// Custom node data type
// ---------------------------------------------------------------------------

type StoryboardNodeData = { card: Card; pieceId: string; schemas: SchemasMap; sketchRevs: Record<string, Record<string, string>>; orderByCardId: Record<string, number> } & Record<string, unknown>;
type StoryboardNodeType = Node<StoryboardNodeData, "storyboardCard">;

// ---------------------------------------------------------------------------
// StoryboardNode — wraps StoryboardCard with React Flow handles
// ---------------------------------------------------------------------------

function StoryboardNode({ data }: NodeProps<StoryboardNodeType>) {
  const { card, pieceId, schemas, sketchRevs, orderByCardId } = data;
  return (
    <div className="w-[420px]">
      <Handle type="target" position={Position.Left} />
      <StoryboardCard pieceId={pieceId} card={card} index={card.order} schemas={schemas} sketchRevs={sketchRevs[card.id]} orderByCardId={orderByCardId} />
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { storyboardCard: StoryboardNode };

// ---------------------------------------------------------------------------
// BoardView
// ---------------------------------------------------------------------------

interface BoardViewProps {
  pieceId: string;
  storyboard: Storyboard;
  schemas: SchemasMap;
  sketchRevs?: Record<string, Record<string, string>>;
}

export function BoardView({ pieceId, storyboard, schemas, sketchRevs = {} }: BoardViewProps) {
  const updateLayout = useUpdateLayout(pieceId);

  const { nodes: initialNodes, edges: initialEdges } = useMemo(
    () => deriveBoardGraph(storyboard),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [storyboard],
  );

  const rfNodes: StoryboardNodeType[] = useMemo(
    () => {
      const orderByCardId = Object.fromEntries(storyboard.cards.map((c) => [c.id, c.order]));
      return initialNodes.map((n) => {
        const card = storyboard.cards.find((c) => c.id === n.cardId)!;
        return {
          id: n.id,
          position: n.position,
          type: "storyboardCard" as const,
          data: { card, pieceId, schemas, sketchRevs, orderByCardId },
        };
      });
    },
    [initialNodes, storyboard.cards, pieceId, schemas, sketchRevs],
  );

  const rfEdges: Edge[] = useMemo(
    () =>
      initialEdges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
      })),
    [initialEdges],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<StoryboardNodeType>(rfNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(rfEdges);

  // Re-sync from props when the storyboard changes (SSE refetch: cards added /
  // removed / stage changed). Drag positions still persist because rfNodes is
  // derived from the persisted `layout` stored in the manifest.
  useEffect(() => { setNodes(rfNodes); }, [rfNodes, setNodes]);
  useEffect(() => { setEdges(rfEdges); }, [rfEdges, setEdges]);

  const onNodeDragStop = useCallback(() => {
    // Read the current node state (updated by onNodesChange during the drag)
    // rather than relying on a callback arg shape that varies across versions.
    const positions: Record<string, { x: number; y: number }> = {};
    for (const n of nodes) {
      positions[n.id] = { x: n.position.x, y: n.position.y };
    }
    updateLayout.mutate({ positions });
  }, [nodes, updateLayout]);

  // Captured on init so the toolbar buttons can drive viewport actions.
  const rfRef = useRef<ReactFlowInstance<StoryboardNodeType, Edge> | null>(null);

  // The board is hidden behind a skeleton until the initial fit-to-view settles,
  // so the user never sees the cards jump from their raw positions into the
  // centered viewport (the mount glitch). Flipped true from onInit's rAF; a
  // fallback timer guarantees the board reveals even if onInit never fires.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setReady(true), 1200);
    return () => clearTimeout(t);
  }, []);

  // Center / fit all cards into view.
  const onCenter = useCallback(() => {
    rfRef.current?.fitView({ padding: 0.2, duration: 400 });
  }, []);

  // Align all cards into a balanced grid by scene order, then persist + refit.
  const onAlign = useCallback(() => {
    const positions = gridLayout(
      nodes.map((n) => ({
        id: n.id,
        order: n.data.card.order,
        width: n.measured?.width ?? 420,
        height: n.measured?.height ?? 480,
      })),
    );
    setNodes((cur) =>
      cur.map((n) => (positions[n.id] ? { ...n, position: positions[n.id] } : n)),
    );
    updateLayout.mutate({ positions });
    requestAnimationFrame(() => rfRef.current?.fitView({ padding: 0.2, duration: 400 }));
  }, [nodes, setNodes, updateLayout]);

  return (
    <div className="relative h-full w-full">
      <div
        className={cn(
          "h-full w-full transition-opacity duration-200",
          ready ? "opacity-100" : "opacity-0",
        )}
      >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={onNodeDragStop}
        nodeTypes={nodeTypes}
        // colorMode="dark" themes the built-in panels (MiniMap, Controls,
        // Background) for the app's dark UI — without it the MiniMap renders a
        // hardcoded-white box that floats over the board.
        colorMode="dark"
        fitView
        fitViewOptions={{ padding: 0.2 }}
        // Allow ~40% more zoom-out range than the React Flow default (0.5 → 0.3)
        // so large boards fit comfortably on screen.
        minZoom={0.3}
        // Re-fit once the instance is ready, deferred a frame so the flex
        // container has resolved its height first. Fitting against a 0px parent
        // (the brief pre-layout state) leaves the board pinned top-left instead
        // of centered — this guarantees the nodes land centered on both axes.
        onInit={(instance) => {
          rfRef.current = instance;
          requestAnimationFrame(() => {
            instance.fitView({ padding: 0.2 });
            // Reveal one more frame later, after the fit transform has painted,
            // so the fade-in starts from the centered (not raw) layout.
            requestAnimationFrame(() => setReady(true));
          });
        }}
      >
        <Background />
        {/* Hide the built-in fit-view button — replaced by the labelled
            Center button below, sitting alongside Align. */}
        <Controls showFitView={false}>
          <ControlButton onClick={onCenter} title="Center view" aria-label="Center view">
            <Maximize />
          </ControlButton>
          <ControlButton onClick={onAlign} title="Align cards in a grid" aria-label="Align cards in a grid">
            <LayoutGrid />
          </ControlButton>
        </Controls>
        <MiniMap />
      </ReactFlow>
      </div>

      {/* Skeleton overlay — covers the board until the initial fit settles. */}
      {!ready && (
        <div className="absolute inset-0 z-10 bg-background">
          <StoryboardBoardSkeleton count={nodes.length} />
        </div>
      )}
    </div>
  );
}
