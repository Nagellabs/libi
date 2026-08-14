"use client";

import { useState, useEffect, useRef } from "react";
import { EllipsisVertical } from "lucide-react";
import type { FileRecord } from "@/lib/db/schema/types";
import { Badge } from "@/components/ui/badge";
import { firstNonEmptyLine } from "@/lib/utils/format";
import { getFileIcon } from "./sort-utils";
import { LIBI_FILE_MIME, encodeFileDrag } from "@/lib/preview/drag-payload";

interface AssetRowProps {
  file: FileRecord;
  onSelect: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  isRenaming: boolean;
  onRenameSubmit: (name: string) => void;
  onRenameCancel: () => void;
  optionCount?: number;
}

export default function AssetRow({
  file,
  onSelect,
  onContextMenu,
  isRenaming,
  onRenameSubmit,
  onRenameCancel,
  optionCount,
}: AssetRowProps) {
  const displayName = file.name || file.filename;
  const [renameValue, setRenameValue] = useState(displayName);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Seed the input with the current name on the render where renaming turns
  // on (React's previous-state pattern — a setState here re-renders before
  // paint, without the effect-cascade the hooks lint rejects). Focus/select
  // stay in the effect: they need the committed DOM node.
  const [prevRenaming, setPrevRenaming] = useState(isRenaming);
  if (isRenaming !== prevRenaming) {
    setPrevRenaming(isRenaming);
    if (isRenaming) setRenameValue(displayName);
  }

  useEffect(() => {
    if (isRenaming) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [isRenaming]);

  const handleRenameSubmit = () => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== displayName) {
      onRenameSubmit(trimmed);
    } else {
      onRenameCancel();
    }
  };

  return (
    <div
      data-testid="asset-row"
      className="group relative flex w-full items-center rounded-md pl-7 pr-1 transition-colors hover:bg-sidebar-accent/60"
      title={firstNonEmptyLine(file.notes)}
      onContextMenu={onContextMenu}
      draggable
      onDragStart={(e) => {
        // Two payloads on one drag: the global "Unassigned" header reads
        // `libi-file-id` (assign-to-global), the asset-folder tree reads
        // `x-libi-asset` (move into a folder). dataTransfer holds multiple
        // types — each consumer reads its own, so both flows keep working.
        e.dataTransfer.setData("application/libi-file-id", file.id);
        e.dataTransfer.setData(
          "application/x-libi-asset",
          JSON.stringify({ kind: "asset", id: file.id }),
        );
        e.dataTransfer.setData(LIBI_FILE_MIME, encodeFileDrag({ fileId: file.id, contentType: file.contentType ?? "" }));
        e.dataTransfer.effectAllowed = "move";
      }}
    >
      {isRenaming ? (
        <div className="flex flex-1 items-center gap-1.5 px-1.5 py-0.5">
          <span className="text-[10px]">{getFileIcon(file.contentType)}</span>
          <input
            ref={renameInputRef}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={handleRenameSubmit}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleRenameSubmit();
              if (e.key === "Escape") onRenameCancel();
            }}
            onClick={(e) => e.stopPropagation()}
            className="flex-1 rounded border border-accent bg-background px-1 py-0 text-xs outline-none"
          />
        </div>
      ) : (
        <button
          onClick={onSelect}
          className="flex flex-1 cursor-pointer items-center gap-1.5 px-1.5 py-0.5 text-xs text-foreground"
        >
          <span className="text-[10px]">{getFileIcon(file.contentType)}</span>
          <span className="truncate">{displayName}</span>
          {optionCount != null && optionCount > 1 && (
            <Badge variant="secondary" title={`${optionCount} options`} className="ml-1 shrink-0">
              {optionCount}
            </Badge>
          )}
        </button>
      )}
      <button
        className="invisible cursor-pointer rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground group-hover:visible"
        onClick={(e) => {
          e.stopPropagation();
          onContextMenu(e);
        }}
      >
        <EllipsisVertical className="h-3 w-3" />
      </button>
    </div>
  );
}
