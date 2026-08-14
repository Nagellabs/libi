"use client";

import { useEffect, useRef } from "react";
import type { PaletteCommand } from "@/lib/chat/slash-commands";

interface CommandPaletteProps {
  commands: PaletteCommand[];
  selectedIndex: number;
  /** Insert the command into the composer input. */
  onPick: (command: PaletteCommand) => void;
  onHoverIndex: (index: number) => void;
}

/**
 * Dumb list popup anchored above the composer. All state (open/closed,
 * selection, keyboard) lives in ChatComposer — this only renders rows.
 */
export default function CommandPalette({
  commands,
  selectedIndex,
  onPick,
  onHoverIndex,
}: CommandPaletteProps) {
  const selectedRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (commands.length === 0) return null;

  return (
    <div className="absolute bottom-full left-0 right-0 z-20 mb-2 max-h-64 overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-lg">
      {commands.map((command, i) => (
        <button
          key={command.name}
          ref={i === selectedIndex ? selectedRef : undefined}
          type="button"
          // preventDefault on mousedown keeps the textarea focused.
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(command);
          }}
          onMouseEnter={() => onHoverIndex(i)}
          // NB: bg-accent / bg-surface-hover are byte-identical to bg-popover
          // in the dark theme (#222528) — a highlight built on them renders
          // invisible. bg-primary is the only token with real contrast here.
          className={`flex w-full cursor-pointer flex-col gap-0.5 rounded-lg px-2.5 py-1.5 text-left text-sm ${
            i === selectedIndex
              ? "bg-primary/15"
              : "hover:bg-primary/10"
          }`}
        >
          <span className="flex items-baseline gap-2">
            <span className="font-mono text-foreground">/{command.name}</span>
            {command.inputHint ? (
              <span className="text-xs italic text-muted-foreground/70">
                {command.inputHint}
              </span>
            ) : null}
          </span>
          {command.description ? (
            <span className="line-clamp-1 text-xs text-muted-foreground">
              {command.description}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
