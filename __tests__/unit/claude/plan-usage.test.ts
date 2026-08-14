import { describe, it, expect } from "vitest";
import {
  extractAccessToken,
  parsePlanUsageResponse,
} from "@/lib/claude/plan-usage";

describe("extractAccessToken", () => {
  it("pulls the OAuth access token from Claude Code credentials JSON", () => {
    expect(
      extractAccessToken(
        JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat-abc" } }),
      ),
    ).toBe("sk-ant-oat-abc");
  });

  it("returns null for malformed / missing shapes", () => {
    expect(extractAccessToken("not json")).toBeNull();
    expect(extractAccessToken("{}")).toBeNull();
    expect(
      extractAccessToken(JSON.stringify({ claudeAiOauth: { accessToken: "" } })),
    ).toBeNull();
    expect(
      extractAccessToken(JSON.stringify({ claudeAiOauth: { accessToken: 42 } })),
    ).toBeNull();
  });
});

describe("parsePlanUsageResponse", () => {
  it("parses top-level windows with ISO resets_at", () => {
    const out = parsePlanUsageResponse({
      five_hour: { utilization: 32, resets_at: "2026-07-05T03:00:00Z" },
      seven_day: { utilization: 74, resets_at: "2026-07-08T00:00:00Z" },
    });
    expect(out?.fiveHour).toEqual({
      utilization: 32,
      resetsAt: Math.floor(Date.parse("2026-07-05T03:00:00Z") / 1000),
    });
    expect(out?.sevenDay?.utilization).toBe(74);
    expect(out?.sevenDayOpus).toBeNull();
  });

  it("parses windows nested under rate_limits (SDK getUsage mirror shape)", () => {
    const out = parsePlanUsageResponse({
      rate_limits: {
        five_hour: { utilization: 10, resets_at: "2026-07-05T03:00:00Z" },
        seven_day_opus: { utilization: 5, resets_at: null },
      },
    });
    expect(out?.fiveHour?.utilization).toBe(10);
    expect(out?.sevenDayOpus).toEqual({ utilization: 5, resetsAt: null });
  });

  it("accepts numeric epoch resets_at and null utilization", () => {
    const out = parsePlanUsageResponse({
      five_hour: { utilization: null, resets_at: 1_760_000_000 },
    });
    expect(out?.fiveHour).toEqual({ utilization: null, resetsAt: 1_760_000_000 });
  });

  it("returns null when no window is recognizable", () => {
    expect(parsePlanUsageResponse(null)).toBeNull();
    expect(parsePlanUsageResponse({})).toBeNull();
    expect(parsePlanUsageResponse({ five_hour: "busy" })).toBeNull();
    expect(parsePlanUsageResponse({ rate_limits: {} })).toBeNull();
  });
});
