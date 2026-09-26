// lib/export/dropped-overlays.ts
//
// What an export went out without. The render page reports `{ id, message }` per overlay it
// dropped; the export runner adds what the page can't be trusted to say — which of them were
// VIDEO clips, and their names — from the piece's own manifest and files table. Two readers:
// the in-app export screen (`droppedClipsNote`) and libi.export_video's result, whose framing
// (mcp/tools/body-message.ts) tells body text from libi's own.
//
// Pure: imported by the client (the export dialog + toast) and by the server runner.

import type { Overlay } from "@/lib/engine/types";
import { VIDEO_LOAD_FAILURE_MESSAGE } from "@/lib/export/render-entry-video";

/** One overlay an export went out without. */
export interface DroppedOverlay {
  id: string;
  message: string;
  /** `"video"`: a video (or tracked-video) overlay. Absent for a body-bearing overlay (code /
   *  three / tracked-code), whose `message` is text its body produced. Set by the export runner
   *  from the manifest, never from the render page's postback, so a body can't dress its own
   *  text up as libi's. */
  kind?: "video";
  /** Why a video was dropped. `"load"`: neither its file nor its proxy could be loaded, so the
   *  clip is missing from the WHOLE export. `"frames"`: it loaded but failed to draw on some
   *  frames (a decode error mid-export; for a tracked clip, a track that would not resolve) and
   *  is missing from those frames only. */
  cause?: "load" | "frames";
  /** The clip's file, for `kind: "video"`. */
  fileId?: string;
  /** The clip's display name (the file's `name`, else its stored filename), for the in-app note.
   *  Kept out of the agent's result: a downloaded video's name is a web page's title. */
  name?: string;
}

/** The file a video overlay (plain, or tracked with video content) plays; null for any other. */
function videoFileIdOf(o: Overlay | undefined): string | null {
  if (!o) return null;
  if (o.kind === "video") return o.fileId;
  if (o.kind === "tracked" && o.content.kind === "video") return o.content.fileId;
  return null;
}

/**
 * Tag each dropped VIDEO overlay with `kind`, `fileId` and `name`. `overlays` is what was
 * exported; `fileNames` maps a file id to its row's `name` / `filename`. An overlay the manifest
 * doesn't hold, or that isn't a video, passes through as `{ id, message }`.
 */
export function describeDroppedOverlays(
  dropped: Array<{ id: string; message: string }>,
  overlays: Overlay[],
  fileNames: ReadonlyMap<string, { name: string; filename: string }>,
): DroppedOverlay[] {
  const byId = new Map(overlays.map((o) => [o.id, o]));
  return dropped.map(({ id, message }) => {
    const fileId = videoFileIdOf(byId.get(id));
    if (!fileId) return { id, message };
    const row = fileNames.get(fileId);
    const name = row ? row.name.trim() || row.filename : undefined;
    const cause = message.startsWith(VIDEO_LOAD_FAILURE_MESSAGE) ? ("load" as const) : ("frames" as const);
    return { id, message, kind: "video" as const, cause, fileId, ...(name ? { name } : {}) };
  });
}

/** The files of the VIDEO overlays a drop list names — what the runner looks names up for. */
export function droppedVideoFileIds(dropped: Array<{ id: string }>, overlays: Overlay[]): string[] {
  const byId = new Map(overlays.map((o) => [o.id, o]));
  const ids = new Set<string>();
  for (const d of dropped) {
    const fileId = videoFileIdOf(byId.get(d.id));
    if (fileId) ids.add(fileId);
  }
  return [...ids];
}

const NAMES_SHOWN = 3;

/** “a”, “b” and “c” / “a”, “b”, “c” and 2 more. */
function listNames(names: string[]): string {
  const shown = names.slice(0, NAMES_SHOWN);
  const more = names.length - shown.length;
  if (more > 0) return `${shown.join(", ")} and ${more} more`;
  if (shown.length === 1) return shown[0];
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

const clipCount = (n: number) => (n === 1 ? "1 clip" : `${n} clips`);

/**
 * The in-app line for an export that went out without some of its clips — "Exported without 1
 * clip: “beach.mp4” couldn't be played." for a clip that could not be loaded at all, and a
 * separate, milder sentence for one that failed only on some frames. Clips are counted by FILE:
 * two overlays playing one broken file are one clip. Null when no clip was dropped. Only VIDEO
 * drops: a code overlay that failed on some frames already shows its error badge in the editor,
 * and its fix is the agent's (the export result tells it).
 */
export function droppedClipsNote(dropped: DroppedOverlay[] | undefined): string | null {
  // One entry per file; "load" wins over "frames" for a file dropped both ways.
  const byFile = new Map<string, DroppedOverlay>();
  for (const d of dropped ?? []) {
    if (d.kind !== "video") continue;
    const key = d.fileId ?? `overlay:${d.id}`;
    const seen = byFile.get(key);
    if (!seen || (seen.cause !== "load" && d.cause === "load")) byFile.set(key, d);
  }
  if (!byFile.size) return null;
  const label = (c: DroppedOverlay) => (c.name ? `“${c.name}”` : "an unnamed clip");
  const clips = [...byFile.values()];
  const unloaded = clips.filter((c) => c.cause !== "frames").map(label);
  const partial = clips.filter((c) => c.cause === "frames").map(label);
  const parts: string[] = [];
  if (unloaded.length) {
    parts.push(`Exported without ${clipCount(unloaded.length)}: ${listNames(unloaded)} couldn't be played.`);
  }
  if (partial.length) {
    parts.push(
      `${clipCount(partial.length)} failed on some frames and ${partial.length === 1 ? "is" : "are"} missing there: ${listNames(partial)}.`,
    );
  }
  return parts.join(" ");
}
