"use client";

import { useRef, useState } from "react";
import { ChevronDown, ChevronRight, Film, FolderOpen } from "lucide-react";
import { useExports } from "@/lib/queries/exports";
import { useExportActions } from "@/hooks/exports/use-export-actions";
import { openExportInTab } from "@/hooks/exports/use-open-export";
import { useDismissOnOutside } from "@/hooks/use-dismiss-on-outside";
import { ExportContextMenu, type ExportMenuState } from "@/components/exports/export-context-menu";
import { ExportDeleteDialog } from "@/components/exports/export-delete-dialog";
import { ExportRenameInput } from "@/components/exports/export-rename-input";
import { exportsForTree } from "@/lib/exports/list-view";
import { trackEvent } from "@/lib/analytics/client";
import { revealFile } from "@/lib/shell/client";
import type { ExportRecordView } from "@/lib/exports/types";
import type { SortOption } from "./sort-utils";

interface PieceExportsNodeProps {
  pieceId: string;
  /** The panel's INNER sort (`libi:resources-sort-inner`): created ↔ finish time, a-z ↔ name. */
  innerSort: SortOption;
  search: string;
}

/** `/a/b/c.mp4` → `/a/b` (and `C:\a\c.mp4` → `C:\a`). */
function dirOf(p: string): string {
  return p.slice(0, Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")));
}

/**
 * The "Exports" pseudo-folder under a piece in the resources panel (spec
 * 2026-09-29 §A5): the piece's DONE exports, sorted like the rest of the
 * tree. Not an asset folder — no New subfolder, Move or Duplicate. A click
 * opens the piece's Exports tab on that export.
 */
export default function PieceExportsNode({ pieceId, innerSort, search }: PieceExportsNodeProps) {
  const { data } = useExports(pieceId);
  const actions = useExportActions("resources");
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState<ExportMenuState | null>(null);
  const [folderMenu, setFolderMenu] = useState<{ x: number; y: number } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ExportRecordView | null>(null);

  const rows = exportsForTree(data ?? [], innerSort, search);
  if (rows.length === 0) return null;
  const folderPath = rows.find((r) => r.path)?.path ?? null;
  // A search reveals matches without the user opening the folder.
  const expanded = open || search.trim().length > 0;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onContextMenu={(e) => {
          e.preventDefault();
          setFolderMenu({ x: e.clientX, y: e.clientY });
        }}
        className="group flex w-full cursor-pointer items-center gap-1.5 rounded-md py-0.5 pl-6 pr-1 text-xs text-foreground transition-colors hover:bg-sidebar-accent/60"
      >
        {expanded ? <ChevronDown className="h-3 w-3 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 text-muted-foreground" />}
        <FolderOpen className="h-3.5 w-3.5 text-muted-foreground" />
        <span>Exports</span>
        <span className="ml-auto text-[10px] text-muted-foreground">{rows.length}</span>
      </button>
      {expanded &&
        rows.map((e) =>
          e.id === renamingId ? (
            <div key={e.id} className="flex items-center gap-1.5 py-0.5 pl-12 pr-1">
              <Film className="h-3 w-3 shrink-0 text-muted-foreground" />
              <ExportRenameInput
                initial={e.name}
                onDone={(name) => {
                  setRenamingId(null);
                  if (name !== null && name.trim() && name.trim() !== e.name) void actions.rename(e, name);
                }}
              />
            </div>
          ) : (
            <button
              key={e.id}
              type="button"
              data-testid={`tree-export-${e.id}`}
              title={e.missing ? "Missing file" : (e.fileName ?? e.name)}
              onClick={() => openExportInTab({ pieceId, exportId: e.id })}
              onContextMenu={(ev) => {
                ev.preventDefault();
                setMenu({ x: ev.clientX, y: ev.clientY, exp: e });
              }}
              className={
                "flex w-full cursor-pointer items-center gap-1.5 rounded-md py-0.5 pl-12 pr-1 text-left text-xs transition-colors hover:bg-sidebar-accent/60 " +
                (e.missing ? "text-muted-foreground line-through" : "text-foreground")
              }
            >
              <Film className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="truncate">{e.name}</span>
            </button>
          ),
        )}
      {menu && (
        <ExportContextMenu
          state={menu}
          revealLabel={actions.revealLabel}
          onPost={actions.post}
          onReveal={(e) => void actions.reveal(e)}
          onCopy={(e) => void actions.copy(e)}
          onRename={(e) => {
            setOpen(true);
            setRenamingId(e.id);
          }}
          onDelete={setPendingDelete}
          onClose={() => setMenu(null)}
        />
      )}
      {folderMenu && folderPath && (
        <FolderMenu
          x={folderMenu.x}
          y={folderMenu.y}
          label={actions.revealLabel}
          onReveal={() => {
            trackEvent("export_action", { action: "reveal", surface: "resources" });
            void revealFile(dirOf(folderPath)).catch(() => {});
          }}
          onClose={() => setFolderMenu(null)}
        />
      )}
      <ExportDeleteDialog
        exp={pendingDelete}
        onCancel={() => setPendingDelete(null)}
        onConfirm={(e) => {
          // Clear the target BEFORE the delete: the dialog does not close itself.
          setPendingDelete(null);
          void actions.remove(e);
        }}
      />
    </div>
  );
}

function FolderMenu({ x, y, label, onReveal, onClose }: { x: number; y: number; label: string; onReveal: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismissOnOutside(ref, onClose);
  return (
    <div ref={ref} role="menu" className="fixed z-50 min-w-[160px] rounded-lg border border-border bg-popover p-1 shadow-md" style={{ left: x, top: y }}>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onClose();
          onReveal();
        }}
        className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent"
      >
        <FolderOpen className="h-3.5 w-3.5" />
        {label}
      </button>
    </div>
  );
}
