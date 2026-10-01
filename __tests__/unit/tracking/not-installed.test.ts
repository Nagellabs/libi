import { describe, it, expect } from "vitest";
import { trackingNotInstalledError, parseTrackingNotInstalled } from "@/lib/tracking/not-installed";

describe("trackingNotInstalledError", () => {
  it("is a structured, agent-actionable error payload", () => {
    const e = trackingNotInstalledError();
    expect(e.error).toBe("tracking_engine_not_installed");
    expect(typeof e.data.hint).toBe("string");
    expect(e.data.hint.length).toBeGreaterThan(0);
    expect(e.data.installPlanPath).toBe("mcp/bundled-mcps/plans/libi-tracking.md");
  });
});

describe("parseTrackingNotInstalled", () => {
  it("reads the contract back from the Error a runner throws, and nothing else", () => {
    expect(parseTrackingNotInstalled(new Error(JSON.stringify(trackingNotInstalledError())))).toEqual(
      trackingNotInstalledError(),
    );
    expect(parseTrackingNotInstalled(new Error("boom"))).toBeNull();
    expect(parseTrackingNotInstalled(new Error('{"error":"other"}'))).toBeNull();
  });
});
