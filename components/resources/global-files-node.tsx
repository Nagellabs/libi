"use client";

import { useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import { useGlobalFiles } from "@/lib/queries/files";
import { useAssetFolderList } from "@/lib/queries/asset-folders";
import type { FileRecord } from "@/lib/db/schema/types";
import { Skeleton } from "@/components/ui/skeleton";
import { useDelayedFlag } from "@/hooks/use-delayed-flag";
import AssetFolderTree from "./asset-folder-tree";
import { type SortOption } from "./sort-utils";

interface GlobalFilesNodeProps {
  onSelectAsset: (file: FileRecord) => void;
  onContextMenu: (e: React.MouseEvent, type: "piece" | "asset", pieceId: string | null, fileId?: string, name?: string) => void;
  renamingFileId: string | null;
  onRenameFileSubmit: (fileId: string, name: string) => void;
  onRenameFileCancel: () => void;
  onAssignToGlobal?: (fileId: string) => void;
  onDropFiles?: (files: File[]) => void;
  innerSort: SortOption;
  search: string;
}

export default function GlobalFilesNode({
  onSelectAsset,
  onContextMenu,
  renamingFileId,
  onRenameFileSubmit,
  onRenameFileCancel,
  onAssignToGlobal,
  onDropFiles,
  innerSort,
  search,
}: GlobalFilesNodeProps) {
  const { data: files = [], isLoading } = useGlobalFiles();
  const { data: folders = [] } = useAssetFolderList(null);
  const [isExpanded, setIsExpanded] = useState(false);
  // Defer the skeleton so fast loads don't flash it (see useDelayedFlag).
  const showSkeleton = useDelayedFlag(isLoading, 300);
  const [isDragOver, setIsDragOver] = useState(false);

  // The header accepts OS file drops (upload-to-global) and the legacy
  // "assign existing file to global" drag (`application/libi-file-id`). The
  // asset-folder DnD (`application/x-libi-asset`) is handled INSIDE the tree
  // body, so the two drag types never conflict.
  const handleDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("application/libi-file-id") || e.dataTransfer.types.includes("Files")) {
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
    if (
      !e.dataTransfer.types.includes("application/libi-file-id") &&
      e.dataTransfer.files.length === 0
    ) {
      // Not a drop this header handles (e.g. an asset-folder drag) — let it
      // fall through to the tree body's own drop handler.
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const fileId = e.dataTransfer.getData("application/libi-file-id");
    if (fileId && onAssignToGlobal) {
      onAssignToGlobal(fileId);
      return;
    }
    if (e.dataTransfer.files.length > 0 && onDropFiles) {
      onDropFiles(Array.from(e.dataTransfer.files));
    }
  };

  return (
    <div
      className={`mt-1 rounded-md transition-colors ${
        isDragOver ? "ring-1 ring-primary/40 bg-[color:var(--accent-soft)]" : ""
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div
        className={`group flex w-full cursor-pointer items-center gap-1.5 rounded-md py-1.5 pl-1.5 pr-1.5 text-sm transition-colors ${
          isDragOver
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "text-sidebar-foreground hover:bg-sidebar-accent/60"
        }`}
        onClick={() => setIsExpanded((v) => !v)}
      >
        <button
          onClick={(e) => { e.stopPropagation(); setIsExpanded((v) => !v); }}
          aria-label={isExpanded ? "Collapse" : "Expand"}
          className="flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
        >
          {isExpanded ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </button>
        <span className="grid size-[22px] shrink-0 place-items-center rounded-sm border border-dashed border-border bg-muted text-muted-foreground">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          </svg>
        </span>
        <span className="flex-1 truncate text-xs font-medium">Unassigned files</span>
        <span className="text-[10px] text-muted-foreground">{files.length}</span>
      </div>
      {isExpanded &&
        (isLoading ? (
          showSkeleton ? (
            <div className="space-y-1 py-1 pl-6 pr-2">
              <Skeleton className="h-5 w-full rounded" />
              <Skeleton className="h-5 w-3/4 rounded" />
            </div>
          ) : null
        ) : (
          <AssetFolderTree
            scope={null}
            folders={folders}
            files={files}
            onSelectAsset={onSelectAsset}
            onFileContextMenu={(e, file) =>
              onContextMenu(e, "asset", null, file.id, file.name || file.filename)
            }
            renamingFileId={renamingFileId}
            onRenameFileSubmit={onRenameFileSubmit}
            onRenameFileCancel={onRenameFileCancel}
            innerSort={innerSort}
            search={search}
          />
        ))}
    </div>
  );
}
