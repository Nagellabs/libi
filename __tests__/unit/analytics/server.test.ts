import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMpPayload, trackServerEvent } from "@/lib/analytics/server";

afterEach(() => vi.unstubAllEnvs());

describe("buildMpPayload", () => {
  it("sets client_id + user_id to the uuid and includes the event", () => {
    const p = buildMpPayload("uuid-1", "tool_used", { tool_name: "libi.x" }, false);
    expect(p.client_id).toBe("uuid-1");
    expect(p.user_id).toBe("uuid-1");
    expect(p.events[0].name).toBe("tool_used");
    expect(p.events[0].params.tool_name).toBe("libi.x");
  });
  it("adds debug_mode when debug is true", () => {
    const p = buildMpPayload("uuid-1", "tool_used", {}, true);
    expect(p.events[0].params.debug_mode).toBe(true);
  });
});

describe("trackServerEvent gating", () => {
  it("no-ops when analytics disabled (flag unset)", async () => {
    const fetchImpl = vi.fn();
    await trackServerEvent("tool_used", {}, {
      fetchImpl,
      getSettings: () => ({ enabled: true, userId: "u", optOutAt: null, firstRunNoticeShown: false, milestones: [] }),
      apiSecret: "secret",
      enabled: false,
      debug: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("no-ops when user opted out", async () => {
    const fetchImpl = vi.fn();
    await trackServerEvent("tool_used", {}, {
      fetchImpl,
      getSettings: () => ({ enabled: false, userId: "u", optOutAt: 1, firstRunNoticeShown: false, milestones: [] }),
      apiSecret: "secret",
      enabled: true,
      debug: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("no-ops when api secret empty", async () => {
    const fetchImpl = vi.fn();
    await trackServerEvent("tool_used", {}, {
      fetchImpl,
      getSettings: () => ({ enabled: true, userId: "u", optOutAt: null, firstRunNoticeShown: false, milestones: [] }),
      apiSecret: "",
      enabled: true,
      debug: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("POSTs to GA4 when fully enabled", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(undefined);
    await trackServerEvent("tool_used", { tool_name: "libi.x" }, {
      fetchImpl,
      getSettings: () => ({ enabled: true, userId: "u", optOutAt: null, firstRunNoticeShown: false, milestones: [] }),
      apiSecret: "secret",
      enabled: true,
      debug: false,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain("/mp/collect");
    expect(url).toContain("measurement_id=");
    expect(url).toContain("api_secret=secret");
    expect(JSON.parse(init.body).client_id).toBe("u");
  });
});
