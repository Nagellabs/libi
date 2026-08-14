/**
 * Pure resolver for a drag-media-onto-the-timeline drop. Maps the drop's content
 * x-position + which target it landed on (an existing lane, the "＋ new track"
 * zone, or an empty piece's full-panel zone) to a concrete placement:
 * `{ kind, startTime, z, group }`. NO React, NO DOM — unit-tested in isolation.
 *
 * Dropped video/image → an overlay (kind image|video); dropped audio → a
 * standalone audio clip (the caller only needs `startTime` for audio). An
 * unrecognized content type yields `kind: null` (caller ignores the drop).
 */
import { defaultGroupForKind } from "@/lib/overlays/lanes";

export type DropContentKind = "image" | "video" | "audio" | null;

/** video/* → video, image/* → image, audio/* → audio, else null. */
export function kindFromContentType(contentType: string): DropContentKind {
  const ct = (contentType || "").toLowerCase();
  if (ct.startsWith("video/")) return "video";
  if (ct.startsWith("image/")) return "image";
  if (ct.startsWith("audio/")) return "audio";
  return null;
}

/** Which target the pointer is over at drop time. */
export type TimelineDropZone =
  | "empty" // empty piece: full-panel zone → start at 0, first lane
  | "newTrack" // the "＋ new track" strip → a fresh lane above the rest
  | { z: number; group?: string }; // an existing lane → inherit its z/group

export interface TimelineDropArgs {
  /** Pointer x within the lane CONTENT area (0 … contentWidth), rail excluded. */
  contentX: number;
  contentWidth: number;
  /** Timeline length in seconds (0 for an empty piece). */
  durationSec: number;
  contentType: string;
  /** Current max overlay z (a new track lands one above it). */
  maxZ: number;
  zone: TimelineDropZone;
}

export interface TimelineDropResult {
  kind: DropContentKind;
  startTime: number;
  /** Overlay z (ignored for audio). */
  z: number;
  /** Overlay lane group (undefined for audio / unknown kind). */
  group?: string;
}

function startTimeFromX(contentX: number, contentWidth: number, durationSec: number): number {
  if (contentWidth <= 0 || durationSec <= 0) return 0;
  const frac = Math.min(1, Math.max(0, contentX / contentWidth));
  return frac * durationSec;
}

/** Group for a droppable overlay kind (audio/unknown have no lane group). */
function groupFor(kind: DropContentKind): string | undefined {
  return kind === "image" || kind === "video" ? defaultGroupForKind(kind) : undefined;
}

export function resolveTimelineDropTarget(args: TimelineDropArgs): TimelineDropResult {
  const kind = kindFromContentType(args.contentType);
  const startTime = startTimeFromX(args.contentX, args.contentWidth, args.durationSec);

  if (args.zone === "empty") {
    // Empty piece: land at the very start on the first lane.
    return { kind, startTime: 0, z: 0, group: groupFor(kind) };
  }
  if (args.zone === "newTrack") {
    // A fresh lane above everything else.
    return { kind, startTime, z: args.maxZ + 1, group: groupFor(kind) };
  }
  // An existing lane inherits its z/group.
  return { kind, startTime, z: args.zone.z, group: args.zone.group };
}
