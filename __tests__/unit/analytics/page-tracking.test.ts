import { describe, expect, it } from "vitest";
import { normalizePagePath, makeEngagementTimer } from "@/lib/analytics/page-tracking";

describe("normalizePagePath", () => {
  it("collapses known dynamic segments to templates", () => {
    expect(normalizePagePath("/characters/abc123")).toBe("/characters/[id]");
    expect(normalizePagePath("/items/xyz")).toBe("/items/[id]");
    expect(normalizePagePath("/mcps-skills/skills/my-skill")).toBe("/mcps-skills/skills/[name]");
  });
  it("passes through static routes unchanged", () => {
    expect(normalizePagePath("/editor")).toBe("/editor");
    expect(normalizePagePath("/settings")).toBe("/settings");
  });
});

describe("makeEngagementTimer", () => {
  it("reports elapsed ms for the left page", () => {
    const t = makeEngagementTimer();
    t.enter("/editor", 1000);
    const left = t.leave(1500);
    expect(left).toEqual({ page_path: "/editor", engagement_msec: 500 });
  });
  it("returns null if nothing was entered", () => {
    expect(makeEngagementTimer().leave(10)).toBeNull();
  });
});
