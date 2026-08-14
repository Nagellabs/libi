"use client";

import type { AssetFolderRecord } from "@/lib/db/schema/types";
import { ChevronRight } from "lucide-react";

export function AssetBreadcrumb({
  path,
  onJump,
  onDropFolder,
}: {
  path: AssetFolderRecord[];
  onJump: (folderId: string | null, depth: number) => void;
  /**
   * Invoked when a dragged asset/folder is dropped onto a crumb. The crumb's
   * folder id (null for the "Assets" root crumb) is passed so the caller can
   * move the dragged item to that level.
   */
  onDropFolder?: (folderId: string | null, e: React.DragEvent) => void;
}) {
  return (
    <nav className="flex items-center gap-1 text-sm text-muted-foreground px-2 py-1.5">
      <button
        type="button"
        className="cursor-pointer rounded px-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => onJump(null, -1)}
        onDragOver={onDropFolder ? (e) => e.preventDefault() : undefined}
        onDrop={onDropFolder ? (e) => onDropFolder(null, e) : undefined}
      >
        Assets
      </button>
      {path.map((f, i) => (
        <span key={f.id} className="flex items-center gap-1">
          <ChevronRight className="size-3.5 opacity-50" />
          <button
            type="button"
            className="cursor-pointer rounded px-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onJump(f.id, i)}
            onDragOver={onDropFolder ? (e) => e.preventDefault() : undefined}
            onDrop={onDropFolder ? (e) => onDropFolder(f.id, e) : undefined}
          >
            {f.name}
          </button>
        </span>
      ))}
    </nav>
  );
}
