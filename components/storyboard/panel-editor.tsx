"use client";

import { useState, useRef, useCallback } from "react";
import dynamic from "next/dynamic";
import { XIcon, InfoIcon } from "lucide-react";
import type { StoryboardCard, Block } from "@/lib/storyboard/types";
import { toPixelRect, toNormalizedRect } from "@/lib/storyboard/block-geometry";
import { useUpdateCard } from "@/lib/queries/storyboard";

// react-konva uses browser-only Canvas APIs — must be dynamically imported with ssr: false.
const KonvaEditor = dynamic(() => import("./panel-editor-konva"), { ssr: false });

interface PanelEditorProps {
  pieceId: string;
  card: StoryboardCard;
  onClose: () => void;
}

export function PanelEditor({ pieceId, card, onClose }: PanelEditorProps) {
  const [blocks, setBlocks] = useState<Block[]>(card.blocks ?? []);
  const updateCard = useUpdateCard(pieceId);
  const startSlot = card.sketches.find((s) => s.role === "start") ?? card.sketches[0];
  const isCustomUnit = (startSlot?.render?.kind ?? "satori") !== "satori";

  const handleSave = useCallback(() => {
    updateCard.mutate({ cardId: card.id, patch: { blocks } }, { onSuccess: onClose });
  }, [blocks, card.id, updateCard, onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="relative flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-2xl w-[360px]">
        {/* Header */}
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-foreground">
            Edit blocks — {card.title}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            aria-label="Close editor"
          >
            <XIcon className="size-4" />
          </button>
        </div>

        {isCustomUnit && (
          <div className="flex items-start gap-1.5 rounded-md bg-amber-500/10 border border-amber-500/20 px-2.5 py-2 text-[11px] text-amber-400">
            <InfoIcon className="size-3.5 mt-0.5 shrink-0" />
            <span>
              This card uses a custom {startSlot?.render?.kind ?? "satori"} unit. Blocks are
              code-edited and may be ignored by the render unit.
            </span>
          </div>
        )}

        {/* Konva stage (SSR-safe dynamic) */}
        <KonvaEditor blocks={blocks} onBlocksChange={setBlocks} />

        {blocks.length === 0 && (
          <p className="text-center text-xs text-muted-foreground py-2">
            No blocks defined for this card.
          </p>
        )}

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={updateCard.isPending}
            className="cursor-pointer rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {updateCard.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
