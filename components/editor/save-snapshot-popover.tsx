"use client";

import { useRef, useState, type FormEvent } from "react";
import { ChevronDown } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

interface SaveSnapshotPopoverProps {
  onSave: (summary: string) => void;
  disabled?: boolean;
}

/**
 * Caret-dropdown portion of the split Save button.
 * Opens a small popover with a text input so the user can type a custom
 * snapshot name. On submit the caller receives the typed summary (or
 * "Manual edits" if left empty) via `onSave`.
 */
export function SaveSnapshotPopover({ onSave, disabled }: SaveSnapshotPopoverProps) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const summary = value.trim() || "Manual edits";
    onSave(summary);
    setValue("");
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        aria-label="Save with custom name"
        title="Save with custom name…"
        className="cursor-pointer inline-flex items-center justify-center border-l border-current/20 px-2 text-primary-foreground opacity-90 transition hover:opacity-100 hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="bottom"
        sideOffset={6}
        className="w-80 gap-0 p-0"
      >
        <form onSubmit={handleSubmit} className="flex flex-col">
          <div className="border-b border-border px-4 py-3">
            <h3 className="text-sm font-semibold text-foreground">
              Name this snapshot
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Skip the agent — save with the name you provide.
            </p>
          </div>
          <div className="flex flex-col gap-3 px-4 py-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-foreground">Snapshot name</span>
              <input
                ref={inputRef}
                type="text"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="e.g. Pre-music edit"
                autoFocus
                className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground placeholder-muted-foreground/50 outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20"
              />
            </label>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="cursor-pointer h-8 rounded-md px-3 text-sm font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="cursor-pointer h-8 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
              >
                Save snapshot
              </button>
            </div>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
