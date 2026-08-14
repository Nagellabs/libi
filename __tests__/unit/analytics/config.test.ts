import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAnalyticsEnabled, resolveAnalyticsDebug } from "@/lib/analytics/config";

afterEach(() => vi.unstubAllEnvs());

describe("resolveAnalyticsEnabled", () => {
  it("is true only when opt-in flag set and kill-switch absent", () => {
    expect(resolveAnalyticsEnabled({ NEXT_PUBLIC_LIBI_ANALYTICS: "1" })).toBe(true);
  });
  it("is false by default (dev clone, flag unset)", () => {
    expect(resolveAnalyticsEnabled({})).toBe(false);
  });
  it("kill-switch wins over opt-in", () => {
    expect(
      resolveAnalyticsEnabled({ NEXT_PUBLIC_LIBI_ANALYTICS: "1", LIBI_ANALYTICS_DISABLED: "1" }),
    ).toBe(false);
  });
});

describe("resolveAnalyticsDebug", () => {
  it("is true outside production (sandbox)", () => {
    expect(resolveAnalyticsDebug({ NODE_ENV: "development" })).toBe(true);
  });
  it("is false in production installs", () => {
    expect(resolveAnalyticsDebug({ NODE_ENV: "production" })).toBe(false);
  });
});
