"use client";

import { useMemo } from "react";
import { FileText, FileX, Music, Video } from "lucide-react";
import { useFileById } from "@/lib/queries/files";
import { formatFileSize } from "@/lib/utils/format";
import type { FileRecord } from "@/lib/db/schema/types";

interface FileAttachmentChipProps {
  fileId: string;
  filename: string;
  /** Best-known MIME from the message part. Used for the "deleted" fallback
   *  thumbnail kind when we have no live file record to inspect. */
  contentType: string | null;
  /** Best-known size for the "deleted" fallback. */
  size: number;
  /** Click target. Receives the live file record (with pieceId) so the
   *  parent can switch to the right piece + assets tab. Skipped when the
   *  file no longer exists. */
  onOpen?: (file: FileRecord) => void;
}

type Kind = "image" | "video" | "audio" | "other";

function classifyKind(contentType: string | null | undefined): Kind {
  if (!contentType) return "other";
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  return "other";
}

/**
 * Inline chip for a chat-message file attachment. Pulls fresh metadata
 * via `useFileById` so:
 *
 *   - thumbnails reflect the current file (renames, proxy regen, etc.)
 *   - clicking deep-links into the assets panel for the right piece
 *   - a deleted file gracefully degrades to a "filename + size" badge
 *     (the message persists across reloads even after the user deletes
 *     the source file from resources).
 *
 * Used by both user and agent chat messages; the user-message branch
 * wraps it in a tighter clear-bg style via the `compact` prop.
 */
export default function FileAttachmentChip({
  fileId,
  filename,
  contentType,
  size,
  onOpen,
}: FileAttachmentChipProps) {
  const { data: file, isLoading } = useFileById(fileId);

  // Choose the source of truth: live record when available, fallback to
  // the part's snapshotted metadata when the file was deleted.
  const effectiveName = file?.name ?? filename;
  const effectiveSize = file?.size ?? size;
  const effectiveType = file?.contentType ?? contentType;
  const kind = classifyKind(effectiveType);
  const exists = !!file;
  const interactive = exists && !!onOpen;

  // Asset URL — only meaningful when the file exists. Always points to
  // the original (not the proxy) because the chip thumbnail is a
  // single-frame poster, not a scrub target.
  const contentUrl = exists ? `/api/files/by-id/${fileId}/content` : null;

  const handleClick = () => {
    if (file && onOpen) onOpen(file);
  };

  const meta = useMemo(() => {
    const parts: string[] = [];
    if (effectiveType) parts.push(effectiveType);
    parts.push(formatFileSize(effectiveSize));
    return parts.join(" · ");
  }, [effectiveType, effectiveSize]);

  const baseClasses =
    "group/chip my-1 inline-flex items-stretch gap-2.5 rounded-lg border bg-card p-1.5 text-xs transition-colors";
  const stateClasses = exists
    ? interactive
      ? "border-border hover:border-primary/50 hover:bg-accent/40 cursor-pointer"
      : "border-border"
    : "border-dashed border-border/60 opacity-70";

  const Tag = interactive ? "button" : "div";

  return (
    <Tag
      type={interactive ? "button" : undefined}
      onClick={interactive ? handleClick : undefined}
      title={
        !exists
          ? `${effectiveName} — file no longer in resources`
          : `Open ${effectiveName}`
      }
      className={`${baseClasses} ${stateClasses}`}
    >
      <Thumbnail
        kind={kind}
        url={contentUrl}
        loading={isLoading}
        missing={!exists}
        filename={effectiveName}
      />
      <div className="flex min-w-0 flex-col justify-center pr-1.5 text-left">
        <span className="max-w-[200px] truncate text-[12.5px] font-medium text-foreground">
          {effectiveName}
        </span>
        <span className="text-[10.5px] text-muted-foreground">{meta}</span>
        {!exists && !isLoading && (
          <span className="mt-0.5 inline-flex items-center gap-1 text-[10px] text-muted-foreground/80">
            <FileX className="size-2.5" />
            <span>not in resources</span>
          </span>
        )}
      </div>
    </Tag>
  );
}

interface ThumbnailProps {
  kind: Kind;
  url: string | null;
  loading: boolean;
  missing: boolean;
  filename: string;
}

function Thumbnail({ kind, url, loading, missing, filename }: ThumbnailProps) {
  // Constant size keeps message vertical rhythm consistent regardless
  // of media — wider preview belongs in the assets panel, not inline.
  const cls =
    "relative grid size-11 shrink-0 place-items-center overflow-hidden rounded-md bg-surface text-muted-foreground";

  if (loading) {
    return <div className={`${cls} animate-pulse bg-muted/40`} />;
  }
  if (missing) {
    return (
      <div className={cls}>
        <FileX className="size-5 opacity-60" />
      </div>
    );
  }

  if (kind === "image" && url) {
    return (
      <div className={cls}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={filename}
          className="size-full object-cover"
          loading="lazy"
        />
      </div>
    );
  }

  if (kind === "video" && url) {
    return (
      <div className={cls}>
        {/* Browsers render frame ~0 as a poster when preload="metadata" is set */}
        <video
          src={url}
          className="size-full object-cover"
          preload="metadata"
          muted
          playsInline
        />
        <div className="absolute inset-0 grid place-items-center bg-black/35">
          <Video className="size-4 text-white" strokeWidth={2.4} />
        </div>
      </div>
    );
  }

  if (kind === "audio") {
    return (
      <div className={cls}>
        <Music className="size-5 text-primary" strokeWidth={2} />
      </div>
    );
  }

  // Generic / unknown kind — plain document glyph.
  return (
    <div className={cls}>
      <FileText className="size-5" />
    </div>
  );
}
