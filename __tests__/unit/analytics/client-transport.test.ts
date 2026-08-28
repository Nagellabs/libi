// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("browser analytics transport", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("never injects a third-party script", async () => {
    const { initAnalytics } = await import("@/lib/analytics/client");
    initAnalytics("install-uuid");
    const scripts = Array.from(document.querySelectorAll("script")).map((s) => s.src);
    expect(scripts.some((s) => s.includes("googletagmanager"))).toBe(false);
  });

  it("posts events to libi's own server, not to Google", async () => {
    const { initAnalytics, trackEvent } = await import("@/lib/analytics/client");
    initAnalytics("install-uuid");
    trackEvent("piece_created", { source: "ui" });
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/api/analytics/event");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      name: "piece_created",
      params: { source: "ui" },
    });
  });

  it("does not drop events fired before init resolves", async () => {
    // The old transport no-op'd until gtag loaded, so the earliest — and most
    // interesting — events in a new install's session were lost.
    const { trackEvent } = await import("@/lib/analytics/client");
    trackEvent("first_launch");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("stops sending after a live opt-out, with no reload", async () => {
    const { trackEvent, setClientAnalyticsEnabled } = await import("@/lib/analytics/client");
    setClientAnalyticsEnabled(false);
    trackEvent("piece_created");
    expect(globalThis.fetch).not.toHaveBeenCalled();
    setClientAnalyticsEnabled(true);
    trackEvent("piece_created");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("swallows a failed send — analytics must never surface to the user", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("server down")));
    const { trackEvent } = await import("@/lib/analytics/client");
    expect(() => trackEvent("piece_created")).not.toThrow();
  });
});
