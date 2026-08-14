import type { PersistedOverlay } from "@/lib/composition/persistence";
import type { OverlayCodeFile } from "./paths";

/** True when this overlay stores a JS body that should live in a file. */
export function overlayHasCode(o: PersistedOverlay): boolean {
  return o.kind === "code" || o.kind === "three" ||
    (o.kind === "tracked" && o.content.kind === "code");
}

/** The code filename for this overlay, or null when it carries no code. */
export function overlayCodeFile(o: PersistedOverlay): OverlayCodeFile | null {
  if (o.kind === "code") return "draw.jsx";
  if (o.kind === "three") return "scene.jsx";
  if (o.kind === "tracked" && o.content.kind === "code") return "content.jsx";
  return null;
}

/** The JS body string, or null when this overlay carries no code. */
export function getOverlayBody(o: PersistedOverlay): string | null {
  if (o.kind === "code") return o.drawFunction;
  if (o.kind === "three") return o.sceneFunction;
  if (o.kind === "tracked" && o.content.kind === "code") return o.content.drawFunction;
  return null;
}

/** Return a clone of the overlay with its body replaced (no-op for non-code). */
export function setOverlayBody(o: PersistedOverlay, body: string): PersistedOverlay {
  if (o.kind === "code") return { ...o, drawFunction: body };
  if (o.kind === "three") return { ...o, sceneFunction: body };
  if (o.kind === "tracked" && o.content.kind === "code") {
    return { ...o, content: { ...o.content, drawFunction: body } };
  }
  return o;
}
