import { describe, expect, it } from "vitest";
import {
  DEFAULT_ANALYTICS_SETTINGS,
  parseAnalyticsSettings,
  mergeAnalyticsSettings,
  markMilestone,
  applyOptOut,
  applyOptIn,
} from "@/lib/analytics/settings-logic";

describe("parseAnalyticsSettings", () => {
  it("returns defaults for null/malformed", () => {
    expect(parseAnalyticsSettings(null)).toEqual(DEFAULT_ANALYTICS_SETTINGS);
    expect(parseAnalyticsSettings("not json")).toEqual(DEFAULT_ANALYTICS_SETTINGS);
  });
  it("defaults enabled to true when missing", () => {
    expect(parseAnalyticsSettings(JSON.stringify({ userId: "u" })).enabled).toBe(true);
  });
});

describe("markMilestone", () => {
  it("adds a new milestone once", () => {
    const r1 = markMilestone(DEFAULT_ANALYTICS_SETTINGS, "launch");
    expect(r1.added).toBe(true);
    expect(r1.settings.milestones).toContain("launch");
    const r2 = markMilestone(r1.settings, "launch");
    expect(r2.added).toBe(false);
  });
});

describe("opt out / in", () => {
  it("applyOptOut disables and stamps timestamp", () => {
    const s = applyOptOut(DEFAULT_ANALYTICS_SETTINGS, 1234);
    expect(s.enabled).toBe(false);
    expect(s.optOutAt).toBe(1234);
  });
  it("applyOptIn re-enables and clears timestamp", () => {
    const s = applyOptIn(applyOptOut(DEFAULT_ANALYTICS_SETTINGS, 1234));
    expect(s.enabled).toBe(true);
    expect(s.optOutAt).toBeNull();
  });
});

describe("mergeAnalyticsSettings", () => {
  it("overlays partial onto current", () => {
    const s = mergeAnalyticsSettings(DEFAULT_ANALYTICS_SETTINGS, { userId: "abc" });
    expect(s.userId).toBe("abc");
    expect(s.enabled).toBe(true);
  });
});
