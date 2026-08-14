import { describe, it, expect } from "vitest";
import { isClipStale } from "@/lib/storyboard/stale";
import type { StoryboardCard } from "@/lib/storyboard/types";

const base: StoryboardCard = {
  id: "c1", order: 0, durationSec: 5, role: "scene", kind: "ai-video",
  title: "t",
  sketches: [{ id: "sk_1", role: "start", paramKey: "start_frame", render: { kind: "satori", file: "sketches/sk_1/unit.jsx" } }],
  camera: { shot: "medium" }, promptFragment: "p", stage: "clip", approvals: {},
};

describe("isClipStale", () => {
  it("false when there is no clipGen", () => {
    expect(isClipStale(base)).toBe(false);
  });
  it("false when clipGen has no editedAt", () => {
    expect(isClipStale({ ...base, clipGen: { apiUrl: "a", model: "m", params: {} } })).toBe(false);
  });
  it("false when there are no takes yet (nothing generated to be stale against)", () => {
    expect(isClipStale({ ...base, clipGen: { apiUrl: "a", model: "m", params: {}, editedAt: 100 } })).toBe(false);
  });
  it("true when an edit happened after the selected take was generated", () => {
    const card: StoryboardCard = {
      ...base,
      clipGen: { apiUrl: "a", model: "m", params: {}, editedAt: 200 },
      clips: [{ id: "t1", fileId: "f", label: "v1", createdAt: 100 }],
      selectedClipId: "t1",
    };
    expect(isClipStale(card)).toBe(true);
  });
  it("false when the selected take is newer than the last edit (freshly regenerated)", () => {
    const card: StoryboardCard = {
      ...base,
      clipGen: { apiUrl: "a", model: "m", params: {}, editedAt: 100 },
      clips: [{ id: "t1", fileId: "f", label: "v1", createdAt: 200 }],
      selectedClipId: "t1",
    };
    expect(isClipStale(card)).toBe(false);
  });
  it("compares against the newest VISIBLE take when none is selected", () => {
    const card: StoryboardCard = {
      ...base,
      clipGen: { apiUrl: "a", model: "m", params: {}, editedAt: 150 },
      clips: [{ id: "t1", fileId: "f", label: "v1", createdAt: 100 }],
    };
    expect(isClipStale(card)).toBe(true);
  });
});
