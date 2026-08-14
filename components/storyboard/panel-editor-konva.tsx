"use client";

/**
 * Konva-backed block editor — browser-only, loaded via next/dynamic ssr:false.
 * Renders each block as a draggable + resizable <Rect> with a <Text> label.
 * On drag/transform end, converts pixel coords back to normalized (0..1).
 */

import { useRef, useState, useCallback } from "react";
import { Stage, Layer, Rect, Text, Transformer } from "react-konva";
import type Konva from "konva";
import type { Block } from "@/lib/storyboard/types";
import { toPixelRect, toNormalizedRect } from "@/lib/storyboard/block-geometry";

const STAGE_W = 300;
const STAGE_H = 533; // ≈ 9:16

/** Color per block kind */
function kindColor(kind: Block["kind"]): string {
  switch (kind) {
    case "subject": return "rgba(99,102,241,0.45)";   // indigo
    case "prop":    return "rgba(234,179,8,0.45)";    // amber
    case "text":    return "rgba(34,197,94,0.45)";    // green
    case "inset":   return "rgba(239,68,68,0.45)";    // red
    case "bg":      return "rgba(148,163,184,0.35)";  // slate
    default:        return "rgba(99,102,241,0.35)";
  }
}

function kindStroke(kind: Block["kind"]): string {
  switch (kind) {
    case "subject": return "rgba(99,102,241,0.8)";
    case "prop":    return "rgba(234,179,8,0.8)";
    case "text":    return "rgba(34,197,94,0.8)";
    case "inset":   return "rgba(239,68,68,0.8)";
    case "bg":      return "rgba(148,163,184,0.6)";
    default:        return "rgba(99,102,241,0.8)";
  }
}

interface Props {
  blocks: Block[];
  onBlocksChange: (blocks: Block[]) => void;
}

export default function KonvaEditor({ blocks, onBlocksChange }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Map blockId → Konva.Rect ref
  const shapeRefs = useRef<Map<string, Konva.Rect>>(new Map());
  const transformerRef = useRef<Konva.Transformer>(null);

  // Attach transformer to the selected rect whenever selection changes
  const attachTransformer = useCallback(
    (id: string | null) => {
      const tr = transformerRef.current;
      if (!tr) return;
      if (!id) {
        tr.nodes([]);
        tr.getLayer()?.batchDraw();
        return;
      }
      const shape = shapeRefs.current.get(id);
      if (shape) {
        tr.nodes([shape]);
        tr.getLayer()?.batchDraw();
      }
    },
    [],
  );

  const handleSelect = useCallback(
    (id: string) => {
      setSelectedId(id);
      attachTransformer(id);
    },
    [attachTransformer],
  );

  const handleStageClick = useCallback(
    (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
      if (e.target === e.target.getStage()) {
        setSelectedId(null);
        attachTransformer(null);
      }
    },
    [attachTransformer],
  );

  /** Convert the Konva node's current pixel position/size back to a normalized rect
   *  and patch the block in local state. */
  const commitBlock = useCallback(
    (blockId: string, node: Konva.Rect) => {
      const scaleX = node.scaleX();
      const scaleY = node.scaleY();
      const pixelRect = {
        x: node.x(),
        y: node.y(),
        w: node.width() * scaleX,
        h: node.height() * scaleY,
      };
      // Reset scale after transform so dimensions are in absolute pixels.
      node.scaleX(1);
      node.scaleY(1);
      node.width(pixelRect.w);
      node.height(pixelRect.h);

      const normalized = toNormalizedRect(pixelRect, STAGE_W, STAGE_H);
      onBlocksChange(
        blocks.map((b) => (b.id === blockId ? { ...b, rect: normalized } : b)),
      );
    },
    [blocks, onBlocksChange],
  );

  const handleAddBlock = useCallback(() => {
    const maxZ = blocks.length > 0 ? Math.max(...blocks.map((b) => b.z)) : 0;
    const newBlock: Block = {
      id: `block-${Date.now()}`,
      kind: "subject",
      label: "new",
      rect: { x: 0.35, y: 0.4, w: 0.3, h: 0.2 },
      z: maxZ + 1,
    };
    const updated = [...blocks, newBlock];
    onBlocksChange(updated);
    // Select the new block after state propagates
    setSelectedId(newBlock.id);
    // Attach transformer on next frame once the ref is registered
    setTimeout(() => attachTransformer(newBlock.id), 0);
  }, [blocks, onBlocksChange, attachTransformer]);

  const handleDeleteBlock = useCallback(() => {
    if (!selectedId) return;
    onBlocksChange(blocks.filter((b) => b.id !== selectedId));
    setSelectedId(null);
    attachTransformer(null);
  }, [selectedId, blocks, onBlocksChange, attachTransformer]);

  return (
    <div className="flex flex-col gap-2">
      {/* Toolbar */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleAddBlock}
          className="cursor-pointer rounded border border-border px-2.5 py-1 text-xs text-foreground hover:bg-muted transition-colors"
        >
          + Add block
        </button>
        <button
          type="button"
          onClick={handleDeleteBlock}
          disabled={!selectedId}
          className="cursor-pointer rounded border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Delete selected
        </button>
      </div>

      <div
        className="rounded-md overflow-hidden border border-border"
        style={{ width: STAGE_W, height: STAGE_H }}
      >
      <Stage
        width={STAGE_W}
        height={STAGE_H}
        onMouseDown={handleStageClick}
        onTouchStart={handleStageClick}
        style={{ background: "#0f0f0f" }}
      >
        <Layer>
          {/* Stage background hint — listening:false so clicks pass through
               to the Stage, letting the e.target === stage deselect check fire. */}
          <Rect
            x={0}
            y={0}
            width={STAGE_W}
            height={STAGE_H}
            fill="transparent"
            listening={false}
          />

          {/* Render blocks sorted by z */}
          {[...blocks]
            .sort((a, b) => a.z - b.z)
            .map((block) => {
              const px = toPixelRect(block.rect, STAGE_W, STAGE_H);
              const isSelected = block.id === selectedId;
              return (
                <React.Fragment key={block.id}>
                  <Rect
                    ref={(node) => {
                      if (node) shapeRefs.current.set(block.id, node);
                      else shapeRefs.current.delete(block.id);
                    }}
                    x={px.x}
                    y={px.y}
                    width={px.w}
                    height={px.h}
                    fill={kindColor(block.kind)}
                    stroke={isSelected ? "#fff" : kindStroke(block.kind)}
                    strokeWidth={isSelected ? 1.5 : 1}
                    draggable
                    onClick={() => handleSelect(block.id)}
                    onTap={() => handleSelect(block.id)}
                    onDragEnd={(e) => commitBlock(block.id, e.target as Konva.Rect)}
                    onTransformEnd={(e) => commitBlock(block.id, e.target as Konva.Rect)}
                  />
                  <Text
                    x={px.x + 4}
                    y={px.y + 4}
                    text={block.glyph ? `${block.glyph} ${block.label}` : block.label}
                    fontSize={10}
                    fill="rgba(255,255,255,0.85)"
                    listening={false}
                  />
                </React.Fragment>
              );
            })}

          {/* Single shared Transformer for selected block */}
          <Transformer
            ref={transformerRef}
            boundBoxFunc={(oldBox, newBox) => {
              // Minimum 10px in each dimension
              if (newBox.width < 10 || newBox.height < 10) return oldBox;
              return newBox;
            }}
          />
        </Layer>
      </Stage>
      </div>
    </div>
  );
}

// React Fragment import needed for JSX
import React from "react";
