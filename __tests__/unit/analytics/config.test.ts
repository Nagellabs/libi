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
  // Without this opt-in a RELEASED build can never reach GA4 DebugView — every
  // published artifact is built with NODE_ENV=production — and DebugView is the
  // only view that shows a hit's parameters, so release-day QA could confirm
  // that events arrived but never that they carried the right enums.
  it("a released build opts in with LIBI_ANALYTICS_DEBUG=1", () => {
    expect(
      resolveAnalyticsDebug({ NODE_ENV: "production", LIBI_ANALYTICS_DEBUG: "1" }),
    ).toBe(true);
  });
  it("only the exact value 1 opts in", () => {
    expect(
      resolveAnalyticsDebug({ NODE_ENV: "production", LIBI_ANALYTICS_DEBUG: "true" }),
    ).toBe(false);
    expect(resolveAnalyticsDebug({ NODE_ENV: "production", LIBI_ANALYTICS_DEBUG: "0" })).toBe(
      false,
    );
  });
});
