"use client";

import { useRef } from "react";
import { Copy, FolderOpen, Pencil, Send, Trash2 } from "lucide-react";
import { useDismissOnOutside } from "@/hooks/use-dismiss-on-outside";
import type { ExportRecordView } from "@/lib/exports/types";

export interface ExportMenuState {
  x: number;
  y: number;
  exp: ExportRecordView;
}

interface Props {
  state: ExportMenuState;
  revealLabel: string;
  /** Open the piece's Posting tab with the composer started on this export. */
  onPost: (e: ExportRecordView) => void;
  onReveal: (e: ExportRecordView) => void;
  onCopy: (e: ExportRecordView) => void;
  onRename: (e: ExportRecordView) => void;
  /** Opens the confirm — the menu never deletes by itself. */
  onDelete: (e: ExportRecordView) => void;
  onClose: () => void;
}

const ITEM =
  "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent";

/** The actions on one export (spec §A6, plus Post…) — the Exports tab and the resources panel share it. */
export function ExportContextMenu({ state, revealLabel, onPost, onReveal, onCopy, onRename, onDelete, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useDismissOnOutside(ref, onClose);

  const run = (fn: (e: ExportRecordView) => void) => () => {
    onClose();
    fn(state.exp);
  };
  const missing = state.exp.missing;

  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-50 min-w-[180px] rounded-lg border border-border bg-popover p-1 shadow-md"
      style={{ left: state.x, top: state.y }}
    >
      {missing ? (
        <div className="px-2 py-1 text-xs text-amber-600 dark:text-amber-400">Missing file</div>
      ) : (
        <>
          <button type="button" role="menuitem" className={ITEM} onClick={run(onPost)}>
            <Send className="h-3.5 w-3.5" />
            Post…
          </button>
          <button type="button" role="menuitem" className={ITEM} onClick={run(onReveal)}>
            <FolderOpen className="h-3.5 w-3.5" />
            {revealLabel}
          </button>
          <button type="button" role="menuitem" className={ITEM} onClick={run(onCopy)}>
            <Copy className="h-3.5 w-3.5" />
            Copy
          </button>
          <button type="button" role="menuitem" className={ITEM} onClick={run(onRename)}>
            <Pencil className="h-3.5 w-3.5" />
            Rename
          </button>
        </>
      )}
      <button type="button" role="menuitem" className={`${ITEM} text-destructive`} onClick={run(onDelete)}>
        <Trash2 className="h-3.5 w-3.5" />
        Delete…
      </button>
    </div>
  );
}
