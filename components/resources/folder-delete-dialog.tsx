"use client";

import { useState } from "react";
import { FolderOpen, Trash2 } from "lucide-react";

interface FolderDeleteDialogProps {
  folderName: string;
  /** Pieces in the whole subtree. */
  pieceCount: number;
  /** Sub-folders in the whole subtree. */
  subfolderCount: number;
  /** Name of the parent ("Root" when null). */
  parentName: string | null;
  onConfirm: (mode: "orphan" | "cascade") => void;
  onCancel: () => void;
}

export default function FolderDeleteDialog({
  folderName,
  pieceCount,
  subfolderCount,
  parentName,
  onConfirm,
  onCancel,
}: FolderDeleteDialogProps) {
  const [mode, setMode] = useState<"orphan" | "cascade">("orphan");

  const parentLabel = parentName ?? "Root";
  const cascadeParts: string[] = [];
  if (pieceCount > 0) {
    cascadeParts.push(`${pieceCount} piece${pieceCount === 1 ? "" : "s"}`);
  }
  if (subfolderCount > 0) {
    cascadeParts.push(`${subfolderCount} sub-folder${subfolderCount === 1 ? "" : "s"}`);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onCancel}
    >
      <div
        className="w-96 rounded-lg border border-border bg-surface p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-1 text-sm font-semibold">
          Delete &ldquo;{folderName}&rdquo;
        </h3>
        <p className="mb-4 text-xs text-muted-foreground">
          This folder isn&rsquo;t empty. Choose what happens to its contents.
        </p>

        <div className="space-y-2">
          <label
            className={`flex cursor-pointer items-start gap-2.5 rounded-md border p-2.5 transition-colors ${
              mode === "orphan"
                ? "border-primary/50 bg-[color:var(--accent-soft)]"
                : "border-border hover:border-primary/30"
            }`}
          >
            <input
              type="radio"
              name="folder-delete-mode"
              checked={mode === "orphan"}
              onChange={() => setMode("orphan")}
              className="mt-0.5 cursor-pointer accent-primary"
            />
            <span className="flex flex-1 flex-col gap-0.5">
              <span className="flex items-center gap-1.5 text-xs font-medium">
                <FolderOpen className="h-3.5 w-3.5 text-primary" />
                Move contents to {parentLabel}
              </span>
              <span className="text-[11px] text-muted-foreground">
                Pieces and sub-folders move up to {parentLabel}; only this folder
                is removed.
              </span>
            </span>
          </label>

          <label
            className={`flex cursor-pointer items-start gap-2.5 rounded-md border p-2.5 transition-colors ${
              mode === "cascade"
                ? "border-destructive/50 bg-destructive/10"
                : "border-border hover:border-destructive/30"
            }`}
          >
            <input
              type="radio"
              name="folder-delete-mode"
              checked={mode === "cascade"}
              onChange={() => setMode("cascade")}
              className="mt-0.5 cursor-pointer accent-[var(--destructive)]"
            />
            <span className="flex flex-1 flex-col gap-0.5">
              <span className="flex items-center gap-1.5 text-xs font-medium text-destructive">
                <Trash2 className="h-3.5 w-3.5" />
                Delete the folder and everything inside
              </span>
              <span className="text-[11px] text-muted-foreground">
                Permanently deletes{" "}
                {cascadeParts.length > 0 ? cascadeParts.join(" and ") : "this folder"}
                . This cannot be undone.
              </span>
            </span>
          </label>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="cursor-pointer rounded border border-border px-3 py-1 text-xs hover:bg-surface-hover"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(mode)}
            className="cursor-pointer rounded bg-destructive px-3 py-1 text-xs text-destructive-foreground hover:bg-destructive/80"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
