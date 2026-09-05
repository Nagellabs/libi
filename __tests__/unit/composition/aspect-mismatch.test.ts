import { describe, it, expect } from "vitest";
import { aspectMismatchWarning } from "@/lib/composition/aspect-mismatch";

const portrait = { compWidth: 1080, compHeight: 1920 };
const fullFrame = { x: 0, y: 0, width: 1080, height: 1920 };
const pip = { x: 40, y: 40, width: 500, height: 281 }; // ~12% of the frame

describe("aspectMismatchWarning", () => {
  it("warns for a full-frame 16:9 clip in a 9:16 piece", () => {
    const w = aspectMismatchWarning({
      ...portrait, mediaWidth: 1920, mediaHeight: 1080, rect: fullFrame,
    });
    expect(w).toMatch(/16:9|1920x1080/);
    expect(w).toMatch(/1080x1920|9:16/);
  });

  it("stays silent for a matching full-frame clip", () => {
    expect(
      aspectMismatchWarning({
        ...portrait, mediaWidth: 1080, mediaHeight: 1920, rect: fullFrame,
      }),
    ).toBeNull();
  });

  it("stays silent for a deliberate picture-in-picture", () => {
    // The coverage gate is what makes this warning usable. Without it every
    // inset warns, and a warning that fires on correct work gets ignored.
    expect(
      aspectMismatchWarning({
        ...portrait, mediaWidth: 1920, mediaHeight: 1080, rect: pip,
      }),
    ).toBeNull();
  });

  it("stays silent when the media dimensions are unknown", () => {
    expect(
      aspectMismatchWarning({
        ...portrait, mediaWidth: null, mediaHeight: null, rect: fullFrame,
      }),
    ).toBeNull();
  });

  it("tolerates a small difference at full frame", () => {
    // 1080x1912 vs 1080x1920 is well under the 10% gate.
    expect(
      aspectMismatchWarning({
        ...portrait, mediaWidth: 1080, mediaHeight: 1912, rect: fullFrame,
      }),
    ).toBeNull();
  });

  it("fires exactly at the coverage boundary but not below it", () => {
    // 80% of 1080x1920 = 1658880 px^2. A rect at 85% warns; one at 75% does not.
    const at85 = { x: 0, y: 0, width: 1080, height: 1632 };
    const at75 = { x: 0, y: 0, width: 1080, height: 1440 };
    const args = { ...portrait, mediaWidth: 1920, mediaHeight: 1080 };
    expect(aspectMismatchWarning({ ...args, rect: at85 })).not.toBeNull();
    expect(aspectMismatchWarning({ ...args, rect: at75 })).toBeNull();
  });

  it("fires just above the 10% aspect gate but not just below it", () => {
    // Without a straddle case the threshold is unpinned: the existing tests
    // sit at ~216% (warns) and ~0.4% (silent), so ASPECT_GATE could be set to
    // anything between 1% and 200% — or flipped to >= — and nothing would
    // fail. comp aspect here is 1080/1920 = 0.5625.
    const at12pct = { ...portrait, mediaWidth: 1080, mediaHeight: 1714, rect: fullFrame }; // 0.6301
    const at8pct = { ...portrait, mediaWidth: 1080, mediaHeight: 1778, rect: fullFrame }; // 0.6074
    expect(aspectMismatchWarning(at12pct)).not.toBeNull();
    expect(aspectMismatchWarning(at8pct)).toBeNull();
  });

  it("returns null for a degenerate composition rather than dividing by zero", () => {
    expect(
      aspectMismatchWarning({
        compWidth: 0, compHeight: 0, mediaWidth: 1920, mediaHeight: 1080, rect: fullFrame,
      }),
    ).toBeNull();
  });
});
