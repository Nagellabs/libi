import type { FileRecord } from "@/lib/db/schema/types";
import { alphaRecoverableInPreview } from "@/lib/ffmpeg/alpha";

/**
 * Decide which URL the preview should use for a video file: the proxy
 * (small, scrub-friendly) when ready, otherwise the original. The choice
 * lives in one place so every caller agrees.
 */
export function pickVideoUrl(file: FileRecord): string {
  // VPx-alpha video (VP9-alpha WebM cutouts, transparent fal imports) must
  // ALWAYS serve the original: proxies are H.264 yuv420p — no alpha plane —
  // and `alphamerge` keeps the original RGB planes intact, so an
  // alpha-stripped proxy IS the original video with its background back.
  // Guarding here (not just at enqueue time) also protects rows that got a
  // proxy before alpha-awareness landed. Non-VPx alpha (ProRes 4444, qtrle,
  // ...) deliberately falls through to its opaque proxy — preview generally
  // can't decode that original at all, and exports read the ORIGINAL anyway.
  if (
    alphaRecoverableInPreview({
      hasAlpha: file.hasAlpha,
      filename: file.filename,
      contentType: file.contentType,
    })
  ) {
    return `/api/files/by-id/${file.id}/content`;
  }
  if (file.proxyStatus === "ready" && file.proxyFilename) {
    return `/api/files/by-id/${file.id}/proxy`;
  }
  return `/api/files/by-id/${file.id}/content`;
}
