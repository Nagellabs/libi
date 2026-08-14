import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "@/__tests__/helpers/test-db";
import {
  getAnalyticsSettings,
  setAnalyticsSettings,
  getOrCreateAnalyticsUserId,
  markAnalyticsMilestoneOnce,
} from "@/lib/db/settings";

beforeEach(() => {
  createTestDb(); // installs the in-memory DB as the getDb() singleton
});

describe("analytics DB helpers", () => {
  it("defaults to enabled with no userId", () => {
    const s = getAnalyticsSettings();
    expect(s.enabled).toBe(true);
    expect(s.userId).toBeNull();
  });
  it("getOrCreateAnalyticsUserId is idempotent", () => {
    const a = getOrCreateAnalyticsUserId();
    const b = getOrCreateAnalyticsUserId();
    expect(a).toBe(b);
    expect(a).toMatch(/[0-9a-f-]{36}/);
  });
  it("setAnalyticsSettings persists a partial", () => {
    setAnalyticsSettings({ enabled: false, optOutAt: 999 });
    const s = getAnalyticsSettings();
    expect(s.enabled).toBe(false);
    expect(s.optOutAt).toBe(999);
  });
  it("markAnalyticsMilestoneOnce returns true once then false", () => {
    expect(markAnalyticsMilestoneOnce("launch")).toBe(true);
    expect(markAnalyticsMilestoneOnce("launch")).toBe(false);
  });
});
