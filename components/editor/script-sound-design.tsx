"use client";

import { formatTimecode } from "@/lib/utils/format";

interface Entry {
  timestamp: number;
  description: string;
}

interface Props {
  entries: Entry[];
  onSeek: (t: number) => void;
}

export function ScriptSoundDesign({ entries, onSeek }: Props) {
  if (entries.length === 0) return null;
  return (
    <div className="border-t border-border bg-muted/30">
      <div className="px-4 py-2 text-[10px] uppercase tracking-wide text-muted-foreground">
        Sound Design ({entries.length})
      </div>
      <ul className="flex max-h-32 flex-col overflow-auto">
        {entries.map((e, i) => (
          <li key={i}>
            <button
              type="button"
              onClick={() => onSeek(e.timestamp)}
              className="cursor-pointer flex w-full items-baseline gap-3 px-4 py-1.5 text-left text-xs hover:bg-surface-hover"
            >
              <span className="font-mono text-muted-foreground">
                {formatTimecode(e.timestamp)}
              </span>
              <span className="text-foreground">{e.description}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
