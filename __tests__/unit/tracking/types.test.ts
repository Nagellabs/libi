import { describe, it, expect } from "vitest";
import type { Track, TrackedContent } from "@/lib/tracking/types";

describe("tracking types", () => {
  it("Track interface accepts a fully-formed track", () => {
    const t: Track = {
      id: "trk-1",
      fileId: "file-1",
      method: "mediapipe-face",
      framerate: 30,
      durationSec: 1.0,
      samples: [
        { t: 0, x: 0, y: 0, w: 10, h: 10, confidence: 0.9, visible: true },
        { t: 1 / 30, x: 1, y: 0, w: 10, h: 10, confidence: 0.9, visible: true },
      ],
    };
    expect(t.samples).toHaveLength(2);
  });

  it("TrackedContent union covers all six kinds", () => {
    const contents: TrackedContent[] = [
      { kind: "emoji", char: "😀" },
      { kind: "text", content: "hi", font: "48px Inter", color: "#fff", align: "center" },
      { kind: "image", fileId: "img-1" },
      { kind: "video", fileId: "vid-1" },
      { kind: "code", drawFunction: "ctx.fillRect(0,0,10,10)" },
      { kind: "effect", op: "blur" },
    ];
    expect(contents).toHaveLength(6);
  });
});
