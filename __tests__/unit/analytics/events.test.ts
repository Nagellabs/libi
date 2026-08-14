import { describe, expect, it } from "vitest";
import { EVENT_NAMES, isEventName, sanitizeParams } from "@/lib/analytics/events";

describe("event taxonomy", () => {
  it("includes core events", () => {
    expect(EVENT_NAMES).toContain("tool_used");
    expect(EVENT_NAMES).toContain("page_view");
    expect(EVENT_NAMES).toContain("analytics_opt_out");
  });
  it("includes the onboarding milestones", () => {
    expect(EVENT_NAMES).toContain("persona_selected");
    expect(EVENT_NAMES).toContain("agent_connected");
  });
  it("isEventName guards unknown names", () => {
    expect(isEventName("tool_used")).toBe(true);
    expect(isEventName("definitely_not_real")).toBe(false);
  });
});

describe("sanitizeParams", () => {
  it("drops undefined and truncates long strings to 100 chars", () => {
    const out = sanitizeParams({ a: undefined, b: "x".repeat(150), c: 3 });
    expect(out).not.toHaveProperty("a");
    expect((out.b as string).length).toBe(100);
    expect(out.c).toBe(3);
  });
  it("returns empty object for undefined input", () => {
    expect(sanitizeParams(undefined)).toEqual({});
  });
});
