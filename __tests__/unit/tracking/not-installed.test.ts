import { describe, it, expect } from "vitest";
import { trackingNotInstalledError } from "@/lib/tracking/not-installed";

describe("trackingNotInstalledError", () => {
  it("is a structured, agent-actionable error payload", () => {
    const e = trackingNotInstalledError();
    expect(e.error).toBe("tracking_engine_not_installed");
    expect(typeof e.data.hint).toBe("string");
    expect(e.data.hint.length).toBeGreaterThan(0);
    expect(e.data.installPlanPath).toBe("mcp/bundled-mcps/plans/libi-tracking.md");
  });
});
