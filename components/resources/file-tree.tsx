"use client";

import { useState, useMemo, useCallback, useEffect, useRef, useImperativeHandle, forwardRef } from "react";
import { Search, ArrowUpDown, Check } from "lucide-react";
import { usePieces, useDeletePiece } from "@/lib/queries/pieces";
import type { PieceSummary } from "@/lib/queries/pieces";
import { useDeleteFileById, useRenameFile, useAssignFile, useGlobalUpload } from "@/lib/queries/files";
import {
  useFolders,
  useCreateFolder,
  useRenameFolder,
  useMoveFolder,
  useMovePieceToFolder,
  useDeleteFolder,
  type FolderNode as FolderNodeData,
} from "@/lib/queries/folders";
import { getAncestorIds, getDescendantIds, wouldCreateCycle } from "@/lib/folders/tree";
import { resolveCopyName } from "@/lib/duplication/copy-name";
import {
  useDuplicatePiece,
  useDuplicateFolder,
  useDuplicatingPieceIds,
} from "@/lib/queries/duplication";
import type { FileRecord, FolderRecord } from "@/lib/db/schema/types";
import { Skeleton } from "@/components/ui/skeleton";
import { useDelayedFlag } from "@/hooks/use-delayed-flag";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuGroup,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import ResourceContextMenu, { type ContextMenuState } from "./context-menu";
import PieceNode from "./piece-node";
import FolderNode from "./folder-node";
import GlobalFilesNode from "./global-files-node";
import FolderDeleteDialog from "./folder-delete-dialog";
import DuplicateDialog from "./duplicate-dialog";
import {
  type SortOption,
  SORT_LABELS,
  ROOT_SORT_KEY,
  INNER_SORT_KEY,
  loadSort,
  saveSort,
  sortItems,
} from "./sort-utils";

interface FileTreeProps {
  activePieceId: string | null;
  onSelectPiece: (pieceId: string) => void;
  onSelectAsset: (pieceId: string | null, file: FileRecord) => void;
  onDeletePiece: (pieceId: string) => void;
  onRenamePiece?: (pieceId: string, name: string) => void;
  onUploadFiles?: (pieceId: string, files: File[]) => void;
  /** Folder reveal request (from libi.show_folder). `nonce` re-fires repeats. */
  revealFolder?: { id: string; nonce: number } | null;
}

/** Imperative handle so ResourcesPanel's "+ Folder" button can drive creation. */
export interface FileTreeHandle {
  createFolder: () => void;
}

