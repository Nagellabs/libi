"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { formatTimecode } from "@/lib/utils/format";
import type { Shot } from "@/lib/analysis/types";

function activeShotIndex(shots: Shot[], t: number): number | null {
  for (const s of shots) {
    if (t >= s.start && t < s.end) return s.index;
  }
  return null;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

interface Props {
  shots: Shot[];
  selectedIdx: number;
  currentTime: number;
  onSelect: (idx: number) => void;
  onSeek: (t: number) => void;
}

export function ScriptShotRail({
  shots,
  selectedIdx,
  currentTime,
  onSelect,
  onSeek,
}: Props) {
  const playingIdx = activeShotIndex(shots, currentTime);
  const playingRowRef = useRef<HTMLButtonElement | null>(null);

  // Scroll the playing row into view when it changes.
  useEffect(() => {
    if (playingIdx == null) return;
    playingRowRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
    });
  }, [playingIdx]);

  return (
    <div className="flex h-full flex-col overflow-auto">
      <div className="sticky top-0 z-10 border-b border-border bg-muted/80 px-3 py-2 text-[10px] uppercase tracking-wide text-muted-foreground backdrop-blur">
        Shots ({shots.length})
      </div>
      <ul className="flex flex-col">
        {shots.map((s) => {
          const isPlaying = s.index === playingIdx;
          const isSelected = s.index === selectedIdx;
          return (
            <li key={s.index}>
              <button
                ref={isPlaying ? playingRowRef : undefined}
                type="button"
                onClick={() => {
                  onSelect(s.index);
                  onSeek(s.start);
                }}
                className={cn(
                  "cursor-pointer flex w-full flex-col items-start gap-0.5 border-b border-border/50 px-3 py-2 text-left transition-colors hover:bg-surface-hover",
                  isSelected && "bg-primary/10",
                )}
                aria-selected={isSelected}
              >
                <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                  {isPlaying && <span aria-hidden>▶</span>}
                  <span>
                    {s.index + 1} · {formatTimecode(s.start)}–{formatTimecode(s.end)}
                  </span>
                </div>
                <div className="text-[11px] text-muted-foreground line-clamp-1">
                  {truncate(s.description, 80)}
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
