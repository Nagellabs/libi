"use client";

import { useEffect, useRef, useState } from "react";
import { FileText, History } from "lucide-react";

interface DuplicateDialogProps {
  mode: "piece" | "folder";
  /** Pre-resolved "<source> (copy)" name. */
  defaultName: string;
  /** Folder mode: how many pieces will be copied. */
  pieceCount?: number;
  onConfirm: (opts: { name: string; source: "draft" | "snapshot" }) => void;
  onCancel: () => void;
}

export default function DuplicateDialog({
  mode,
  defaultName,
  pieceCount,
  onConfirm,
  onCancel,
}: DuplicateDialogProps) {
  const [name, setName] = useState(defaultName);
  const [source, setSource] = useState<"draft" | "snapshot">("draft");
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus + select the name input when the dialog opens.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const title = mode === "piece" ? "Duplicate piece" : "Duplicate folder";

  const handleConfirm = () => {
    onConfirm({ name: name.trim() || defaultName, source });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onCancel}
    >
      <div
        className="w-96 rounded-lg border border-border bg-surface p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-1 text-sm font-semibold">{title}</h3>
        <p className="mb-3 text-xs text-muted-foreground">
          {mode === "piece"
            ? "Creates an independent copy. Editing the copy never affects the original."
            : "Clones the folder and every piece inside it into independent copies."}
        </p>

        <label className="mb-1 block text-[11px] font-medium text-muted-foreground">
          Name
        </label>
        <input
          ref={inputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleConfirm();
            if (e.key === "Escape") onCancel();
          }}
          className="mb-3 w-full rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground outline-none transition-colors focus:border-primary/40"
        />

        <span className="mb-1.5 block text-[11px] font-medium text-muted-foreground">
          Copy from
        </span>
        <div className="space-y-2">
          <label
            className={`flex cursor-pointer items-start gap-2.5 rounded-md border p-2.5 transition-colors ${
              source === "draft"
                ? "border-primary/50 bg-[color:var(--accent-soft)]"
                : "border-border hover:border-primary/30"
            }`}
          >
            <input
              type="radio"
              name="duplicate-source"
              checked={source === "draft"}
              onChange={() => setSource("draft")}
              className="mt-0.5 cursor-pointer accent-primary"
            />
            <span className="flex flex-1 flex-col gap-0.5">
              <span className="flex items-center gap-1.5 text-xs font-medium">
                <FileText className="h-3.5 w-3.5 text-primary" />
                Current draft
              </span>
              <span className="text-[11px] text-muted-foreground">
                Copies the current working state, including uncommitted changes.
              </span>
            </span>
          </label>

          <label
            className={`flex cursor-pointer items-start gap-2.5 rounded-md border p-2.5 transition-colors ${
              source === "snapshot"
                ? "border-primary/50 bg-[color:var(--accent-soft)]"
                : "border-border hover:border-primary/30"
            }`}
          >
            <input
              type="radio"
              name="duplicate-source"
              checked={source === "snapshot"}
              onChange={() => setSource("snapshot")}
              className="mt-0.5 cursor-pointer accent-primary"
            />
            <span className="flex flex-1 flex-col gap-0.5">
              <span className="flex items-center gap-1.5 text-xs font-medium">
                <History className="h-3.5 w-3.5 text-primary" />
                Current snapshot
              </span>
              <span className="text-[11px] text-muted-foreground">
                Copies the last committed snapshot, excluding draft changes.
              </span>
            </span>
          </label>
        </div>

        {mode === "folder" && pieceCount !== undefined && (
          <p className="mt-3 text-xs text-muted-foreground">
            {pieceCount} piece{pieceCount === 1 ? "" : "s"} will be copied.
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="cursor-pointer rounded border border-border px-3 py-1 text-xs hover:bg-surface-hover"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            className="cursor-pointer rounded bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/80"
          >
            Duplicate
          </button>
        </div>
      </div>
    </div>
  );
}
