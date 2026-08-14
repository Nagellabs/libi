"use client";

import { useState, useEffect, useRef } from "react";
import { ChevronRight, ChevronDown, Folder, EllipsisVertical } from "lucide-react";
import type { FolderNode as FolderNodeData } from "@/lib/queries/folders";

interface FolderNodeProps {
  folder: FolderNodeData;
  depth: number;
  isExpanded: boolean;
  onToggleFolder: () => void;
  isRenaming: boolean;
  onRenameSubmit: (name: string) => void;
  onRenameCancel: () => void;
  onContextMenu: (e: React.MouseEvent, folderId: string, name: string) => void;
  /** A piece (application/libi-piece-id) was dropped onto this folder. */
  onDropPiece: (pieceId: string) => void;
  /** Another folder (application/libi-folder-id) was dropped onto this folder. */
  onDropFolder: (folderId: string) => void;
  /** Recursive subtree (folders + pieces) supplied by FileTree. */
  renderChildren: () => React.ReactNode;
}

export default function FolderNode({
  folder,
  depth,
  isExpanded,
  onToggleFolder,
  isRenaming,
  onRenameSubmit,
  onRenameCancel,
  onContextMenu,
  onDropPiece,
  onDropFolder,
  renderChildren,
}: FolderNodeProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [renameValue, setRenameValue] = useState(folder.name);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Seed the input on the render where renaming turns on (React's
  // previous-state pattern — re-renders before paint, no effect cascade).
  // Focus/select stay in the effect: they need the committed DOM node.
  const [prevRenaming, setPrevRenaming] = useState(isRenaming);
  if (isRenaming !== prevRenaming) {
    setPrevRenaming(isRenaming);
    if (isRenaming) setRenameValue(folder.name);
  }

  useEffect(() => {
    if (isRenaming) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [isRenaming]);

  const handleRenameSubmit = () => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== folder.name) {
      onRenameSubmit(trimmed);
    } else {
      onRenameCancel();
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (
      e.dataTransfer.types.includes("application/libi-piece-id") ||
      e.dataTransfer.types.includes("application/libi-folder-id")
    ) {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragOver(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    setIsDragOver(false);
    const pieceId = e.dataTransfer.getData("application/libi-piece-id");
    const folderId = e.dataTransfer.getData("application/libi-folder-id");
    if (!pieceId && !folderId) return;
    e.preventDefault();
    e.stopPropagation();
    if (pieceId) {
      onDropPiece(pieceId);
      return;
    }
    if (folderId) {
      // A folder dropped onto itself is a no-op; cycle guard (descendant
      // checks) lives in FileTree via wouldCreateCycle.
      if (folderId === folder.id) return;
      onDropFolder(folderId);
    }
  };

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData("application/libi-folder-id", folder.id);
    e.dataTransfer.effectAllowed = "move";
  };

  return (
    // The whole folder region (row + expanded children) is one drop target
    // for this folder. Drop handlers live here so a drop in the blank body
    // of an open folder — or onto a nested piece — lands in THIS folder. A
    // handled drop calls stopPropagation, so the innermost folder wins.
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div
        id={`folder-row-${folder.id}`}
        draggable={!isRenaming}
        onDragStart={handleDragStart}
        className={`group flex w-full cursor-pointer items-center gap-1.5 rounded-md py-1.5 pr-1.5 text-sm transition-colors border-l-2 ${
          isDragOver
            ? "bg-sidebar-accent text-sidebar-accent-foreground ring-1 ring-primary/40 border-l-transparent"
            : "text-sidebar-foreground hover:bg-sidebar-accent/60 border-l-transparent"
        }`}
        style={{ paddingLeft: `${depth * 16 + 6}px` }}
        onClick={onToggleFolder}
        onContextMenu={(e) => {
          e.preventDefault();
          onContextMenu(e, folder.id, folder.name);
        }}
      >
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleFolder();
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
        <span className="grid size-[22px] shrink-0 place-items-center rounded-sm bg-[color:var(--accent-soft)] text-primary">
          <Folder className="h-3 w-3" strokeWidth={2} />
        </span>
        {isRenaming ? (
          <input
            ref={renameInputRef}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={handleRenameSubmit}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleRenameSubmit();
              if (e.key === "Escape") {
                setRenameValue(folder.name);
                onRenameCancel();
              }
            }}
            onClick={(e) => e.stopPropagation()}
            className="flex-1 rounded border border-accent bg-background px-1 py-0 text-xs font-medium outline-none"
          />
        ) : (
          <span className="flex-1 flex items-center gap-0 min-w-0">
            <span className="truncate text-xs font-medium">{folder.name}</span>
          </span>
        )}
        {!isRenaming && folder.pieceCount > 0 && (
          <span className="text-[10px] text-muted-foreground">{folder.pieceCount}</span>
        )}
        <button
          className="invisible cursor-pointer rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground group-hover:visible"
          onClick={(e) => {
            e.stopPropagation();
            onContextMenu(e, folder.id, folder.name);
          }}
        >
          <EllipsisVertical className="h-3 w-3" />
        </button>
      </div>

      {isExpanded && <div>{renderChildren()}</div>}
    </div>
  );
}
