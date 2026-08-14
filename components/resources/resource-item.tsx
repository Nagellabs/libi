"use client";

import { useState, useRef } from "react";
import type { FileRecord } from "@/lib/db/schema/types";
import { formatFileSize } from "@/lib/utils/format";
import ResourcePreview from "./resource-preview";

interface ResourceItemProps {
  file: FileRecord;
  pieceId: string;
  isSelected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}

function formatRelativeTime(date: Date | string | null): string {
  if (!date) return "";
  const d = typeof date === "string" ? new Date(date) : date;
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: "long" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function getTypeIcon(contentType: string | null): string {
  const ct = contentType ?? "";
  if (ct.startsWith("image/")) return "\uD83D\uDDBC";
  if (ct.startsWith("video/")) return "\uD83C\uDFAC";
  if (ct.startsWith("audio/")) return "\uD83C\uDFB5";
  if (ct === "application/pdf") return "\uD83D\uDCC4";
  if (ct.startsWith("text/") || ct === "application/json") return "\uD83D\uDCDD";
  return "\uD83D\uDCCE";
}

export default function ResourceItem({
  file,
  pieceId,
  isSelected,
  onSelect,
  onDelete,
}: ResourceItemProps) {
  // The anchor rect is measured HERE, in the hover timer (an event-handler
  // context, where reading refs is allowed), so the preview component can
  // derive its position purely from props.
  const [previewRect, setPreviewRect] = useState<DOMRect | null>(null);
  const hoverTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const itemRef = useRef<HTMLDivElement>(null);

  const handleMouseEnter = () => {
    hoverTimeout.current = setTimeout(() => {
      setPreviewRect(itemRef.current?.getBoundingClientRect() ?? null);
    }, 300);
  };

  const handleMouseLeave = () => {
    if (hoverTimeout.current) clearTimeout(hoverTimeout.current);
    setPreviewRect(null);
  };

  return (
    <div
      ref={itemRef}
      className={`group relative cursor-pointer rounded px-2 py-1.5 transition-colors ${
        isSelected
          ? "bg-primary/10 border-l-2 border-primary"
          : "hover:bg-surface-hover"
      }`}
      onClick={onSelect}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Line 1: icon + filename */}
      <div className="flex items-center gap-1.5">
        <span className="text-xs">{getTypeIcon(file.contentType)}</span>
        <span className="flex-1 truncate text-xs font-medium text-foreground">
          {file.name || file.filename}
        </span>
      </div>

      {/* Line 2: metadata */}
      <div className="mt-0.5 text-[10px] text-muted-foreground">
        {formatFileSize(file.size)}
        {file.contentType && <> &middot; {file.contentType.split("/")[1]}</>}
      </div>

      {/* Line 3: time + delete */}
      <div className="mt-0.5 flex items-center justify-between">
        <span className="text-[10px] text-muted-foreground">
          {formatRelativeTime(file.createdAt)}
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="invisible cursor-pointer rounded p-0.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive group-hover:visible"
          title="Delete file"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </button>
      </div>

      {/* Hover preview popover — positioned to the LEFT */}
      {previewRect && (
        <ResourcePreview
          file={file}
          pieceId={pieceId}
          anchorRect={previewRect}
        />
      )}
    </div>
  );
}
