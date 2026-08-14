"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Folder, FolderPlus, FolderInput, Pencil, Trash2 } from "lucide-react";
import type { AssetFolderRecord, FileRecord } from "@/lib/db/schema/types";
import {
  useAssetLevel,
  useAssetFolderList,
  useCreateAssetFolder,
  useRenameAssetFolder,
  useMoveAssetFolder,
  useDeleteAssetFolder,
  useMoveAsset,
} from "@/lib/queries/asset-folders";
import { getAncestorIds } from "@/lib/folders/tree";
import { useEditorState } from "@/lib/editor-state-context";
import { AssetThumbnail } from "./asset-thumbnail";
import { AssetBreadcrumb } from "./asset-breadcrumb";
import { Button } from "@/components/ui/button";

const DND_MIME = "application/x-libi-asset";

type DragPayload = { kind: "folder" | "asset"; id: string };

type MenuState =
  | { x: number; y: number; type: "folder"; id: string; name: string }
  | { x: number; y: number; type: "asset"; id: string; name: string };

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

export function AssetExplorer({
  pieceId,
  onSelect,
}: {
  pieceId: string;
  onSelect: (f: FileRecord) => void;
}) {
  const { assetCurrentFolderId, setAssetCurrentFolderId } = useEditorState();
  const [menu, setMenu] = useState<MenuState | null>(null);
  // Inline-edit state (replaces window.prompt for create + rename).
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const { data } = useAssetLevel(pieceId, assetCurrentFolderId);
  const { data: allFolders = [] } = useAssetFolderList(pieceId);

  // Derive the breadcrumb chain from the current folder id so it survives the
  // explorer unmounting (which happens whenever the editor enters asset mode).
  // Local path state would reset on every unmount, losing a deep breadcrumb.
  const path: AssetFolderRecord[] = useMemo(() => {
    if (!assetCurrentFolderId) return [];
    const byId = new Map(allFolders.map((f) => [f.id, f]));
    const ancestors = getAncestorIds(assetCurrentFolderId, allFolders).reverse(); // root-first
    const chain = [...ancestors, assetCurrentFolderId];
    return chain.map((id) => byId.get(id)).filter(Boolean) as AssetFolderRecord[];
  }, [assetCurrentFolderId, allFolders]);
  const createFolder = useCreateAssetFolder(pieceId);
  const renameFolder = useRenameAssetFolder(pieceId);
  const moveFolder = useMoveAssetFolder(pieceId);
  const deleteFolder = useDeleteAssetFolder(pieceId);
  const moveAsset = useMoveAsset(pieceId);

  // Dismiss the context menu on any outside click or Escape.
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

  function enter(folder: AssetFolderRecord & { assetCount: number }) {
    setAssetCurrentFolderId(folder.id);
  }
  function jump(folderId: string | null) {
    setAssetCurrentFolderId(folderId);
  }
  async function commitNewFolder(raw: string) {
    setCreatingFolder(false);
    const name = raw.trim();
    if (!name) return;
    await createFolder.mutateAsync({
      name,
      parentFolderId: assetCurrentFolderId ?? undefined,
    });
  }

  // --- Drag-and-drop helpers -------------------------------------------------

  function onTileDragStart(
    e: React.DragEvent,
    kind: "folder" | "asset",
    id: string,
  ) {
    e.dataTransfer.setData(DND_MIME, JSON.stringify({ kind, id }));
    e.dataTransfer.effectAllowed = "move";
  }

  /** Move a dragged item to the given target folder (null = root). */
  async function dropOnFolder(targetFolderId: string | null, e: React.DragEvent) {
    e.preventDefault();
    const payload = readDragPayload(e);
    if (!payload) return;
    try {
      if (payload.kind === "asset") {
        await moveAsset.mutateAsync({ fileId: payload.id, folderId: targetFolderId });
      } else {
        // No-op + cycle guard: dropping a folder onto itself, or a cycle the
        // server rejects, should never crash the UI.
        if (payload.id === targetFolderId) return;
        await moveFolder.mutateAsync({
          folderId: payload.id,
          parentFolderId: targetFolderId,
        });
      }
    } catch {
      // Swallow rejected moves (e.g. server-side cycle rejection).
    }
  }

  // --- Context-menu actions --------------------------------------------------

  function menuRenameFolder(folderId: string) {
    setMenu(null);
    setRenamingFolderId(folderId); // switches the tile to an inline input
  }
  async function commitRenameFolder(folder: AssetFolderRecord, raw: string) {
    setRenamingFolderId(null);
    const name = raw.trim();
    if (name && name !== folder.name) {
      await renameFolder.mutateAsync({ folderId: folder.id, name });
    }
  }
  async function menuMoveFolderToRoot(folderId: string) {
    setMenu(null);
    try {
      await moveFolder.mutateAsync({ folderId, parentFolderId: null });
    } catch {
      /* swallow */
    }
  }
  async function menuDeleteFolder(folderId: string) {
    setMenu(null);
    await deleteFolder.mutateAsync({ folderId, mode: "orphan" });
  }
  async function menuDeleteFolderCascade(folderId: string) {
    setMenu(null);
    if (
      !window.confirm(
        "Delete this folder AND everything inside it? This cannot be undone.",
      )
    ) {
      return;
    }
    await deleteFolder.mutateAsync({ folderId, mode: "cascade", confirm: true });
  }
  async function menuMoveAssetToRoot(fileId: string) {
    setMenu(null);
    try {
      await moveAsset.mutateAsync({ fileId, folderId: null });
    } catch {
      /* swallow */
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border">
        <AssetBreadcrumb path={path} onJump={jump} onDropFolder={dropOnFolder} />
        <Button
          size="sm"
          variant="ghost"
          className="cursor-pointer mr-2"
          onClick={() => setCreatingFolder(true)}
        >
          <FolderPlus className="size-4 mr-1" /> New folder
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-3 overflow-auto p-3 sm:grid-cols-3 lg:grid-cols-4">
        {creatingFolder && (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-border p-4">
            <Folder className="size-10 text-amber-400" />
            <FolderNameInput
              placeholder="Folder name"
              onCommit={commitNewFolder}
              onCancel={() => setCreatingFolder(false)}
            />
            <span className="text-xs text-muted-foreground">New folder</span>
          </div>
        )}
        {data?.folders.map((f) =>
          renamingFolderId === f.id ? (
            <div
              key={f.id}
              className="flex flex-col items-center gap-2 rounded-lg border border-border p-4"
            >
              <Folder className="size-10 text-amber-400" />
              <FolderNameInput
                initial={f.name}
                onCommit={(name) => commitRenameFolder(f, name)}
                onCancel={() => setRenamingFolderId(null)}
              />
              <span className="text-xs text-muted-foreground">
                {f.assetCount} asset{f.assetCount === 1 ? "" : "s"}
              </span>
            </div>
          ) : (
            <button
              key={f.id}
              type="button"
              aria-label={`Open folder ${f.name}`}
              draggable
              onClick={() => enter(f)}
              onDragStart={(e) => onTileDragStart(e, "folder", f.id)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => dropOnFolder(f.id, e)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({
                  x: e.clientX,
                  y: e.clientY,
                  type: "folder",
                  id: f.id,
                  name: f.name,
                });
              }}
              className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-border p-4 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Folder className="size-10 text-amber-400" />
              <span className="line-clamp-1 text-sm font-medium">{f.name}</span>
              <span className="text-xs text-muted-foreground">
                {f.assetCount} asset{f.assetCount === 1 ? "" : "s"}
              </span>
            </button>
          ),
        )}
        {data?.assets.map((file) => (
          <button
            key={file.id}
            type="button"
            aria-label={`Open ${file.name || file.filename}`}
            draggable
            onClick={() => onSelect(file)}
            onDragStart={(e) => onTileDragStart(e, "asset", file.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({
                x: e.clientX,
                y: e.clientY,
                type: "asset",
                id: file.id,
                name: file.name || file.filename,
              });
            }}
            className="cursor-pointer rounded-lg border border-border p-2 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <AssetThumbnail file={file} />
            <div className="mt-1 line-clamp-1 text-sm">
              {file.name || file.filename}
            </div>
          </button>
        ))}
        {data && data.folders.length === 0 && data.assets.length === 0 && (
          <div className="col-span-full py-12 text-center text-sm text-muted-foreground">
            This folder is empty.
          </div>
        )}
      </div>

      {menu && (
        <div
          className="fixed z-50 min-w-[180px] rounded-lg border border-border bg-popover p-1 shadow-md"
          style={{ top: menu.y, left: menu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          {menu.type === "folder" ? (
            <>
              <button
                type="button"
                onClick={() => menuRenameFolder(menu.id)}
                className="cursor-pointer flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground transition-colors hover:bg-accent"
              >
                <Pencil className="h-3.5 w-3.5" />
                Rename
              </button>
              <button
                type="button"
                onClick={() => menuMoveFolderToRoot(menu.id)}
                className="cursor-pointer flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground transition-colors hover:bg-accent"
              >
                <FolderInput className="h-3.5 w-3.5" />
                Move to root
              </button>
              <button
                type="button"
                onClick={() => menuDeleteFolder(menu.id)}
                className="cursor-pointer flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-destructive transition-colors hover:bg-destructive/10"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </button>
              <button
                type="button"
                onClick={() => menuDeleteFolderCascade(menu.id)}
                className="cursor-pointer flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-destructive transition-colors hover:bg-destructive/10"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete with contents
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => menuMoveAssetToRoot(menu.id)}
              className="cursor-pointer flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground transition-colors hover:bg-accent"
            >
              <FolderInput className="h-3.5 w-3.5" />
              Move to root
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Inline folder-name input for create + rename. Auto-focuses, commits on
 *  Enter or blur, cancels on Escape. A one-shot guard prevents Enter→blur from
 *  firing the commit twice. */
function FolderNameInput({
  initial = "",
  placeholder,
  onCommit,
  onCancel,
}: {
  initial?: string;
  placeholder?: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const commit = () => {
    if (done.current) return;
    done.current = true;
    onCommit(value);
  };
  const cancel = () => {
    if (done.current) return;
    done.current = true;
    onCancel();
  };

  return (
    <input
      ref={ref}
      value={value}
      placeholder={placeholder}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        }
      }}
      onBlur={commit}
      className="w-full rounded border border-accent bg-background px-1.5 py-0.5 text-center text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
    />
  );
}
