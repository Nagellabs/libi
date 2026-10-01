"use client";

import { useRef, useState } from "react";

/**
 * The inline name field for renaming an export — the Exports tab's row and the
 * resources panel's tree row share it. Enter or blur commits (`onDone(value)`),
 * Escape cancels (`onDone(null)`); the caller decides whether the name changed.
 */
export function ExportRenameInput({
  initial,
  onDone,
  className = "min-w-0 flex-1 rounded border border-accent bg-background px-1 py-0 text-xs outline-none",
}: {
  initial: string;
  onDone: (name: string | null) => void;
  className?: string;
}) {
  const [value, setValue] = useState(initial);
  // Enter commits, then the blur that follows must not commit again.
  const settled = useRef(false);
  const finish = (name: string | null) => {
    if (settled.current) return;
    settled.current = true;
    onDone(name);
  };
  return (
    <input
      autoFocus
      aria-label="Export name"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(value);
        if (e.key === "Escape") finish(null);
      }}
      className={className}
    />
  );
}
