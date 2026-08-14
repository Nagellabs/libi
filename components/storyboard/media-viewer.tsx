"use client";

import type { ReactNode } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

interface MediaViewerProps {
  src?: string;
  kind: "image" | "video" | "audio";
  title?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Optional footer actions (e.g. "Use on timeline" for a take). */
  footer?: ReactNode;
}

/** Large, centered media viewer. Portaled to the body via the shared Dialog (so it
 *  escapes the board's React Flow transform and never overflows onto cards),
 *  plays video/audio, and closes by Escape or the X. The single click-to-open
 *  viewer replaces the old per-tile enlarge/play buttons. */
export function MediaViewer({ src, kind, title, open, onOpenChange, footer }: MediaViewerProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] w-full flex-col gap-3 sm:max-w-[min(92vw,1000px)]">
        <DialogTitle className="truncate pr-8 text-sm">{title ?? "Preview"}</DialogTitle>
        <div className="flex min-h-0 flex-1 items-center justify-center">
          {!src ? null : kind === "image" ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={src} alt={title ?? "preview"} className="max-h-[78vh] max-w-full rounded-lg object-contain" />
          ) : kind === "video" ? (
            <video src={src} controls autoPlay className="max-h-[78vh] max-w-full rounded-lg" />
          ) : (
            <audio src={src} controls autoPlay className="w-full max-w-[640px]" />
          )}
        </div>
        {footer && <div className="flex items-center justify-end gap-2">{footer}</div>}
      </DialogContent>
    </Dialog>
  );
}
