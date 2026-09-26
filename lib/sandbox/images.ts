/** ImageBitmaps for the runtime, keyed by fileId, made from the same-origin
 *  `<img>` elements the preview already resolves per overlay (spec §4.8). Only
 *  fully-loaded elements are converted; a still-loading one contributes
 *  nothing until it has loaded. */
import type { Overlay } from "@/lib/engine/types";

/** The fully-loaded element for each image file on the timeline, by fileId —
 *  what `collectSandboxImages` converts. Cheap (no decoding), so a caller can
 *  compare the key set before paying for bitmaps. */
export function sandboxImageElements(
  overlays: readonly Overlay[],
  imageElements: Record<string, HTMLImageElement>,
): Map<string, HTMLImageElement> {
  const byFile = new Map<string, HTMLImageElement>();
  for (const o of overlays) {
    const fileId = o.kind === "image" ? o.fileId : o.kind === "tracked" && o.content.kind === "image" ? o.content.fileId : null;
    if (!fileId || byFile.has(fileId)) continue;
    const img = imageElements[o.id];
    if (img && img.complete && img.naturalWidth > 0) byFile.set(fileId, img);
  }
  return byFile;
}

export async function collectSandboxImages(
  overlays: readonly Overlay[],
  imageElements: Record<string, HTMLImageElement>,
  makeBitmap: (img: HTMLImageElement) => Promise<ImageBitmap> = (img) => createImageBitmap(img),
): Promise<Record<string, ImageBitmap>> {
  const out: Record<string, ImageBitmap> = {};
  await Promise.all(
    Array.from(sandboxImageElements(overlays, imageElements), async ([fileId, img]) => {
      try {
        out[fileId] = await makeBitmap(img);
      } catch {
        // A tainted or failed element contributes nothing; the body's
        // loadImage names the missing id.
      }
    }),
  );
  return out;
}
