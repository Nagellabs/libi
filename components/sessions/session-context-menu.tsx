"use client";

import { useRef, useEffect, useState } from "react";
import { Copy, LoaderCircle, RotateCcw } from "lucide-react";

export interface SessionContextMenuState {
  x: number;
  y: number;
  sessionId: string;
}

interface SessionContextMenuProps {
  state: SessionContextMenuState;
  onCopyId: () => void;
  /** "Restart session" — passed only for a chat a restart applies to (an agent chat: Claude Code,
   *  Codex). Absent → no item. */
  onRestart?: () => void;
  /** This chat's restart is already running: the item names the wait instead. */
  restarting?: boolean;
}

const ITEM_CLASS =
  "cursor-pointer flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground transition-colors hover:bg-accent";

export default function SessionContextMenu({ state, onCopyId, onRestart, restarting = false }: SessionContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: state.y, left: state.x });

  useEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const top = Math.min(state.y, window.innerHeight - rect.height - 8);
    const left = Math.min(state.x, window.innerWidth - rect.width - 8);
    setPosition({ top: Math.max(0, top), left: Math.max(0, left) });
  }, [state.x, state.y]);

  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-50 min-w-[160px] rounded-lg border border-border bg-popover p-1 shadow-md"
      style={{ top: position.top, left: position.left }}
      onClick={(e) => e.stopPropagation()}
    >
      <button role="menuitem" onClick={onCopyId} className={ITEM_CLASS}>
        <Copy className="h-3.5 w-3.5" />
        Copy session ID
      </button>
      {onRestart && (
        <button
          role="menuitem"
          aria-disabled={restarting || undefined}
          onClick={restarting ? undefined : onRestart}
          className={`${ITEM_CLASS} aria-disabled:pointer-events-none aria-disabled:opacity-80`}
        >
          {restarting ? (
            <LoaderCircle aria-hidden className="h-3.5 w-3.5 motion-safe:animate-spin" />
          ) : (
            <RotateCcw className="h-3.5 w-3.5" />
          )}
          {restarting ? "Restarting…" : "Restart session"}
        </button>
      )}
    </div>
  );
}
