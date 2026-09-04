"use client";

import { useRef, useEffect, useLayoutEffect, useState } from "react";
import { Copy, Pencil, Trash2, FolderPlus, FolderInput, ChevronRight, Folder } from "lucide-react";
import type { FolderNode } from "@/lib/queries/folders";
import { RevealMenuItem } from "@/components/shared/reveal-asset";

export interface ContextMenuState {
  x: number;
  y: number;
  type: "piece" | "asset" | "folder";
  pieceId: string | null;
  fileId?: string;
  folderId?: string;
  name: string;
}

interface ResourceContextMenuProps {
  state: ContextMenuState;
  onRename: () => void;
  onDelete: () => void;
  /** Folder-only: create a subfolder under the right-clicked folder. */
  onNewSubfolder?: () => void;
  /** Folder + piece: move the target into the chosen destination folder (null = Root). */
  onMoveTo?: (destinationFolderId: string | null) => void;
  /** Folder + piece: duplicate the target into an independent copy. */
  onDuplicate?: () => void;
  /** Close the menu. The reveal row calls it before acting, so the menu
   *  behaves like every other item. */
  onClose?: () => void;
  /** All folders, for the "Move to…" submenu. Pass undefined to hide the submenu. */
  folders?: FolderNode[];
}

/**
 * Nested "Move to…" submenu. Lists every folder indented by depth plus a
 * "Root" entry. Selecting one calls onSelect with the destination id.
 */
