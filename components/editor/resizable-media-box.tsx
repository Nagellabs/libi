"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Sizes a video/image to the available panel space and lets the user
 * drag-resize it from the bottom-right corner.
 *
 * Sizing is computed in JS from a measured container instead of CSS
 * `max-h-full` chains — percentage max-heights silently stop resolving once
 * the media needs a wrapper (the proxy badge), which is exactly the bug that
 * made videos overflow the top split section with a scrollbar.
 *
 * Rules:
 * - Default: contain-fit to the container (max width/height, aspect kept).
 * - A manual drag-resize is persisted per asset in localStorage.
 * - Any container resize (panel separator drag, layout change) clears the
 *   manual size for this asset and reverts to auto-fit.
 */

export interface MediaSize {
  w: number;
  h: number;
}

/** Inner padding between the media box and the panel edges. */
export const MEDIA_BOX_PADDING = 16;
/** Smallest manual width the drag handle allows. */
export const MIN_MANUAL_WIDTH = 80;
/** Largest manual width the drag handle allows. */
export const MAX_MANUAL_WIDTH = 4096;

const storageKey = (assetId: string) => `libi:asset-media-size:${assetId}`;

export function readStoredMediaSize(assetId: string): MediaSize | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey(assetId));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<MediaSize>;
    if (
      typeof v.w === "number" &&
      typeof v.h === "number" &&
      isFinite(v.w) &&
      isFinite(v.h) &&
      v.w > 0 &&
      v.h > 0
    ) {
      return { w: v.w, h: v.h };
    }
  } catch {
    // Corrupt entry — treat as absent.
  }
  return null;
}

export function writeStoredMediaSize(assetId: string, size: MediaSize): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(assetId), JSON.stringify(size));
  } catch {
    // Quota/private mode — manual size just won't persist.
  }
}

export function clearStoredMediaSize(assetId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(storageKey(assetId));
  } catch {
    // Ignore.
  }
}

/** Largest box of the given aspect ratio that fits in cw×ch. */
export function containBox(
  cw: number,
  ch: number,
  aspect: number,
): MediaSize | null {
  if (cw <= 0 || ch <= 0 || !isFinite(aspect) || aspect <= 0) return null;
  const w = Math.min(cw, ch * aspect);
  return { w: Math.round(w), h: Math.round(w / aspect) };
}

function clampManualWidth(w: number): number {
  return Math.min(MAX_MANUAL_WIDTH, Math.max(MIN_MANUAL_WIDTH, w));
}

interface Props {
  assetId: string;
  /** Natural media aspect ratio (width / height) when known. */
  aspect: number | null;
  /** The media element, styled `h-full w-full object-contain`. */
  children: React.ReactNode;
}

export function ResizableMediaBox({ assetId, aspect, children }: Props) {
  const measureRef = useRef<HTMLDivElement | null>(null);
  const [container, setContainer] = useState<MediaSize | null>(null);
  const [manual, setManual] = useState<MediaSize | null>(() =>
    readStoredMediaSize(assetId),
  );
  const dragRef = useRef<{
    startX: number;
    startY: number;
    startW: number;
    startH: number;
  } | null>(null);

  useEffect(() => {
    const el = measureRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let prev: MediaSize | null = null;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[entries.length - 1]?.contentRect;
      if (!rect) return;
      const w = rect.width;
      const h = rect.height;
      // A hidden keep-mounted tab reports 0×0 — not a real resize.
      if (w < 2 || h < 2) return;
      setContainer({ w, h });
      if (prev && (Math.abs(prev.w - w) > 1 || Math.abs(prev.h - h) > 1)) {
        // The panel around the media changed size (separator drag, layout
        // change) — drop the manual size and go back to auto-fit.
        clearStoredMediaSize(assetId);
        setManual(null);
      }
      prev = { w, h };
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [assetId]);

  const auto =
    container && aspect
      ? containBox(
          container.w - MEDIA_BOX_PADDING * 2,
          container.h - MEDIA_BOX_PADDING * 2,
          aspect,
        )
      : null;
  const size = manual ?? auto;

  const onHandlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!size) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        startW: size.w,
        startH: size.h,
      };
    },
    [size],
  );

  const onHandlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const d = dragRef.current;
      if (!d) return;
      const ar = aspect ?? d.startW / d.startH;
      // Corner drag: whichever axis the user pulled further wins, then the
      // other follows the aspect ratio.
      const w = clampManualWidth(
        Math.max(
          d.startW + (e.clientX - d.startX),
          (d.startH + (e.clientY - d.startY)) * ar,
        ),
      );
      setManual({ w: Math.round(w), h: Math.round(w / ar) });
    },
    [aspect],
  );

  const onHandlePointerUp = useCallback(() => {
    if (dragRef.current && manual) writeStoredMediaSize(assetId, manual);
    dragRef.current = null;
  }, [assetId, manual]);

  const resetToAuto = useCallback(() => {
    dragRef.current = null;
    clearStoredMediaSize(assetId);
    setManual(null);
  }, [assetId]);

  return (
    <div ref={measureRef} data-testid="media-box-measure" className="relative h-full w-full">
      <div className="absolute inset-0 overflow-auto">
        {/* min-h/w-full + m-auto centers a small box and keeps a manually
            enlarged one fully scrollable (flex centering would clip it). */}
        <div
          className="flex min-h-full min-w-full"
          style={{ padding: MEDIA_BOX_PADDING }}
        >
          <div
            data-testid="media-box"
            className="group/media relative m-auto shrink-0"
            style={size ? { width: size.w, height: size.h } : { width: "100%", height: "100%" }}
          >
            {children}
            {size && (
              <div
                role="button"
                aria-label="Resize media"
                title="Drag to resize · double-click to reset"
                onPointerDown={onHandlePointerDown}
                onPointerMove={onHandlePointerMove}
                onPointerUp={onHandlePointerUp}
                onDoubleClick={resetToAuto}
                className="absolute -bottom-1.5 -right-1.5 z-10 hidden size-5 cursor-nwse-resize items-center justify-center rounded-sm bg-black/60 text-white/80 shadow-sm backdrop-blur-sm group-hover/media:flex"
              >
                <svg viewBox="0 0 12 12" className="size-3" aria-hidden>
                  <path
                    d="M10 2 2 10 M10 6 6 10"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    fill="none"
                  />
                </svg>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
