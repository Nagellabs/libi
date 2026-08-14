"use client";

import { useState, useEffect, useRef } from "react";
import { ChevronRight, ChevronDown, EllipsisVertical, Loader2 } from "lucide-react";
import type { PieceSummary } from "@/lib/queries/pieces";
import type { FileRecord } from "@/lib/db/schema/types";
import PieceAssets from "./piece-assets";
import { PieceMark } from "./piece-mark";
import type { SortOption } from "./sort-utils";

interface PieceNodeProps {
  piece: PieceSummary;
  isActive: boolean;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onSelectPiece: () => void;
  onSelectAsset: (file: FileRecord) => void;
  onRenamePiece?: (name: string) => void;
  onDropFiles?: (files: File[]) => void;
  onAssignFile?: (fileId: string) => void;
  onContextMenu: (e: React.MouseEvent, type: "piece" | "asset", pieceId: string | null, fileId?: string, name?: string) => void;
  renamingFileId: string | null;
  onRenameFileSubmit: (fileId: string, name: string) => void;
  onRenameFileCancel: () => void;
  triggerRename: boolean;
  onRenameTriggerHandled: () => void;
  innerSort: SortOption;
  search: string;
  /** Indentation level in the folder tree (0 = root). */
  depth?: number;
  /** True while a `piece_dup` job is filling this (copy) piece. The row shows
   *  a spinner and is non-interactive until the copy completes. */
  isCopying?: boolean;
}

export default function PieceNode({
  piece,
  isActive,
  isExpanded,
  onToggleExpand,
  onSelectPiece,
  onSelectAsset,
  onRenamePiece,
  onDropFiles,
  onAssignFile,
  onContextMenu,
  renamingFileId,
  onRenameFileSubmit,
  onRenameFileCancel,
  triggerRename,
  onRenameTriggerHandled,
  innerSort,
  search,
  depth = 0,
  isCopying = false,
}: PieceNodeProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(piece.name);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Handle external trigger to start rename (e.g., from context menu).
  // Seeding + opening happen during render (self-limiting: setting
  // isRenaming(true) falsifies the guard). Acknowledging the trigger is a
  // PARENT setState, which must stay in an effect.
  if (triggerRename && !isRenaming) {
    setRenameValue(piece.name);
    setIsRenaming(true);
  }
  useEffect(() => {
    if (triggerRename) onRenameTriggerHandled();
  }, [triggerRename, onRenameTriggerHandled]);

  useEffect(() => {
    if (isRenaming) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [isRenaming]);

  const handleRenameSubmit = () => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== piece.name && onRenamePiece) {
      onRenamePiece(trimmed);
    }
    setIsRenaming(false);
  };

  // PieceNode only handles file drops (assign an existing file, or upload OS
  // files). A piece / folder drag is NOT something PieceNode acts on — those
  // must bubble up to the enclosing folder (or root) so the move lands there.
  const isFileDrag = (e: React.DragEvent) =>
    e.dataTransfer.types.includes("Files") ||
    e.dataTransfer.types.includes("application/libi-file-id");

  const handleDragOver = (e: React.DragEvent) => {
    if (isFileDrag(e)) {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(true);
    }
    // For piece/folder drags, do nothing — let the event bubble.
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragOver(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    // Only consume the drop if it's a payload PieceNode handles. A
    // piece/folder drag must bubble to the enclosing folder/root.
    if (!isFileDrag(e)) {
      setIsDragOver(false);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const fileId = e.dataTransfer.getData("application/libi-file-id");
    if (fileId && onAssignFile) {
      onAssignFile(fileId);
      return;
    }
    if (e.dataTransfer.files.length > 0 && onDropFiles) {
      onDropFiles(Array.from(e.dataTransfer.files));
    }
  };

  return (
    <div>
      <div
        draggable={!isRenaming && !isCopying}
        onDragStart={(e) => {
          e.dataTransfer.setData("application/libi-piece-id", piece.id);
          e.dataTransfer.effectAllowed = "move";
        }}
        className={`group flex w-full items-center gap-1.5 rounded-md py-1.5 pr-1.5 text-sm transition-colors border-l-2 ${
          isCopying ? "cursor-default" : "cursor-pointer"
        } ${
          isDragOver
            ? "bg-sidebar-accent text-sidebar-accent-foreground ring-1 ring-primary/40 border-l-transparent"
            : isActive
              ? "bg-sidebar-accent text-sidebar-accent-foreground border-l-primary"
              : "text-sidebar-foreground hover:bg-sidebar-accent/60 border-l-transparent"
        }`}
        style={{ paddingLeft: `${depth * 16 + (isActive && !isDragOver ? 4 : 6)}px` }}
        onClick={() => {
          if (isCopying) return;
          onSelectPiece();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onContextMenu(e, "piece", piece.id, undefined, piece.name);
        }}
        onDragOver={isCopying ? undefined : handleDragOver}
        onDragLeave={isCopying ? undefined : handleDragLeave}
        onDrop={isCopying ? undefined : handleDrop}
      >
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpand();
          }}
          aria-label={isExpanded ? "Collapse" : "Expand"}
          className="flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
        >
          {isExpanded ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </button>
        {isCopying ? (
          <span className="grid size-[18px] shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
          </span>
        ) : (
          <span className="grid size-[18px] shrink-0 place-items-center rounded-md bg-[color:var(--accent-soft)] text-primary">
            <PieceMark className="h-[11px] w-[11px]" />
          </span>
        )}
        {isCopying ? (
          <span className="flex-1 flex items-center gap-1.5 min-w-0">
            <span className="truncate text-xs font-medium">{piece.name}</span>
            <span className="shrink-0 text-[11px] text-muted-foreground">
              Copying…
            </span>
          </span>
        ) : isRenaming ? (
          <input
            ref={renameInputRef}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={handleRenameSubmit}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleRenameSubmit();
              if (e.key === "Escape") { setIsRenaming(false); setRenameValue(piece.name); }
            }}
            onClick={(e) => e.stopPropagation()}
            className="flex-1 rounded border border-accent bg-background px-1 py-0 text-xs font-medium outline-none"
          />
        ) : (
          <span className="flex-1 flex items-center gap-0 min-w-0">
            <span className="truncate text-xs font-medium">{piece.name}</span>
            {piece.hasDraft && (
              <span
                className="ml-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
                title="Uncommitted draft changes"
              />
            )}
          </span>
        )}
        <button
          className="invisible cursor-pointer rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground group-hover:visible"
          onClick={(e) => {
            e.stopPropagation();
            onContextMenu(e, "piece", piece.id, undefined, piece.name);
          }}
        >
          <EllipsisVertical className="h-3 w-3" />
        </button>
      </div>

      {isExpanded && (
        <div
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes("Files") || e.dataTransfer.types.includes("application/libi-file-id")) {
              e.preventDefault();
              e.stopPropagation();
              setIsDragOver(true);
            }
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) {
              setIsDragOver(false);
            }
          }}
          onDrop={handleDrop}
        >
          <PieceAssets
            pieceId={piece.id}
            onSelectAsset={onSelectAsset}
            onContextMenu={onContextMenu}
            renamingFileId={renamingFileId}
            onRenameFileSubmit={onRenameFileSubmit}
            onRenameFileCancel={onRenameFileCancel}
            innerSort={innerSort}
            search={search}
          />
        </div>
      )}
    </div>
  );
}

