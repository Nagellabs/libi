import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/__tests__/helpers/test-db";

beforeEach(() => {
  createTestDb();
  vi.resetModules();
});

describe("identity route", () => {
  it("returns a userId and enabled flag", async () => {
    const { GET } = await import("@/app/api/analytics/identity/route");
    const res = await GET();
    const json = await res.json();
    expect(typeof json.userId).toBe("string");
    expect(typeof json.enabled).toBe("boolean");
  });
});

describe("event route", () => {
  it("rejects unknown event names with 400", async () => {
    const { POST } = await import("@/app/api/analytics/event/route");
    const req = new Request("http://x/api/analytics/event", {
      method: "POST",
      body: JSON.stringify({ name: "bogus_event" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
  it("accepts a known event name", async () => {
    const { POST } = await import("@/app/api/analytics/event/route");
    const req = new Request("http://x/api/analytics/event", {
      method: "POST",
      body: JSON.stringify({ name: "tool_used", params: { tool_name: "libi.x" } }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });
});

describe("settings/analytics route", () => {
  it("GET returns the setting, PUT updates enabled", async () => {
    const mod = await import("@/app/api/settings/analytics/route");
    const put = await mod.PUT(
      new Request("http://x", { method: "PUT", body: JSON.stringify({ enabled: false }) }),
    );
    expect(put.status).toBe(200);
    const get = await mod.GET();
    const json = await get.json();
    expect(json.enabled).toBe(false);
  });
});
