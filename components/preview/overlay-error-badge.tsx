import type { CSSProperties } from "react";

/**
 * Compact "⚠ code error" badge positioned over a code/three overlay whose
 * current source failed to compile. The preview retains the last-good render
 * underneath (see `lib/preview/last-good.ts`); this badge surfaces the failure
 * without flashing blank. The full error message shows on hover via `title`.
 *
 * Thin + presentational: positioning (`style`) is supplied by the caller using
 * the same canvas-relative rect mapping the inline overlay editor uses.
 */
export function OverlayErrorBadge({ message, style }: { message: string; style: CSSProperties }) {
  return (
    <div
      style={style}
      className="pointer-events-auto absolute z-50 rounded bg-red-600/90 px-1.5 py-0.5 text-[10px] font-medium text-white shadow cursor-help"
      title={message}
    >
      ⚠ code error
    </div>
  );
}
