import { describe, expect, it } from "vitest";
import { COLLECT_ENDPOINT, buildCollectUrl, type CollectEvent } from "@/lib/analytics/collect-url";

function base(over: Partial<CollectEvent> = {}): CollectEvent {
  return {
    name: "agent_connected",
    params: {},
    clientId: "1234567890.1700000000",
    userId: "install-uuid",
    sessionId: "1700000000",
    hitNumber: 1,
    sessionStart: false,
    firstVisit: false,
    debug: false,
    engagementMs: 1,
    ...over,
  };
}

function q(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe("buildCollectUrl", () => {
  it("targets the web-stream collect endpoint, which needs no api_secret", () => {
    const url = buildCollectUrl(base(), "G-TEST");
    expect(url.startsWith(COLLECT_ENDPOINT)).toBe(true);
    // The whole point of this transport: nothing secret is on the wire.
    expect(url).not.toContain("api_secret");
    expect(q(url).get("tid")).toBe("G-TEST");
    expect(q(url).get("v")).toBe("2");
  });

  it("carries the identity GA4 needs to build a session", () => {
    const p = q(buildCollectUrl(base(), "G-TEST"));
    expect(p.get("cid")).toBe("1234567890.1700000000");
    expect(p.get("uid")).toBe("install-uuid");
    expect(p.get("sid")).toBe("1700000000");
    expect(p.get("_s")).toBe("1");
    expect(p.get("en")).toBe("agent_connected");
  });

  it("splits params by type: numbers under epn., everything else under ep.", () => {
    const p = q(
      buildCollectUrl(
        base({ params: { agent: "claude-code", attempt: 3, manual: false } }),
        "G-TEST",
      ),
    );
    expect(p.get("ep.agent")).toBe("claude-code");
    expect(p.get("epn.attempt")).toBe("3");
    expect(p.get("ep.manual")).toBe("false");
    // A number must NOT also appear as a string param, or GA4 registers two
    // dimensions for one field and neither is complete.
    expect(p.get("ep.attempt")).toBeNull();
    expect(p.get("epn.agent")).toBeNull();
  });

  it("flags session start, first visit and debug only when asked", () => {
    const off = q(buildCollectUrl(base(), "G-TEST"));
    expect(off.get("_ss")).toBeNull();
    expect(off.get("_fv")).toBeNull();
    expect(off.get("_dbg")).toBeNull();

    const on = q(
      buildCollectUrl(base({ sessionStart: true, firstVisit: true, debug: true }), "G-TEST"),
    );
    expect(on.get("_ss")).toBe("1");
    expect(on.get("_fv")).toBe("1");
    expect(on.get("_dbg")).toBe("1");
  });

  it("percent-encodes values rather than emitting a broken query string", () => {
    const p = q(buildCollectUrl(base({ params: { reason: "needs auth & retry" } }), "G-TEST"));
    expect(p.get("ep.reason")).toBe("needs auth & retry");
  });

  it("always sends an engagement time, without which GA4 discards the session", () => {
    expect(q(buildCollectUrl(base({ engagementMs: 250 }), "G-TEST")).get("_et")).toBe("250");
    expect(q(buildCollectUrl(base({ engagementMs: 0 }), "G-TEST")).get("_et")).toBe("1");
  });
});
