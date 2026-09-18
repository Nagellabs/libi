"use client";

import { useState, type MouseEvent, type SyntheticEvent } from "react";
import { CheckIcon, ImageIcon, VideoIcon, XIcon } from "lucide-react";
import { tileSize } from "@/lib/storyboard/card-aspect";

interface MediaTileProps {
  src?: string;
  kind: "image" | "video";
  label?: string;
  selected?: boolean;
  inherited?: boolean;
  badge?: string;
  /** Thumbnail width in px for a PORTRAIT (9:16) tile. Other aspects keep the
   *  same long edge (see `tileSize`). Total tile width adds the action column so
   *  every item reserves the same footprint and rows stay evenly gapped. */
  width?: number;
  /** Expected media aspect (width / height), e.g. the card's generation frame.
   *  Used until the media has loaded; the intrinsic size then wins. Default 9:16. */
  aspect?: number;
  /** Click the thumbnail to open the large media viewer. */
  onView?: () => void;
  onRemove?: () => void;
}

/** Width of the right-side action column (just the Remove button now). */
const ACTION_COL = 22;

const DEFAULT_ASPECT = 9 / 16;

/** Thumbnail tile in the media's own aspect. Clicking the thumbnail opens the
 *  shared MediaViewer (the per-tile enlarge/play buttons were removed); the only
 *  action button is Remove. Video tiles show a still (no native controls) —
 *  playback is in the viewer.
 *
 *  The box used to be a fixed 9:16 with `object-cover`, which cropped every
 *  non-portrait sketch/keyframe to its middle strip — a 16:9 drawing "wasn't
 *  showing" until the viewer opened it. The box now follows `aspect` (the
 *  card's generation frame) and corrects itself to the media's intrinsic size
 *  on load, so whatever a provider returns is shown whole. */
export function MediaTile({
  src,
  kind,
  label,
  selected,
  inherited,
  badge,
  width = 64,
  aspect: aspectHint,
  onView,
  onRemove,
}: MediaTileProps) {
  // Intrinsic aspect once the media has loaded, keyed by the src it was measured
  // from: a replaced file (a regenerated sketch's new `?v=`, another take) falls
  // back to the hint until its own load event arrives — no effect needed.
  const [measured, setMeasured] = useState<{ src: string; aspect: number } | null>(null);
  const mediaAspect = measured && measured.src === src ? measured.aspect : null;
  const aspect = mediaAspect ?? aspectHint ?? DEFAULT_ASPECT;
  const size = tileSize(width, aspect);

  const onImageLoad = (e: SyntheticEvent<HTMLImageElement>) => {
    const { naturalWidth, naturalHeight } = e.currentTarget;
    if (src && naturalWidth > 0 && naturalHeight > 0) setMeasured({ src, aspect: naturalWidth / naturalHeight });
  };
  const onVideoMeta = (e: SyntheticEvent<HTMLVideoElement>) => {
    const { videoWidth, videoHeight } = e.currentTarget;
    if (src && videoWidth > 0 && videoHeight > 0) setMeasured({ src, aspect: videoWidth / videoHeight });
  };
  const ringClasses = selected
    ? "ring-2 ring-blue-500"
    : inherited
      ? "ring-2 ring-purple-400 animate-pulse"
      : "";

  const stop = (e: MouseEvent) => e.stopPropagation();

  return (
    <div style={{ width: size.width + ACTION_COL }}>
      <div className="flex items-start gap-1">
        {/* Thumbnail → opens the viewer on click */}
        <div
          data-testid="media-tile-thumb"
          className={[
            "relative shrink-0 overflow-hidden rounded-md bg-muted",
            ringClasses,
            onView ? "cursor-pointer" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          style={{ width: size.width, height: size.height }}
          onClick={onView}
        >
          {src ? (
            kind === "image" ? (
              <img src={src} alt={label ?? "media"} onLoad={onImageLoad} className="h-full w-full object-cover" />
            ) : (
              <video src={src} muted onLoadedMetadata={onVideoMeta} className="h-full w-full object-cover" />
            )
          ) : (
            <div className="absolute inset-0 flex items-center justify-center">
              {kind === "image" ? (
                <ImageIcon className="size-5 text-muted-foreground/40" />
              ) : (
                <VideoIcon className="size-5 text-muted-foreground/40" />
              )}
            </div>
          )}

          {badge && (
            <div className="absolute bottom-0 inset-x-0 text-[9px] bg-black/70 text-white px-1 py-0.5 truncate">
              {badge}
            </div>
          )}
        </div>

        {/* Action column — Remove only */}
        <div className="flex flex-col gap-1" style={{ width: ACTION_COL - 4 }}>
          {onRemove && (
            <button
              type="button"
              onMouseDown={stop}
              onClick={(e) => {
                stop(e);
                onRemove();
              }}
              aria-label="Remove"
              className="cursor-pointer flex size-[18px] items-center justify-center rounded bg-muted text-muted-foreground transition-colors hover:bg-muted-foreground/20 hover:text-foreground"
            >
              <XIcon className="size-3" />
            </button>
          )}
        </div>
      </div>

      {/* Selected caption */}
      {selected && (
        <div className="mt-0.5 flex items-center justify-center gap-0.5 text-[9px] text-blue-400" style={{ width: size.width }}>
          <CheckIcon className="size-2.5" />
          <span>on timeline</span>
        </div>
      )}

      {/* Label — clamped to 2 lines with a hover tooltip; fixed min-height so a
          long description never shifts the item's position. */}
      {label && (
        <div
          title={label}
          className="mt-0.5 text-[10px] leading-tight text-muted-foreground text-center line-clamp-2 min-h-[1.9em]"
          style={{ width: size.width }}
        >
          {label}
        </div>
      )}
    </div>
  );
}
