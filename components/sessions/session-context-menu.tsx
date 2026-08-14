"use client";

import { useRef, useEffect, useState } from "react";
import { Copy } from "lucide-react";

export interface SessionContextMenuState {
  x: number;
  y: number;
  sessionId: string;
}

interface SessionContextMenuProps {
  state: SessionContextMenuState;
  onCopyId: () => void;
}

export default function SessionContextMenu({ state, onCopyId }: SessionContextMenuProps) {
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
      className="fixed z-50 min-w-[160px] rounded-lg border border-border bg-popover p-1 shadow-md"
      style={{ top: position.top, left: position.left }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        onClick={onCopyId}
        className="cursor-pointer flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground transition-colors hover:bg-accent"
      >
        <Copy className="h-3.5 w-3.5" />
        Copy session ID
      </button>
    </div>
  );
}
