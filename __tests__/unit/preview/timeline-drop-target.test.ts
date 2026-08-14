import { describe, it, expect } from "vitest";
import {
  resolveTimelineDropTarget,
  kindFromContentType,
} from "@/lib/preview/timeline-drop-target";

describe("kindFromContentType", () => {
  it("maps mime prefixes to drop kinds", () => {
    expect(kindFromContentType("video/mp4")).toBe("video");
    expect(kindFromContentType("image/png")).toBe("image");
    expect(kindFromContentType("audio/mpeg")).toBe("audio");
    expect(kindFromContentType("application/pdf")).toBe(null);
    expect(kindFromContentType("")).toBe(null);
  });
});

describe("resolveTimelineDropTarget", () => {
  const base = { contentWidth: 1000, durationSec: 10, maxZ: 4 };

  it("empty piece → start 0, first lane, kind's default group", () => {
    const r = resolveTimelineDropTarget({
      ...base,
      contentX: 500,
      durationSec: 0,
      contentType: "video/mp4",
      zone: "empty",
    });
    expect(r).toEqual({ kind: "video", startTime: 0, z: 0, group: "stickers" });
  });

  it("existing lane → start from x, inherits the lane's z/group", () => {
    const r = resolveTimelineDropTarget({
      ...base,
      contentX: 250, // 25% of 1000 → 2.5s of 10s
      contentType: "image/png",
      zone: { z: 3, group: "captions" },
    });
    expect(r.kind).toBe("image");
    expect(r.startTime).toBeCloseTo(2.5, 5);
    expect(r.z).toBe(3);
    expect(r.group).toBe("captions");
  });

  it("＋ new track → z = maxZ + 1, group from kind", () => {
    const r = resolveTimelineDropTarget({
      ...base,
      contentX: 1000,
      contentType: "video/mp4",
      zone: "newTrack",
    });
    expect(r.z).toBe(5);
    expect(r.group).toBe("stickers");
    expect(r.startTime).toBeCloseTo(10, 5);
  });

  it("audio content → kind audio, no lane group", () => {
    const r = resolveTimelineDropTarget({
      ...base,
      contentX: 500,
      contentType: "audio/wav",
      zone: "newTrack",
    });
    expect(r.kind).toBe("audio");
    expect(r.group).toBeUndefined();
    expect(r.startTime).toBeCloseTo(5, 5);
  });

  it("clamps x outside the content area", () => {
    expect(
      resolveTimelineDropTarget({ ...base, contentX: -50, contentType: "video/mp4", zone: "newTrack" }).startTime,
    ).toBe(0);
    expect(
      resolveTimelineDropTarget({ ...base, contentX: 5000, contentType: "video/mp4", zone: "newTrack" }).startTime,
    ).toBeCloseTo(10, 5);
  });
});
