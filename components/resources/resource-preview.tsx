"use client";

import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { FileRecord } from "@/lib/db/schema/types";
import { getAssetUrl } from "@/lib/utils/format";

interface ResourcePreviewProps {
  file: FileRecord;
  pieceId: string;
  /** The hovered row's rect, measured by the parent in its hover handler. */
  anchorRect: Pick<DOMRect, "top" | "left" | "right" | "height">;
}

export default function ResourcePreview({
  file,
  pieceId,
  anchorRect,
}: ResourcePreviewProps) {
  const previewRef = useRef<HTMLDivElement>(null);

  // Pure derivation from the measured rect the parent captured on hover —
  // no mount-effect setState, no ref read during render.
  const previewWidth = 156;
  const previewHeight = 120;
  // Position to the left of the item, but clamp within viewport
  let left = anchorRect.left - previewWidth - 8;
  let top = anchorRect.top + anchorRect.height / 2 - previewHeight / 2;
  if (left < 4) left = anchorRect.right + 8; // flip to right if no room on left
  if (top < 4) top = 4;
  if (top + previewHeight > window.innerHeight - 4) top = window.innerHeight - previewHeight - 4;
  const position = { top, left };

  const url = getAssetUrl(pieceId, file.filename);
  const ct = file.contentType ?? "";

  const content = (() => {
    if (ct.startsWith("image/")) {
      return (
        <img
          src={url}
          alt={file.name}
          className="h-full w-full rounded object-cover"
        />
      );
    }

    if (ct.startsWith("video/")) {
      return (
        <video
          src={url}
          muted
          className="h-full w-full rounded object-cover"
        />
      );
    }

    if (ct === "application/pdf") {
      return (
        <div className="flex h-full w-full items-center justify-center bg-surface text-muted-foreground">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
          </svg>
        </div>
      );
    }

    if (ct.startsWith("text/") || ct === "application/json") {
      return <TextPreview url={url} />;
    }

    return (
      <div className="flex h-full w-full items-center justify-center text-muted-foreground">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      </div>
    );
  })();

  return createPortal(
    <div
      ref={previewRef}
      className="fixed z-50 h-[120px] w-[156px] overflow-hidden rounded-lg border border-border bg-surface shadow-lg"
      style={{ top: position.top, left: position.left }}
    >
      {content}
    </div>,
    document.body,
  );
}

function TextPreview({ url }: { url: string }) {
  const [text, setText] = useState<string>("");

  useEffect(() => {
    const controller = new AbortController();
    fetch(url, { signal: controller.signal })
      .then((res) => res.text())
      .then((t) => setText(t.slice(0, 200)))
      .catch(() => {
        if (!controller.signal.aborted) setText("");
      });
    return () => controller.abort();
  }, [url]);

  return (
    <div className="h-full w-full overflow-hidden bg-background p-2">
      <pre className="font-mono text-[8px] leading-tight text-foreground">
        {text || "..."}
      </pre>
    </div>
  );
}
