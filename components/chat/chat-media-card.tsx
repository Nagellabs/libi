"use client";

import { useState } from "react";
import type { ChatMediaPayload } from "@/lib/chat/chat-media";
import { MediaViewer } from "@/components/storyboard/media-viewer";
import FileAttachmentChip from "./file-attachment-chip";

interface ChatMediaCardProps {
  payload: ChatMediaPayload;
}

/**
 * Inline media card for an agent-created asset surfaced via `libi.show_in_chat`.
 * Renders right in the assistant's turn so the user sees the result without
 * leaving the conversation:
 *  - image → constrained thumbnail, click opens the large MediaViewer
 *  - video → inline player (click the expand affordance for the large viewer)
 *  - audio → inline player
 *  - other / load error → file chip
 */
export function ChatMediaCard({ payload }: ChatMediaCardProps) {
  const { fileId, kind, contentType, caption, filename } = payload;
  const [viewerOpen, setViewerOpen] = useState(false);
  const [errored, setErrored] = useState(false);

  const src = `/api/files/by-id/${fileId}/content`;
  const title = caption || filename || "Generated asset";

  // Unrenderable kind or a load failure → a compact, always-safe file chip.
  if (kind === "other" || errored) {
    return (
      <div className="my-1.5">
        <FileAttachmentChip
          fileId={fileId}
          filename={filename ?? "asset"}
          contentType={contentType}
          size={0}
        />
        {caption && (
          <p className="mt-1 text-xs text-muted-foreground">{caption}</p>
        )}
      </div>
    );
  }

  return (
    // `w-full max-w-[360px]` (not `w-fit`): a definite width so the `w-full`
    // media children resolve — a `w-fit` parent + `w-full` child collapse to a
    // few px (circular sizing).
    <div className="my-1.5 w-full max-w-[360px]">
      <div className="overflow-hidden rounded-lg border border-border bg-muted/20">
        {kind === "image" && (
          <button
            type="button"
            onClick={() => setViewerOpen(true)}
            className="block cursor-pointer"
            aria-label="Open image"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt={title}
              onError={() => setErrored(true)}
              className="max-h-[260px] w-full object-contain"
            />
          </button>
        )}

        {kind === "video" && (
          <div className="relative">
            <video
              src={src}
              controls
              preload="metadata"
              onError={() => setErrored(true)}
              className="max-h-[280px] w-full rounded-t-lg bg-black"
            />
            <button
              type="button"
              onClick={() => setViewerOpen(true)}
              className="absolute right-1.5 top-1.5 cursor-pointer rounded bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white/90 transition-colors hover:bg-black/75"
            >
              Expand
            </button>
          </div>
        )}

        {kind === "audio" && (
          <div className="p-2">
            <audio
              src={src}
              controls
              preload="metadata"
              onError={() => setErrored(true)}
              className="w-full"
            />
          </div>
        )}

        {caption && (
          <p className="px-2.5 py-1.5 text-xs text-muted-foreground">{caption}</p>
        )}
      </div>

      <MediaViewer
        open={viewerOpen}
        onOpenChange={setViewerOpen}
        src={src}
        kind={kind}
        title={title}
      />
    </div>
  );
}
