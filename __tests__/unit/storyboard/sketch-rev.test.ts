import { describe, it, expect } from "vitest";
import { sketchRev } from "@/lib/storyboard/sketch-rev";

describe("sketchRev", () => {
  it("produces an identical rev for identical bytes", () => {
    const bytes = Buffer.from("same png content");
    expect(sketchRev(Buffer.from(bytes))).toBe(sketchRev(Buffer.from(bytes)));
  });

  it("produces a different rev for different bytes", () => {
    // The property that matters for cache-busting: this is what
    // handleStoryboardChange's unconditional per-card re-render
    // (lib/storyboard/watcher.ts) means a text-only edit must NOT trip,
    // but an actual drawing change must.
    expect(sketchRev(Buffer.from("drawing v1"))).not.toBe(sketchRev(Buffer.from("drawing v2")));
  });
});
