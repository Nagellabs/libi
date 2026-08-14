"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderPlus,
  Pencil,
  Trash2,
} from "lucide-react";
import type { AssetFolderRecord, FileRecord } from "@/lib/db/schema/types";
import {
  type AssetScope,
  useMoveAsset,
  useMoveAssetFolder,
  useCreateAssetFolder,
  useRenameAssetFolder,
  useDeleteAssetFolder,
} from "@/lib/queries/asset-folders";
import AssetRow from "./asset-row";
import { sortItems, type SortOption } from "./sort-utils";

// Same MIME + payload shape as the Assets-tab explorer (asset-explorer.tsx) so
// a drag started in one surface can be dropped in the other.
const DND_MIME = "application/x-libi-asset";

type DragPayload = { kind: "folder" | "asset"; id: string };

function readDragPayload(e: React.DragEvent): DragPayload | null {
  try {
    const raw = e.dataTransfer.getData(DND_MIME);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DragPayload;
    if (
      parsed &&
      (parsed.kind === "folder" || parsed.kind === "asset") &&
      typeof parsed.id === "string"
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function isAssetDrag(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes(DND_MIME);
}

type FolderWithCount = AssetFolderRecord & { assetCount: number };

type MenuState = { x: number; y: number; folderId: string; name: string };

interface AssetFolderTreeProps {
  scope: AssetScope;
  folders: FolderWithCount[];
  files: FileRecord[];
  onSelectAsset: (file: FileRecord) => void;
  /** Right-click on a FILE row → opens the resources file context menu. */
  onFileContextMenu: (e: React.MouseEvent, file: FileRecord) => void;
  renamingFileId: string | null;
  onRenameFileSubmit: (fileId: string, name: string) => void;
  onRenameFileCancel: () => void;
  innerSort: SortOption;
  search: string;
  /** Base indentation (px) so nested rows align under the piece/global header. */
  baseIndent?: number;
}

/**
 * Reusable nested asset-folder tree. Renders asset folders as expandable rows
 * (distinct amber folder icon + recursive asset-count badge) with their files
 * nested underneath; root-level files sit at the scope root. Drag/drop moves
 * files and folders between asset folders; a right-click on a folder opens an
 * inline menu (New subfolder / Rename / Delete / Delete with contents).
 *
 * The same component drives both a piece's asset pool (`scope = pieceId`) and
 * the global/unassigned pool (`scope = null`).
 */
export default function AssetFolderTree({
  scope,
  folders,
  files,
  onSelectAsset,
  onFileContextMenu,
  renamingFileId,
  onRenameFileSubmit,
  onRenameFileCancel,
  innerSort,
  search,
  baseIndent = 28,
}: AssetFolderTreeProps) {
  const moveAsset = useMoveAsset(scope);
  const moveFolder = useMoveAssetFolder(scope);
  const createFolder = useCreateAssetFolder(scope);
  const renameFolder = useRenameAssetFolder(scope);
  const deleteFolder = useDeleteAssetFolder(scope);

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [menu, setMenu] = useState<MenuState | null>(null);
  // Folder id currently being inline-renamed.
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);

  // Dismiss the inline menu on outside click / Escape.
  useEffect(() => {
    if (!menu) return;
    const onClick = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("click", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  // ── Build the tree maps (child folders by parent, files by folder) ──────
  const q = search.trim().toLowerCase();
  const matches = (f: FileRecord) =>
    !q ||
    f.name.toLowerCase().includes(q) ||
    f.filename.toLowerCase().includes(q);

  const childFoldersByParent = useMemo(() => {
    const map = new Map<string | null, FolderWithCount[]>();
    for (const f of folders) {
      const key = f.parentFolderId ?? null;
      const list = map.get(key) ?? [];
      list.push(f);
      map.set(key, list);
    }
    for (const [key, list] of map) {
      map.set(key, sortItems(list, innerSort));
    }
    return map;
  }, [folders, innerSort]);

  const filesByFolder = useMemo(() => {
    const map = new Map<string | null, FileRecord[]>();
    for (const file of files) {
      if (!matches(file)) continue;
      const key = file.folderId ?? null;
      const list = map.get(key) ?? [];
      list.push(file);
      map.set(key, list);
    }
    for (const [key, list] of map) {
      map.set(key, sortItems(list, innerSort));
    }
    return map;
    // `matches` is derived from `search`; including it directly would be unstable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, innerSort, search]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // When a search is active, force-expand every folder so matches inside
  // collapsed folders are visible (the old flat list always showed all
  // matches). The user's manual expand/collapse state is preserved and
  // restored the moment the search box is cleared.
  const effectiveExpanded = useMemo(
    () => (q ? new Set(folders.map((f) => f.id)) : expanded),
    [q, folders, expanded],
  );

  // When searching, a folder is only shown if it (recursively) contains a
  // matching file — otherwise the tree fills with empty folders. Memoized as a
  // set of folder ids that have at least one matching descendant file.
  const foldersWithMatches = useMemo(() => {
    if (!q) return null; // null ⇒ no filtering (show all folders)
    const result = new Set<string>();
    const visit = (parentFolderId: string | null, seen: Set<string>): boolean => {
      let hasMatch = (filesByFolder.get(parentFolderId)?.length ?? 0) > 0;
      for (const child of childFoldersByParent.get(parentFolderId) ?? []) {
        if (seen.has(child.id)) continue;
        const childSeen = new Set(seen);
        childSeen.add(child.id);
        if (visit(child.id, childSeen)) {
          result.add(child.id);
          hasMatch = true;
        }
      }
      return hasMatch;
    };
    visit(null, new Set());
    return result;
  }, [q, filesByFolder, childFoldersByParent]);

  // ── DnD: move a dragged item onto a target folder (null = scope root) ───
  const dropOnFolder = async (
    targetFolderId: string | null,
    e: React.DragEvent,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const payload = readDragPayload(e);
    if (!payload) return;
    try {
      if (payload.kind === "asset") {
        await moveAsset.mutateAsync({
          fileId: payload.id,
          folderId: targetFolderId,
        });
      } else {
        // No-op when dropping a folder onto itself; the server rejects cycles.
        if (payload.id === targetFolderId) return;
        await moveFolder.mutateAsync({
          folderId: payload.id,
          parentFolderId: targetFolderId,
        });
      }
    } catch {
      // Swallow rejected moves (e.g. server-side cycle rejection).
    }
  };

  // ── Inline menu actions ─────────────────────────────────────────────────
  const handleNewSubfolder = async (parentFolderId: string) => {
    setMenu(null);
    const name = window.prompt("Folder name");
    if (!name) return;
    const created = await createFolder.mutateAsync({ name, parentFolderId });
    setExpanded((prev) => new Set([...prev, parentFolderId]));
    if (created?.id) setRenamingFolderId(created.id);
  };

  const handleDeleteFolder = async (folderId: string) => {
    setMenu(null);
    await deleteFolder.mutateAsync({ folderId, mode: "orphan" });
  };

  const handleDeleteFolderCascade = async (folderId: string) => {
    setMenu(null);
    if (
      !window.confirm(
        "Delete this folder AND everything inside it? This cannot be undone.",
      )
    ) {
      return;
    }
    await deleteFolder.mutateAsync({ folderId, mode: "cascade", confirm: true });
  };

  // ── Recursive render. `seen` guards against a corrupt parent cycle. ──────
  const renderLevel = (
    parentFolderId: string | null,
    depth: number,
    seen: Set<string>,
  ): React.ReactNode => {
    const folderChildren = childFoldersByParent.get(parentFolderId) ?? [];
    const fileChildren = filesByFolder.get(parentFolderId) ?? [];
    return (
      <>
        {folderChildren.map((folder) => {
          if (seen.has(folder.id)) return null;
          // While searching, hide folders with no matching descendant files.
          if (foldersWithMatches && !foldersWithMatches.has(folder.id)) {
            return null;
          }
          const childSeen = new Set(seen);
          childSeen.add(folder.id);
          const isOpen = effectiveExpanded.has(folder.id);
          const isRenaming = renamingFolderId === folder.id;
          return (
            <div key={folder.id}>
              <AssetFolderRow
                folder={folder}
                depth={depth}
                baseIndent={baseIndent}
                isOpen={isOpen}
                isRenaming={isRenaming}
                onToggle={() => toggle(folder.id)}
                onRenameSubmit={async (name) => {
                  setRenamingFolderId(null);
                  if (name && name !== folder.name) {
                    await renameFolder.mutateAsync({ folderId: folder.id, name });
                  }
                }}
                onRenameCancel={() => setRenamingFolderId(null)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setMenu({
                    x: e.clientX,
                    y: e.clientY,
                    folderId: folder.id,
                    name: folder.name,
                  });
                }}
                onDrop={(e) => dropOnFolder(folder.id, e)}
              />
              {isOpen && renderLevel(folder.id, depth + 1, childSeen)}
            </div>
          );
        })}
        {fileChildren.map((file) => (
          // Indent file rows by depth so foldered files nest visually under
          // their parent. AssetRow has a fixed pl-7 (= baseIndent); the wrapper
          // adds depth*16 so a file at depth d totals baseIndent + d*16 — the
          // same formula AssetFolderRow uses, keeping files and folders aligned.
          <div key={file.id} style={{ paddingLeft: `${depth * 16}px` }}>
            <AssetRow
              file={file}
              onSelect={() => onSelectAsset(file)}
              onContextMenu={(e) => {
                e.preventDefault();
                onFileContextMenu(e, file);
              }}
              isRenaming={renamingFileId === file.id}
              onRenameSubmit={(name) => onRenameFileSubmit(file.id, name)}
              onRenameCancel={onRenameFileCancel}
            />
          </div>
        ))}
      </>
    );
  };

  const isEmpty =
    (childFoldersByParent.get(null)?.length ?? 0) === 0 &&
    (filesByFolder.get(null)?.length ?? 0) === 0;

  return (
    // The scope-root drop target: dropping here moves the item to folderId:null.
    <div
      className="py-0.5"
      onDragOver={(e) => {
        if (isAssetDrag(e)) e.preventDefault();
      }}
      onDrop={(e) => {
        if (isAssetDrag(e)) void dropOnFolder(null, e);
      }}
    >
      {isEmpty ? (
        <div className="py-1 pl-7 pr-2">
          <span className="text-[10px] text-muted-foreground italic">
            {q ? "No matching files" : "No files"}
          </span>
        </div>
      ) : (
        renderLevel(null, 0, new Set())
      )}

      {menu && (
        <div
          className="fixed z-50 min-w-[180px] rounded-lg border border-border bg-popover p-1 shadow-md"
          style={{ top: menu.y, left: menu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => handleNewSubfolder(menu.folderId)}
            className="cursor-pointer flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground transition-colors hover:bg-accent"
          >
            <FolderPlus className="h-3.5 w-3.5" />
            New subfolder
          </button>
          <button
            type="button"
            onClick={() => {
              setRenamingFolderId(menu.folderId);
              setMenu(null);
            }}
            className="cursor-pointer flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground transition-colors hover:bg-accent"
          >
            <Pencil className="h-3.5 w-3.5" />
            Rename
          </button>
          <button
            type="button"
            onClick={() => handleDeleteFolder(menu.folderId)}
            className="cursor-pointer flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-destructive transition-colors hover:bg-destructive/10"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </button>
          <button
            type="button"
            onClick={() => handleDeleteFolderCascade(menu.folderId)}
            className="cursor-pointer flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-destructive transition-colors hover:bg-destructive/10"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete with contents
          </button>
        </div>
      )}
    </div>
  );
}

interface AssetFolderRowProps {
  folder: FolderWithCount;
  depth: number;
  baseIndent: number;
  isOpen: boolean;
  isRenaming: boolean;
  onToggle: () => void;
  onRenameSubmit: (name: string) => void;
  onRenameCancel: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}

function AssetFolderRow({
  folder,
  depth,
  baseIndent,
  isOpen,
  isRenaming,
  onToggle,
  onRenameSubmit,
  onRenameCancel,
  onContextMenu,
  onDrop,
}: AssetFolderRowProps) {
  const [renameValue, setRenameValue] = useState(folder.name);
  const [isDragOver, setIsDragOver] = useState(false);

  // Seed the input on the render where renaming turns on (React's
  // previous-state pattern — re-renders before paint, no effect cascade).
  const [prevRenaming, setPrevRenaming] = useState(isRenaming);
  if (isRenaming !== prevRenaming) {
    setPrevRenaming(isRenaming);
    if (isRenaming) setRenameValue(folder.name);
  }

  return (
    <div
      data-testid="asset-folder-row"
      className={`group flex w-full items-center gap-1.5 rounded-md pr-1 text-sm transition-colors ${
        isDragOver
          ? "bg-sidebar-accent text-sidebar-accent-foreground ring-1 ring-primary/40"
          : "text-sidebar-foreground hover:bg-sidebar-accent/60"
      }`}
      style={{ paddingLeft: `${baseIndent + depth * 16}px` }}
      draggable={!isRenaming}
      onDragStart={(e) => {
        e.dataTransfer.setData(
          DND_MIME,
          JSON.stringify({ kind: "folder", id: folder.id }),
        );
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(e) => {
        if (isAssetDrag(e)) {
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
      onDrop={(e) => {
        setIsDragOver(false);
        onDrop(e);
      }}
      onContextMenu={onContextMenu}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        aria-label={isOpen ? "Collapse folder" : "Expand folder"}
        className="flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
      >
        {isOpen ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
      </button>
      {/* Distinct amber folder icon — visually separates ASSET folders from the
          library/piece folders, matching the Assets-tab explorer. */}
      <Folder className="h-3.5 w-3.5 shrink-0 text-amber-400" />
      {isRenaming ? (
        <input
          autoFocus
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={() => onRenameSubmit(renameValue.trim())}
          onKeyDown={(e) => {
            if (e.key === "Enter") onRenameSubmit(renameValue.trim());
            if (e.key === "Escape") onRenameCancel();
          }}
          onClick={(e) => e.stopPropagation()}
          className="flex-1 rounded border border-accent bg-background px-1 py-0 text-xs font-medium outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={onToggle}
          className="flex flex-1 cursor-pointer items-center gap-1.5 py-1 text-left text-xs font-medium text-foreground"
        >
          <span className="truncate">{folder.name}</span>
        </button>
      )}
      <span
        className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground"
        title={`${folder.assetCount} asset${folder.assetCount === 1 ? "" : "s"}`}
      >
        {folder.assetCount}
      </span>
    </div>
  );
}
