"use client";

import { memo, useRef } from "react";
import { X, Upload, FolderPlus } from "lucide-react";
import { useReactRenderTelemetry } from "@/lib/preview/telemetry";
import type { FileRecord } from "@/lib/db/schema/types";
import { useGlobalUpload } from "@/lib/queries/files";
import FileTree, { type FileTreeHandle } from "./file-tree";
import { PieceMark } from "./piece-mark";

interface ResourcesPanelProps {
  activePieceId: string | null;
  onSelectPiece: (pieceId: string) => void;
  onSelectAsset: (pieceId: string | null, file: FileRecord) => void;
  onDeletePiece?: (pieceId: string) => void;
  onRenamePiece?: (pieceId: string, name: string) => void;
  onUploadFiles?: (pieceId: string, files: File[]) => void;
  /** Folder reveal request (from libi.show_folder). `nonce` re-fires repeats. */
  revealFolder?: { id: string; nonce: number } | null;
  onClose: () => void;
}

function ResourcesPanel({
  activePieceId,
  onSelectPiece,
  onSelectAsset,
  onDeletePiece,
  onRenamePiece,
  onUploadFiles,
  revealFolder,
  onClose,
}: ResourcesPanelProps) {
  useReactRenderTelemetry("ResourcesPanel");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileTreeRef = useRef<FileTreeHandle>(null);
  const { upload, isUploading } = useGlobalUpload();

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  const handleFilesSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = e.target.files;
    if (!selectedFiles) return;
    for (const file of Array.from(selectedFiles)) {
      await upload(file);
    }
    // Reset input so the same file can be re-selected
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-sidebar-border px-3.5 py-3">
        <PieceMark className="size-3.5 text-primary" />
        <span className="text-[12px] font-semibold uppercase tracking-[0.1em] text-sidebar-foreground">
          Resources
        </span>
        <div className="flex-1" />
        <button
          onClick={() => fileTreeRef.current?.createFolder()}
          title="New folder"
          className="cursor-pointer grid size-[22px] place-items-center rounded-md bg-[color:var(--accent-soft)] text-primary transition-colors hover:brightness-110"
        >
          <FolderPlus className="h-3 w-3" strokeWidth={2} />
        </button>
        <button
          onClick={onClose}
          aria-label="Close resources panel"
          className="cursor-pointer grid size-[22px] place-items-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent"
        >
          <X className="h-3 w-3" />
        </button>
      </div>

      {/* Hidden file input */}
      <input
        data-testid="resources-upload-input"
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFilesSelected}
      />

      {/* File tree */}
      <div className="flex-1 overflow-hidden">
        <FileTree
          ref={fileTreeRef}
          activePieceId={activePieceId}
          onSelectPiece={onSelectPiece}
          onSelectAsset={onSelectAsset}
          onDeletePiece={onDeletePiece ?? (() => {})}
          onRenamePiece={onRenamePiece}
          onUploadFiles={onUploadFiles}
          revealFolder={revealFolder}
        />
      </div>

      {/* Drop zone */}
      <button
        type="button"
        onClick={handleUploadClick}
        disabled={isUploading}
        className="cursor-pointer m-2.5 flex flex-col items-center justify-center gap-1 rounded-md border border-dashed border-sidebar-border bg-card px-3 py-3 text-[11.5px] text-muted-foreground transition-colors hover:border-primary/40 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <Upload className="size-3.5" />
        <span>
          Drop files or{" "}
          <span className="font-medium text-primary">browse</span>
        </span>
      </button>
    </div>
  );
}

/**
 * Memoized so the editor's 30 Hz playback re-render (driven by `transport.frame`)
 * does NOT reconcile the resources file tree every frame. Props from the editor
 * page are referentially stable on a frame tick (useCallback handlers + the
 * `revealFolder` useState object), so the shallow compare bails. See the same
 * rationale on `ChatPanel` and `lib/preview/telemetry.ts`.
 */
export default memo(ResourcesPanel);