export function FileTreeSkeleton() {
  return (
    <div className="space-y-1 p-2">
      {[
        { children: 2 },
        { children: 0 },
        { children: 3 },
      ].map((piece, i) => (
        <div key={i}>
          <div className="flex items-center gap-1 px-1.5 py-1">
            <Skeleton className="h-3 w-3 rounded" />
            <Skeleton className="h-3 w-3 rounded" />
            <Skeleton className="h-3.5 w-24 rounded" />
          </div>
          {piece.children > 0 && (
            <div className="space-y-0.5 pl-7">
              {Array.from({ length: piece.children }).map((_, j) => (
                <div key={j} className="flex items-center gap-1.5 py-0.5">
                  <Skeleton className="h-2.5 w-2.5 rounded" />
                  <Skeleton className={`h-3 rounded ${j % 2 === 0 ? "w-20" : "w-16"}`} />
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** FolderNode-shaped record subset that lib/folders/tree helpers accept. */
function toFolderRecords(folders: FolderNodeData[]): FolderRecord[] {
  return folders as unknown as FolderRecord[];
}

const FileTree = forwardRef<FileTreeHandle, FileTreeProps>(function FileTree(
  {
    activePieceId,
    onSelectPiece,
    onSelectAsset,
    onDeletePiece,
    onRenamePiece,
    onUploadFiles,
    revealFolder,
  }: FileTreeProps,
  ref,
) {
  const { data: pieces = [], isLoading } = usePieces();
  const { data: folders = [] } = useFolders();
  // Defer the initial-load skeleton so fast loads don't flash it.
  const showLoadingSkeleton = useDelayedFlag(isLoading, 300);
  const deletePiece = useDeletePiece();
  const deleteFile = useDeleteFileById();
  const renameFile = useRenameFile();
  const assignFile = useAssignFile();
  const { upload: globalUpload } = useGlobalUpload();

  const createFolder = useCreateFolder();
  const renameFolder = useRenameFolder();
  const moveFolder = useMoveFolder();
  const movePieceToFolder = useMovePieceToFolder();
  const deleteFolder = useDeleteFolder();
  const duplicatePiece = useDuplicatePiece();
  const duplicateFolder = useDuplicateFolder();
  // Piece ids with an in-flight piece_dup job → copy-in-progress spinner.
  const duplicatingIds = useDuplicatingPieceIds();

  const [search, setSearch] = useState("");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => {
    return activePieceId ? new Set([activePieceId]) : new Set();
  });
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(() => new Set());
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renamingFileId, setRenamingFileId] = useState<string | null>(null);
  // pieceId that should trigger its inline rename input
  const [renamingPieceId, setRenamingPieceId] = useState<string | null>(null);
  // folderId that should trigger its inline rename input
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  // Pending folder-delete confirmation (non-empty folders only)
  const [deleteDialogFolderId, setDeleteDialogFolderId] = useState<string | null>(null);
  // Pending piece/folder duplication confirmation
  const [duplicateTarget, setDuplicateTarget] = useState<
    | { mode: "piece"; id: string; defaultName: string }
    | { mode: "folder"; id: string; defaultName: string; pieceCount: number }
    | null
  >(null);

  const [rootSort, setRootSort] = useState<SortOption>(() => loadSort(ROOT_SORT_KEY));
  const [innerSort, setInnerSort] = useState<SortOption>(() => loadSort(INNER_SORT_KEY));

  const handleRootSortChange = useCallback((sort: SortOption) => {
    setRootSort(sort);
    saveSort(ROOT_SORT_KEY, sort);
  }, []);

  const handleInnerSortChange = useCallback((sort: SortOption) => {
    setInnerSort(sort);
    saveSort(INNER_SORT_KEY, sort);
  }, []);

  // ── Build the folder/piece tree maps ─────────────────────────────────
  // childFoldersByParent: parentFolderId|null -> sorted folders
  // piecesByFolder:       folderId|null       -> sorted pieces
  const childFoldersByParent = useMemo(() => {
    const map = new Map<string | null, FolderNodeData[]>();
    for (const f of folders) {
      const key = f.parentFolderId ?? null;
      const list = map.get(key) ?? [];
      list.push(f);
      map.set(key, list);
    }
    for (const [key, list] of map) {
      map.set(key, sortItems(list, rootSort));
    }
    return map;
  }, [folders, rootSort]);

  const piecesByFolder = useMemo(() => {
    const map = new Map<string | null, PieceSummary[]>();
    for (const p of pieces) {
      const key = p.folderId ?? null;
      const list = map.get(key) ?? [];
      list.push(p);
      map.set(key, list);
    }
    for (const [key, list] of map) {
      map.set(key, sortItems(list, rootSort));
    }
    return map;
  }, [pieces, rootSort]);

  // Sorted flat list — used only in search (flatten) mode.
  const sortedPieces = useMemo(() => sortItems(pieces, rootSort), [pieces, rootSort]);
  const sortedFolders = useMemo(() => sortItems(folders, rootSort), [folders, rootSort]);

  const toggleExpand = useCallback((pieceId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(pieceId)) {
        next.delete(pieceId);
      } else {
        next.add(pieceId);
      }
      return next;
    });
  }, []);

  const toggleFolder = useCallback((folderId: string) => {
    setExpandedFolderIds((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  }, []);

  // Auto-expand active piece when it changes
  useEffect(() => {
    if (activePieceId) {
      setExpandedIds((prev) => {
        if (prev.has(activePieceId)) return prev;
        return new Set([...prev, activePieceId]);
      });
    }
  }, [activePieceId]);

  // Auto-expand the active piece's ancestor folder chain.
  useEffect(() => {
    if (!activePieceId) return;
    const piece = pieces.find((p) => p.id === activePieceId);
    if (!piece || !piece.folderId) return;
    const chain = [
      piece.folderId,
      ...getAncestorIds(piece.folderId, toFolderRecords(folders)),
    ];
    setExpandedFolderIds((prev) => {
      if (chain.every((id) => prev.has(id))) return prev;
      return new Set([...prev, ...chain]);
    });
  }, [activePieceId, pieces, folders]);

  // Reveal a folder (from libi.show_folder): expand its ancestor chain +
  // scroll it into view. `revealFolder` carries a monotonic `nonce` so a
  // repeated reveal of the same folder re-fires. The effect only acts once
  // per nonce — but it waits until the target folder is actually present in
  // the `folders` query before marking the nonce handled, so a reveal that
  // arrives before the folder list has loaded is retried on the next refetch.
  const lastRevealNonceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!revealFolder) return;
    if (revealFolder.nonce === lastRevealNonceRef.current) return;
    // Target not in the (possibly stale) folder list yet — wait for a refetch.
    if (!folders.some((f) => f.id === revealFolder.id)) return;
    lastRevealNonceRef.current = revealFolder.nonce;
    const chain = [
      revealFolder.id,
      ...getAncestorIds(revealFolder.id, toFolderRecords(folders)),
    ];
    setExpandedFolderIds((prev) => new Set([...prev, ...chain]));
    // Defer scroll until the expanded rows have rendered.
    const t = setTimeout(() => {
      document
        .getElementById(`folder-row-${revealFolder.id}`)
        ?.scrollIntoView({ block: "nearest" });
    }, 50);
    return () => clearTimeout(t);
  }, [revealFolder, folders]);

  // Close context menu on outside click or Escape key
  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = () => setContextMenu(null);
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setContextMenu(null);
    };
    document.addEventListener("click", handleClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("click", handleClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [contextMenu]);

  const handleContextMenu = useCallback(
    (
      e: React.MouseEvent,
      type: "piece" | "asset",
      pieceId: string | null,
      fileId?: string,
      name?: string,
    ) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        type,
        pieceId,
        fileId,
        name: name ?? "",
      });
    },
    [],
  );

  const handleFolderContextMenu = useCallback(
    (e: React.MouseEvent, folderId: string, name: string) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        type: "folder",
        pieceId: null,
        folderId,
        name,
      });
    },
    [],
  );

  const handleDeletePiece = useCallback(
    (pieceId: string) => {
      if (confirm("Delete this piece and all its files?")) {
        deletePiece.mutate(pieceId);
        onDeletePiece(pieceId);
      }
    },
    [deletePiece, onDeletePiece],
  );

  const handleDeleteFile = useCallback(
    (fileId: string) => {
      if (confirm("Delete this file?")) {
        deleteFile.mutate(fileId);
      }
    },
    [deleteFile],
  );

  // ── Folder delete: empty folders go immediately, others show a dialog ─
  const requestDeleteFolder = useCallback(
    (folderId: string) => {
      const folder = folders.find((f) => f.id === folderId);
      if (!folder) return;
      const hasChildFolders = folders.some((f) => f.parentFolderId === folderId);
      if (folder.pieceCount === 0 && !hasChildFolders) {
        deleteFolder.mutate({ folderId, mode: "orphan" });
        return;
      }
      setDeleteDialogFolderId(folderId);
    },
    [folders, deleteFolder],
  );

  const handleRenameFileSubmit = useCallback(
    (fileId: string, name: string) => {
      renameFile.mutate({ fileId, name });
      setRenamingFileId(null);
    },
    [renameFile],
  );

  const handleRenameFileCancel = useCallback(() => {
    setRenamingFileId(null);
  }, []);

  const handleGlobalDropFiles = useCallback(async (droppedFiles: File[]) => {
    for (const file of droppedFiles) {
      await globalUpload(file);
    }
  }, [globalUpload]);

  // ── Folder mutations driven by drag / context menu ───────────────────
  const handleDropPieceOnFolder = useCallback(
    (pieceId: string, folderId: string | null) => {
      const piece = pieces.find((p) => p.id === pieceId);
      if (piece && (piece.folderId ?? null) === folderId) return;
      movePieceToFolder.mutate({ pieceId, folderId });
    },
    [pieces, movePieceToFolder],
  );

  const handleDropFolderOnFolder = useCallback(
    (folderId: string, newParentId: string | null) => {
      const folder = folders.find((f) => f.id === folderId);
      if (!folder || (folder.parentFolderId ?? null) === newParentId) return;
      // UI-side cycle guard: a folder cannot be dropped into itself or a
      // descendant — reject silently.
      if (wouldCreateCycle(folderId, newParentId, toFolderRecords(folders))) {
        return;
      }
      moveFolder.mutate({ folderId, parentFolderId: newParentId });
    },
    [folders, moveFolder],
  );

  const handleCreateFolder = useCallback(
    (parentFolderId: string | null) => {
      createFolder.mutate(
        { name: "New folder", parentFolderId },
        {
          onSuccess: (created: { id: string }) => {
            if (parentFolderId) {
              setExpandedFolderIds((prev) => new Set([...prev, parentFolderId]));
            }
            // Auto-enter inline rename on the new folder.
            setRenamingFolderId(created.id);
          },
        },
      );
    },
    [createFolder],
  );

  // Exposed to ResourcesPanel via ref for the header "+ Folder" button.
  useImperativeHandle(
    ref,
    () => ({
      createFolder: () => handleCreateFolder(null),
    }),
    [handleCreateFolder],
  );

  const handleContextMenuRename = () => {
    if (!contextMenu) return;
    if (contextMenu.type === "piece" && contextMenu.pieceId) {
      setRenamingPieceId(contextMenu.pieceId);
    } else if (contextMenu.type === "asset" && contextMenu.fileId) {
      setRenamingFileId(contextMenu.fileId);
    } else if (contextMenu.type === "folder" && contextMenu.folderId) {
      setRenamingFolderId(contextMenu.folderId);
    }
    setContextMenu(null);
  };

  const handleContextMenuDelete = () => {
    if (!contextMenu) return;
    if (contextMenu.type === "piece" && contextMenu.pieceId) {
      const pieceId = contextMenu.pieceId;
      setContextMenu(null);
      handleDeletePiece(pieceId);
    } else if (contextMenu.type === "asset" && contextMenu.fileId) {
      const fileId = contextMenu.fileId;
      setContextMenu(null);
      handleDeleteFile(fileId);
    } else if (contextMenu.type === "folder" && contextMenu.folderId) {
      const folderId = contextMenu.folderId;
      setContextMenu(null);
      requestDeleteFolder(folderId);
    }
  };

  const handleContextMenuNewSubfolder = () => {
    if (!contextMenu || contextMenu.type !== "folder" || !contextMenu.folderId) return;
    const folderId = contextMenu.folderId;
    setContextMenu(null);
    handleCreateFolder(folderId);
  };

  const handleContextMenuMoveTo = (destinationFolderId: string | null) => {
    if (!contextMenu) return;
    if (contextMenu.type === "folder" && contextMenu.folderId) {
      handleDropFolderOnFolder(contextMenu.folderId, destinationFolderId);
    } else if (contextMenu.type === "piece" && contextMenu.pieceId) {
      handleDropPieceOnFolder(contextMenu.pieceId, destinationFolderId);
    }
    setContextMenu(null);
  };

  // ── Duplicate: resolve the default copy name + open the dialog ────────
  const handleContextMenuDuplicate = () => {
    if (!contextMenu) return;
    if (contextMenu.type === "piece" && contextMenu.pieceId) {
      const piece = pieces.find((p) => p.id === contextMenu.pieceId);
      if (piece) {
        setDuplicateTarget({
          mode: "piece",
          id: piece.id,
          defaultName: resolveCopyName(
            piece.name,
            pieces.map((p) => p.name),
          ),
        });
      }
    } else if (contextMenu.type === "folder" && contextMenu.folderId) {
      const folder = folders.find((f) => f.id === contextMenu.folderId);
      if (folder) {
        // Count pieces across the folder + its whole subtree.
        const subtreeIds = new Set([
          folder.id,
          ...getDescendantIds(folder.id, toFolderRecords(folders)),
        ]);
        let pieceCount = 0;
        for (const f of folders) {
          if (subtreeIds.has(f.id)) pieceCount += f.pieceCount;
        }
        setDuplicateTarget({
          mode: "folder",
          id: folder.id,
          defaultName: resolveCopyName(
            folder.name,
            folders.map((f) => f.name),
          ),
          pieceCount,
        });
      }
    }
    setContextMenu(null);
  };

  // ── Recursive renderer: folders FIRST, then pieces, at every level ───
  // `seen` threads the chain of ancestor folder ids so a corrupt folder
  // cycle in the DB can never put renderLevel into an infinite loop.
  const renderLevel = useCallback(
    (
      parentFolderId: string | null,
      depth: number,
      seen: Set<string> = new Set(),
    ): React.ReactNode => {
      const folderChildren = childFoldersByParent.get(parentFolderId) ?? [];
      const pieceChildren = piecesByFolder.get(parentFolderId) ?? [];
      return (
        <>
          {folderChildren.map((folder) => {
            // Already rendered higher in this branch ⇒ cycle. Skip it.
            if (seen.has(folder.id)) return null;
            const childSeen = new Set(seen);
            childSeen.add(folder.id);
            return (
              <FolderNode
                key={folder.id}
                folder={folder}
                depth={depth}
                isExpanded={expandedFolderIds.has(folder.id)}
                onToggleFolder={() => toggleFolder(folder.id)}
                isRenaming={renamingFolderId === folder.id}
                onRenameSubmit={(name) => {
                  renameFolder.mutate({ folderId: folder.id, name });
                  setRenamingFolderId(null);
                }}
                onRenameCancel={() => setRenamingFolderId(null)}
                onContextMenu={handleFolderContextMenu}
                onDropPiece={(pieceId) => handleDropPieceOnFolder(pieceId, folder.id)}
                onDropFolder={(droppedId) => handleDropFolderOnFolder(droppedId, folder.id)}
                renderChildren={() => renderLevel(folder.id, depth + 1, childSeen)}
              />
            );
          })}
          {pieceChildren.map((piece) => (
            <PieceNode
              key={piece.id}
              piece={piece}
              depth={depth}
              isActive={piece.id === activePieceId}
              isCopying={duplicatingIds.has(piece.id)}
              isExpanded={expandedIds.has(piece.id)}
              onToggleExpand={() => toggleExpand(piece.id)}
              onSelectPiece={() => onSelectPiece(piece.id)}
              onSelectAsset={(file) => onSelectAsset(piece.id, file)}
              onRenamePiece={onRenamePiece ? (name) => onRenamePiece(piece.id, name) : undefined}
              onDropFiles={onUploadFiles ? (files) => onUploadFiles(piece.id, files) : undefined}
              onAssignFile={(fileId) => assignFile.mutate({ fileId, pieceId: piece.id })}
              onContextMenu={handleContextMenu}
              renamingFileId={renamingFileId}
              onRenameFileSubmit={handleRenameFileSubmit}
              onRenameFileCancel={handleRenameFileCancel}
              triggerRename={renamingPieceId === piece.id}
              onRenameTriggerHandled={() => setRenamingPieceId(null)}
              innerSort={innerSort}
              search={search}
            />
          ))}
        </>
      );
    },
    [
      childFoldersByParent,
      piecesByFolder,
      expandedFolderIds,
      expandedIds,
      duplicatingIds,
      renamingFolderId,
      renamingPieceId,
      renamingFileId,
      activePieceId,
      innerSort,
      search,
      toggleFolder,
      toggleExpand,
      onSelectPiece,
      onSelectAsset,
      onRenamePiece,
      onUploadFiles,
      assignFile,
      renameFolder,
      handleFolderContextMenu,
      handleContextMenu,
      handleDropPieceOnFolder,
      handleDropFolderOnFolder,
      handleRenameFileSubmit,
      handleRenameFileCancel,
    ],
  );

  // ── Search (flatten) mode: matching folders flat, then matching pieces ─
  const searchResults = useMemo(() => {
    if (!search.trim()) return null;
    const q = search.toLowerCase();
    const matchedFolders = sortedFolders.filter((f) =>
      f.name.toLowerCase().includes(q),
    );
    const matchedPieces = sortedPieces.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.description?.toLowerCase().includes(q) ?? false),
    );
    return { matchedFolders, matchedPieces };
  }, [search, sortedFolders, sortedPieces]);

  const deleteDialogFolder = deleteDialogFolderId
    ? folders.find((f) => f.id === deleteDialogFolderId)
    : null;
  // Subtree counts for the delete dialog.
  const deleteDialogCounts = useMemo(() => {
    if (!deleteDialogFolder) return { pieceCount: 0, subfolderCount: 0, parentName: null as string | null };
    const descendants = getDescendantIds(
      deleteDialogFolder.id,
      toFolderRecords(folders),
    );
    const subtreeIds = new Set([deleteDialogFolder.id, ...descendants]);
    let pieceCount = 0;
    for (const f of folders) {
      if (subtreeIds.has(f.id)) pieceCount += f.pieceCount;
    }
    const parent = deleteDialogFolder.parentFolderId
      ? folders.find((f) => f.id === deleteDialogFolder.parentFolderId)
      : null;
    return {
      pieceCount,
      subfolderCount: descendants.length,
      parentName: parent?.name ?? null,
    };
  }, [deleteDialogFolder, folders]);

  return (
    <div className="flex h-full flex-col">
      {/* Search */}
      <div className="border-b border-sidebar-border px-2 py-2">
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search pieces & files..."
              className="w-full rounded-md border border-border bg-card py-1 pl-7 pr-2 text-xs text-foreground placeholder-muted-foreground outline-none transition-colors focus:border-primary/40"
            />
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  className="cursor-pointer shrink-0 rounded-md border border-border bg-card p-1 text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                  title="Sort"
                />
              }
            >
              <ArrowUpDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="bottom" align="end" sideOffset={4}>
              {/* Each label MUST stay wrapped in its DropdownMenuGroup: base-ui's
                  GroupLabel throws outright when it can't find a group above it,
                  and the throw lands during render of the menu content — i.e. on
                  the click that opens this menu. Grouping is also what ties the
                  label to its four items for screen readers, since both sections
                  otherwise offer the same four names. */}
              <DropdownMenuGroup>
                <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">Root</DropdownMenuLabel>
                {(Object.keys(SORT_LABELS) as SortOption[]).map((opt) => (
                  <DropdownMenuItem
                    key={opt}
                    className="cursor-pointer"
                    onClick={() => handleRootSortChange(opt)}
                  >
                    <Check className={`h-3.5 w-3.5 ${rootSort === opt ? "opacity-100" : "opacity-0"}`} />
                    {SORT_LABELS[opt]}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">Inside pieces</DropdownMenuLabel>
                {(Object.keys(SORT_LABELS) as SortOption[]).map((opt) => (
                  <DropdownMenuItem
                    key={opt}
                    className="cursor-pointer"
                    onClick={() => handleInnerSortChange(opt)}
                  >
                    <Check className={`h-3.5 w-3.5 ${innerSort === opt ? "opacity-100" : "opacity-0"}`} />
                    {SORT_LABELS[opt]}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Tree */}
      <div
        className="flex-1 overflow-y-auto px-1 py-1"
        onDragOver={(e) => {
          if (
            e.dataTransfer.types.includes("Files") ||
            e.dataTransfer.types.includes("application/libi-piece-id") ||
            e.dataTransfer.types.includes("application/libi-folder-id")
          ) {
            e.preventDefault();
          }
        }}
        onDrop={(e) => {
          if (e.defaultPrevented) return;
          // A piece / folder dropped on empty root space → move to root.
          const pieceId = e.dataTransfer.getData("application/libi-piece-id");
          const folderId = e.dataTransfer.getData("application/libi-folder-id");
          if (pieceId) {
            e.preventDefault();
            handleDropPieceOnFolder(pieceId, null);
            return;
          }
          if (folderId) {
            e.preventDefault();
            handleDropFolderOnFolder(folderId, null);
            return;
          }
          e.preventDefault();
          if (e.dataTransfer.files.length > 0) {
            handleGlobalDropFiles(Array.from(e.dataTransfer.files));
          }
        }}
      >
        {isLoading ? (
          showLoadingSkeleton ? (
            <FileTreeSkeleton />
          ) : null
        ) : (
          <div className="space-y-0.5">
            {searchResults ? (
              searchResults.matchedFolders.length === 0 &&
              searchResults.matchedPieces.length === 0 ? (
                <div className="flex h-24 items-center justify-center">
                  <p className="text-xs text-muted-foreground">No matching results</p>
                </div>
              ) : (
                <>
                  {searchResults.matchedFolders.map((folder) => (
                    <FolderNode
                      key={folder.id}
                      folder={folder}
                      depth={0}
                      isExpanded={false}
                      onToggleFolder={() => toggleFolder(folder.id)}
                      isRenaming={renamingFolderId === folder.id}
                      onRenameSubmit={(name) => {
                        renameFolder.mutate({ folderId: folder.id, name });
                        setRenamingFolderId(null);
                      }}
                      onRenameCancel={() => setRenamingFolderId(null)}
                      onContextMenu={handleFolderContextMenu}
                      onDropPiece={(pieceId) => handleDropPieceOnFolder(pieceId, folder.id)}
                      onDropFolder={(droppedId) => handleDropFolderOnFolder(droppedId, folder.id)}
                      renderChildren={() => null}
                    />
                  ))}
                  {searchResults.matchedPieces.map((piece) => (
                    <PieceNode
                      key={piece.id}
                      piece={piece}
                      depth={0}
                      isActive={piece.id === activePieceId}
                      isCopying={duplicatingIds.has(piece.id)}
                      isExpanded={expandedIds.has(piece.id)}
                      onToggleExpand={() => toggleExpand(piece.id)}
                      onSelectPiece={() => onSelectPiece(piece.id)}
                      onSelectAsset={(file) => onSelectAsset(piece.id, file)}
                      onRenamePiece={onRenamePiece ? (name) => onRenamePiece(piece.id, name) : undefined}
                      onDropFiles={onUploadFiles ? (files) => onUploadFiles(piece.id, files) : undefined}
                      onAssignFile={(fileId) => assignFile.mutate({ fileId, pieceId: piece.id })}
                      onContextMenu={handleContextMenu}
                      renamingFileId={renamingFileId}
                      onRenameFileSubmit={handleRenameFileSubmit}
                      onRenameFileCancel={handleRenameFileCancel}
                      triggerRename={renamingPieceId === piece.id}
                      onRenameTriggerHandled={() => setRenamingPieceId(null)}
                      innerSort={innerSort}
                      search={search}
                    />
                  ))}
                </>
              )
            ) : folders.length === 0 && pieces.length === 0 ? (
              <div className="flex h-24 items-center justify-center">
                <p className="text-xs text-muted-foreground">No pieces yet</p>
              </div>
            ) : (
              renderLevel(null, 0)
            )}
            <GlobalFilesNode
              onSelectAsset={(file) => onSelectAsset(null, file)}
              onContextMenu={handleContextMenu}
              renamingFileId={renamingFileId}
              onRenameFileSubmit={handleRenameFileSubmit}
              onRenameFileCancel={handleRenameFileCancel}
              onAssignToGlobal={(fileId) => assignFile.mutate({ fileId, pieceId: null })}
              onDropFiles={handleGlobalDropFiles}
              innerSort={innerSort}
              search={search}
            />
          </div>
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <ResourceContextMenu
          state={contextMenu}
          onRename={handleContextMenuRename}
          onDelete={handleContextMenuDelete}
          onNewSubfolder={handleContextMenuNewSubfolder}
          onMoveTo={handleContextMenuMoveTo}
          onDuplicate={handleContextMenuDuplicate}
          onClose={() => setContextMenu(null)}
          folders={folders}
        />
      )}

      {/* Folder delete dialog (non-empty folders) */}
      {deleteDialogFolder && (
        <FolderDeleteDialog
          folderName={deleteDialogFolder.name}
          pieceCount={deleteDialogCounts.pieceCount}
          subfolderCount={deleteDialogCounts.subfolderCount}
          parentName={deleteDialogCounts.parentName}
          onConfirm={(mode) => {
            deleteFolder.mutate({ folderId: deleteDialogFolder.id, mode });
            setDeleteDialogFolderId(null);
          }}
          onCancel={() => setDeleteDialogFolderId(null)}
        />
      )}

      {/* Duplicate dialog (piece or folder) */}
      {duplicateTarget && (
        <DuplicateDialog
          mode={duplicateTarget.mode}
          defaultName={duplicateTarget.defaultName}
          pieceCount={
            duplicateTarget.mode === "folder" ? duplicateTarget.pieceCount : undefined
          }
          onConfirm={({ name, source }) => {
            if (duplicateTarget.mode === "piece") {
              duplicatePiece.mutate({ pieceId: duplicateTarget.id, name, source });
            } else {
              duplicateFolder.mutate({ folderId: duplicateTarget.id, name, source });
            }
            setDuplicateTarget(null);
          }}
          onCancel={() => setDuplicateTarget(null)}
        />
      )}
    </div>
  );
});

export default FileTree;