function MoveToSubmenu({
  folders,
  excludeId,
  onSelect,
}: {
  folders: FolderNode[];
  /** Folder being moved — it and its descendants are not valid targets. */
  excludeId?: string;
  onSelect: (destinationFolderId: string | null) => void;
}) {
  // Compute the set of disallowed ids (the folder + its descendants).
  const disallowed = new Set<string>();
  if (excludeId) {
    disallowed.add(excludeId);
    const childrenByParent = new Map<string, string[]>();
    for (const f of folders) {
      if (!f.parentFolderId) continue;
      const list = childrenByParent.get(f.parentFolderId) ?? [];
      list.push(f.id);
      childrenByParent.set(f.parentFolderId, list);
    }
    const stack = [...(childrenByParent.get(excludeId) ?? [])];
    while (stack.length) {
      const next = stack.pop()!;
      disallowed.add(next);
      stack.push(...(childrenByParent.get(next) ?? []));
    }
  }

  // Build an ordered, depth-annotated list (folders first at each level).
  const childrenByParent = new Map<string | null, FolderNode[]>();
  for (const f of folders) {
    const key = f.parentFolderId ?? null;
    const list = childrenByParent.get(key) ?? [];
    list.push(f);
    childrenByParent.set(key, list);
  }
  for (const list of childrenByParent.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }
  const ordered: { folder: FolderNode; depth: number }[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const f of childrenByParent.get(parentId) ?? []) {
      ordered.push({ folder: f, depth });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);

  // The resources panel hugs the right edge of the window, so a submenu
  // opened to the right (`left-full`) routinely overflows the viewport.
  // After first render, measure and flip it to the left (`right-full`) when
  // there isn't enough room on the right.
  const submenuRef = useRef<HTMLDivElement>(null);
  const [openLeft, setOpenLeft] = useState(false);
  // useLayoutEffect — measure synchronously after the submenu is committed to
  // the DOM but before paint, so the flip decision is made against the final
  // layout (the parent context menu has already been position-clamped) with
  // no visible flash. A plain useEffect raced the parent's clamp and could
  // leave the submenu overflowing the right edge of the window.
  useLayoutEffect(() => {
    const el = submenuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // rect.right is computed with the current (default-right) placement.
    setOpenLeft(rect.right > window.innerWidth - 8);
  }, []);

  return (
    <div
      ref={submenuRef}
      className={`absolute top-0 max-h-72 min-w-[160px] overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-md ${
        openLeft ? "right-full mr-0.5" : "left-full ml-0.5"
      }`}
    >
      <button
        onClick={() => onSelect(null)}
        className="cursor-pointer flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground transition-colors hover:bg-accent"
      >
        <Folder className="h-3.5 w-3.5" />
        Root
      </button>
      {ordered.map(({ folder, depth }) => {
        const blocked = disallowed.has(folder.id);
        return (
          <button
            key={folder.id}
            onClick={() => !blocked && onSelect(folder.id)}
            disabled={blocked}
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors ${
              blocked
                ? "cursor-not-allowed text-muted-foreground/50"
                : "cursor-pointer text-foreground hover:bg-accent"
            }`}
            style={{ paddingLeft: `${depth * 12 + 8}px` }}
          >
            <Folder className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{folder.name}</span>
          </button>
        );
      })}
    </div>
  );
}

export default function ResourceContextMenu({
  state,
  onRename,
  onDelete,
  onNewSubfolder,
  onMoveTo,
  onDuplicate,
  onClose,
  folders,
}: ResourceContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: state.y, left: state.x });
  const [moveSubmenuOpen, setMoveSubmenuOpen] = useState(false);

  useEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const top = Math.min(state.y, window.innerHeight - rect.height - 8);
    const left = Math.min(state.x, window.innerWidth - rect.width - 8);
    setPosition({ top: Math.max(0, top), left: Math.max(0, left) });
  }, [state.x, state.y]);

  const isFolder = state.type === "folder";
  const isPiece = state.type === "piece";
  const isAsset = state.type === "asset";
  const showMoveTo = (isFolder || isPiece) && !!onMoveTo && !!folders;

  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-[160px] rounded-lg border border-border bg-popover p-1 shadow-md"
      style={{ top: position.top, left: position.left }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        onClick={onRename}
        className="cursor-pointer flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground transition-colors hover:bg-accent"
      >
        <Pencil className="h-3.5 w-3.5" />
        Rename
      </button>

      {isFolder && onNewSubfolder && (
        <button
          onClick={onNewSubfolder}
          className="cursor-pointer flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground transition-colors hover:bg-accent"
        >
          <FolderPlus className="h-3.5 w-3.5" />
          New subfolder
        </button>
      )}

      {showMoveTo && (
        <div
          className="relative"
          onMouseEnter={() => setMoveSubmenuOpen(true)}
          onMouseLeave={() => setMoveSubmenuOpen(false)}
        >
          <button
            className="cursor-pointer flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground transition-colors hover:bg-accent"
          >
            <FolderInput className="h-3.5 w-3.5" />
            <span className="flex-1 text-left">Move to…</span>
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
          {moveSubmenuOpen && (
            <MoveToSubmenu
              folders={folders!}
              excludeId={isFolder ? state.folderId : undefined}
              onSelect={(destId) => {
                setMoveSubmenuOpen(false);
                onMoveTo!(destId);
              }}
            />
          )}
        </div>
      )}

      {isFolder && onDuplicate && (
        <button
          onClick={onDuplicate}
          className="cursor-pointer flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground transition-colors hover:bg-accent"
        >
          <Copy className="h-3.5 w-3.5" />
          Duplicate folder
        </button>
      )}

      {isPiece && onDuplicate && (
        <button
          onClick={onDuplicate}
          className="cursor-pointer flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground transition-colors hover:bg-accent"
        >
          <Copy className="h-3.5 w-3.5" />
          Duplicate piece…
        </button>
      )}

      {/* Assets are the only type with an on-disk location — a piece is a
          directory but is out of scope, and an asset folder is a DB row with
          nothing on disk. */}
      {isAsset && state.fileId && (
        <RevealMenuItem
          fileId={state.fileId}
          source="context_menu"
          onAfter={onClose}
        />
      )}

      <button
        onClick={onDelete}
        className="cursor-pointer flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-destructive transition-colors hover:bg-destructive/10"
      >
        <Trash2 className="h-3.5 w-3.5" />
        Delete
      </button>

      {isPiece && state.pieceId && (
        <button
          onClick={() => {
            navigator.clipboard.writeText(state.pieceId!);
          }}
          className="cursor-pointer flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground transition-colors hover:bg-accent"
        >
          <Copy className="h-3.5 w-3.5" />
          Copy ID
        </button>
      )}
    </div>
  );
}
