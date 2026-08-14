import { describe, it, expect } from "vitest";
import { frameToTimecode } from "@/lib/preview/timecode";

describe("frameToTimecode", () => {
  it("formats frame 0 as 00:00:00:00 (HH:MM:SS:FF)", () => {
    expect(frameToTimecode(0, 30)).toBe("00:00:00:00");
  });
  it("splits hours / minutes / seconds / frame-within-second", () => {
    // 71 frames @ 30fps = 2s + frame 11.
    expect(frameToTimecode(71, 30)).toBe("00:00:02:11");
    // 1 min 5 s, frame 7.
    expect(frameToTimecode(65 * 30 + 7, 30)).toBe("00:01:05:07");
    // 1 h 2 min 3 s, frame 4.
    expect(frameToTimecode((3600 + 2 * 60 + 3) * 30 + 4, 30)).toBe("01:02:03:04");
  });
  it("clamps negative frames and guards a zero fps", () => {
    expect(frameToTimecode(-5, 30)).toBe("00:00:00:00");
    expect(frameToTimecode(45, 0)).toBe("00:00:01:15"); // falls back to 30fps
  });
});
