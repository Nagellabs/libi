"use client";

import { cn } from "@/lib/utils";

interface Props {
  /** Actual encoded height of the proxy being shown (px). */
  proxyHeight?: number | null;
  /** Original source media height (px). */
  mediaHeight?: number | null;
  className?: string;
}

/**
 * Returns true iff the preview is genuinely showing a downscaled proxy —
 * i.e. both heights are known and the proxy is shorter than the original.
 */
export function isProxyDownscaled(
  proxyHeight?: number | null,
  mediaHeight?: number | null,
): boolean {
  return (
    proxyHeight != null &&
    mediaHeight != null &&
    proxyHeight < mediaHeight
  );
}

/**
 * Subtle corner chip disclosing that the preview is a downscaled proxy.
 * Renders nothing when the preview is at native resolution (nothing to
 * disclose). Exports always use the original — see the proxy invariant.
 */
export function PreviewProxyBadge({ proxyHeight, mediaHeight, className }: Props) {
  if (!isProxyDownscaled(proxyHeight, mediaHeight)) return null;

  return (
    <div
      className={cn(
        "pointer-events-none select-none rounded-md bg-black/60 px-2 py-1 text-[11px] font-medium text-white/90 shadow-sm backdrop-blur-sm",
        className,
      )}
    >
      Preview · {proxyHeight}p (original {mediaHeight}p) — exports use the original
    </div>
  );
}
