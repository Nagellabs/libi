// lib/export/dropped-overlays.ts — which dropped overlays were video clips (from the manifest,
// never from the render page), and the line the export screen shows for them (F13 UI).
import { describe, it, expect } from "vitest";
import { describeDroppedOverlays, droppedClipsNote, droppedVideoFileIds } from "@/lib/export/dropped-overlays";
import type { Overlay } from "@/lib/engine/types";
import { VIDEO_LOAD_FAILURE_MESSAGE } from "@/lib/export/render-entry-video";

const rect = { x: 0, y: 0, width: 10, height: 10 };
const video = (id: string, fileId: string) =>
  ({ id, kind: "video", fileId, startTime: 0, duration: 1, z: 0, opacity: 1, rect }) as unknown as Overlay;
const trackedVideo = (id: string, fileId: string) =>
  ({ id, kind: "tracked", content: { kind: "video", fileId }, startTime: 0, duration: 1, z: 0, opacity: 1, rect }) as unknown as Overlay;
const code = (id: string) =>
  ({ id, kind: "code", startTime: 0, duration: 1, z: 0, opacity: 1, rect, drawFunction: "" }) as unknown as Overlay;

const overlays = [video("v1", "f1"), trackedVideo("t1", "f2"), code("c1"), video("v3", "f3")];
const names = new Map([
  ["f1", { name: "Beach take", filename: "beach.mp4" }],
  ["f2", { name: "  ", filename: "tracked.mp4" }],
]);

describe("describeDroppedOverlays", () => {
  it("tags plain and tracked video drops with kind, fileId and name; leaves a body drop alone", () => {
    const load = `${VIDEO_LOAD_FAILURE_MESSAGE}: HTTP 404`;
    const out = describeDroppedOverlays(
      [
        { id: "v1", message: load },
        { id: "t1", message: "InvalidStateError: the VideoFrame is closed" },
        { id: "c1", message: "c" },
        { id: "v3", message: load },
        { id: "gone", message: "e" },
      ],
      overlays,
      names,
    );
    expect(out).toEqual([
      { id: "v1", message: load, kind: "video", cause: "load", fileId: "f1", name: "Beach take" },
      // A draw failure on some frames, not a load failure; a blank display name falls back to the
      // stored filename.
      { id: "t1", message: "InvalidStateError: the VideoFrame is closed", kind: "video", cause: "frames", fileId: "f2", name: "tracked.mp4" },
      { id: "c1", message: "c" },
      // A file with no row still counts as a video, just unnamed.
      { id: "v3", message: load, kind: "video", cause: "load", fileId: "f3" },
      { id: "gone", message: "e" },
    ]);
  });

  it("ignores a kind the render page tried to claim — only the manifest decides", () => {
    const forged = [{ id: "c1", message: "x", kind: "video", fileId: "f1" }] as unknown as Array<{ id: string; message: string }>;
    expect(describeDroppedOverlays(forged, overlays, names)).toEqual([{ id: "c1", message: "x" }]);
  });

  it("droppedVideoFileIds lists each dropped clip's file once", () => {
    expect(droppedVideoFileIds([{ id: "v1" }, { id: "c1" }, { id: "t1" }, { id: "v1" }], overlays)).toEqual(["f1", "f2"]);
  });
});

describe("droppedClipsNote", () => {
  let n = 0;
  const clip = (name?: string, cause: "load" | "frames" = "load", fileId = `f${++n}`) => ({
    id: `o${++n}`, message: "m", kind: "video" as const, cause, fileId, ...(name ? { name } : {}),
  });

  it("is null with nothing dropped, or only body overlays dropped", () => {
    expect(droppedClipsNote(undefined)).toBeNull();
    expect(droppedClipsNote([])).toBeNull();
    expect(droppedClipsNote([{ id: "c1", message: "render: boom" }])).toBeNull();
  });

  it("names one clip", () => {
    expect(droppedClipsNote([clip("beach.mp4")])).toBe("Exported without 1 clip: “beach.mp4” couldn't be played.");
  });

  it("lists two and three clips, and counts the rest past three", () => {
    expect(droppedClipsNote([clip("a"), clip("b")])).toBe("Exported without 2 clips: “a” and “b” couldn't be played.");
    expect(droppedClipsNote([clip("a"), clip("b"), clip("c")])).toBe(
      "Exported without 3 clips: “a”, “b” and “c” couldn't be played.",
    );
    expect(droppedClipsNote([clip("a"), clip("b"), clip("c"), clip("d"), clip("e")])).toBe(
      "Exported without 5 clips: “a”, “b”, “c” and 2 more couldn't be played.",
    );
  });

  it("says 'an unnamed clip' when the file row is gone", () => {
    expect(droppedClipsNote([clip()])).toBe("Exported without 1 clip: an unnamed clip couldn't be played.");
  });

  it("counts clips by file: two overlays of one broken file are one clip", () => {
    expect(droppedClipsNote([clip("beach.mp4", "load", "f-same"), clip("beach.mp4", "load", "f-same")])).toBe(
      "Exported without 1 clip: “beach.mp4” couldn't be played.",
    );
  });

  it("words a clip that failed on some frames apart from one that couldn't be loaded", () => {
    expect(droppedClipsNote([clip("walk.mp4", "frames")])).toBe("1 clip failed on some frames and is missing there: “walk.mp4”.");
    expect(droppedClipsNote([clip("beach.mp4"), clip("a", "frames"), clip("b", "frames")])).toBe(
      "Exported without 1 clip: “beach.mp4” couldn't be played. 2 clips failed on some frames and are missing there: “a” and “b”.",
    );
    // One file dropped both ways reads as the stronger: not loaded.
    expect(droppedClipsNote([clip("x.mp4", "frames", "f-x"), clip("x.mp4", "load", "f-x")])).toBe(
      "Exported without 1 clip: “x.mp4” couldn't be played.",
    );
  });
});
