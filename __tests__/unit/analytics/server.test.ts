import { beforeEach, describe, expect, it, vi } from "vitest";
import { trackServerEvent } from "@/lib/analytics/server";
import { enqueueAnalyticsEvent } from "@/lib/analytics/queue";

// trackServerEvent used to be a Measurement Protocol client (buildMpPayload +
// a direct fetch to mp/collect, gated on an api_secret nothing ever set — see
// lib/analytics/config.ts). It is now a one-line delegation to
// enqueueAnalyticsEvent (lib/analytics/queue.ts), so this file's only job is
// to prove that delegation — name and params forwarded, synchronous, never
// throws. The queue's own durability, opt-out and retry behaviour is Task
// 2's surface and is thoroughly covered by queue.test.ts, which owns the
// real, file-backed DB round-trip; re-proving it here against the same
// on-disk table would race that file's own worker process (both hit the
// same LIBI_HOME DB — vitest.config.ts isolates it once per run, not per
// worker) and produce a flaky, cross-file-dependent test for no coverage
// gained. Mock the queue at the module boundary instead.
vi.mock("@/lib/analytics/queue", () => ({
  enqueueAnalyticsEvent: vi.fn(),
}));

describe("trackServerEvent", () => {
  beforeEach(() => {
    vi.mocked(enqueueAnalyticsEvent).mockReset();
  });

  it("forwards the name and params to the queue, unchanged", () => {
    trackServerEvent("tool_used", { tool_name: "libi.x" });
    expect(enqueueAnalyticsEvent).toHaveBeenCalledTimes(1);
    expect(enqueueAnalyticsEvent).toHaveBeenCalledWith("tool_used", { tool_name: "libi.x" });
  });

  it("forwards a call with no params as-is", () => {
    trackServerEvent("tool_used");
    expect(enqueueAnalyticsEvent).toHaveBeenCalledWith("tool_used", undefined);
  });

  it("is synchronous — there is nothing for a caller to await", () => {
    const r = trackServerEvent("tool_used", { tool_name: "libi.x" });
    expect(r).toBeUndefined();
  });

  it("never throws, even when the queue itself throws", () => {
    vi.mocked(enqueueAnalyticsEvent).mockImplementation(() => {
      throw new Error("queue exploded");
    });
    expect(() => trackServerEvent("tool_used")).not.toThrow();
  });
});
