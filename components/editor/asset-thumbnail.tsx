"use client";

import type { FileRecord } from "@/lib/db/schema/types";
import { FileText, FileAudio, FileQuestion } from "lucide-react";
import { firstNonEmptyLine } from "@/lib/utils/format";
import { LIBI_FILE_MIME, encodeFileDrag } from "@/lib/preview/drag-payload";

interface Props {
  file: FileRecord;
}

export function AssetThumbnail({ file }: Props) {
  const imageUrl = `/api/files/by-id/${file.id}/content`;

  // Caption is rendered by the parent (e.g. `AssetGrid`'s card body) so this
  // component owns ONLY the visual preview tile.
  return (
    <div
      className="aspect-video w-full overflow-hidden bg-black/30"
      title={firstNonEmptyLine(file.notes)}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(LIBI_FILE_MIME, encodeFileDrag({ fileId: file.id, contentType: file.contentType ?? "" }));
        e.dataTransfer.effectAllowed = "copy";
      }}
    >
      {file.type === "image" && (
        <img
          src={imageUrl}
          alt={file.name || file.filename}
          loading="lazy"
          className="h-full w-full object-cover"
        />
      )}
      {file.type === "video" && <VideoTile file={file} />}
      {file.type !== "image" && file.type !== "video" && (
        <Fallback file={file} />
      )}
    </div>
  );
}

function VideoTile({ file }: { file: FileRecord }) {
  const proxyReady = file.proxyStatus === "ready" && !!file.proxyFilename;
  const videoUrl = proxyReady
    ? `/api/files/by-id/${file.id}/proxy`
    : `/api/files/by-id/${file.id}/content`;

  return (
    <video
      src={videoUrl}
      preload="metadata"
      muted
      playsInline
      className="h-full w-full object-cover"
    />
  );
}

function Fallback({ file }: { file: FileRecord }) {
  const Icon =
    file.type === "audio"
      ? FileAudio
      : file.contentType?.startsWith("text/") ||
          file.contentType === "application/json" ||
          file.contentType === "application/pdf"
        ? FileText
        : FileQuestion;
  return (
    <div
      data-testid="asset-thumbnail-fallback"
      className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted-foreground"
    >
      <Icon className="h-8 w-8" strokeWidth={1.5} />
      <span className="text-[11px] uppercase tracking-wide">{file.type}</span>
    </div>
  );
}
