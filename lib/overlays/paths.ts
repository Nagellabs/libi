export const OVERLAYS_DIR = "overlays";

/** Overlay-code filename within an overlay's dir, by overlay kind/content. */
export type OverlayCodeFile = "draw.jsx" | "scene.jsx" | "content.jsx";

function guardId(overlayId: string): string {
  if (overlayId.includes("..") || overlayId.includes("/") || overlayId.includes("\\")) {
    throw new Error(`unsafe overlay id: ${overlayId}`);
  }
  return overlayId;
}

/** Relative (storage-rooted) dir for one overlay's files. */
export function overlayDir(overlayId: string): string {
  return `${OVERLAYS_DIR}/${guardId(overlayId)}`;
}

/** Relative (storage-rooted) path to an overlay's code file. */
export function overlayCodeRelPath(overlayId: string, file: OverlayCodeFile): string {
  return `${overlayDir(overlayId)}/${file}`;
}
