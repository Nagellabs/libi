import { describe, expect, it } from "vitest";
import { SESSION_TIMEOUT_MS, advanceSession } from "@/lib/analytics/identity";

const T0 = 1_700_000_000_000;

describe("advanceSession", () => {
  it("opens a session on the first hit", () => {
    const { state, sessionStart } = advanceSession(null, T0);
    expect(sessionStart).toBe(true);
    expect(state.hitNumber).toBe(1);
    expect(state.sessionId).toBe(String(Math.floor(T0 / 1000)));
    expect(state.lastHitAt).toBe(T0);
  });

  it("keeps the same session and counts up while hits keep coming", () => {
    const first = advanceSession(null, T0).state;
    const second = advanceSession(first, T0 + 5_000);
    expect(second.sessionStart).toBe(false);
    expect(second.state.sessionId).toBe(first.sessionId);
    expect(second.state.hitNumber).toBe(2);
    expect(second.state.lastHitAt).toBe(T0 + 5_000);
  });

  it("keeps the session alive right up to the timeout", () => {
    const first = advanceSession(null, T0).state;
    const late = advanceSession(first, T0 + SESSION_TIMEOUT_MS);
    expect(late.sessionStart).toBe(false);
    expect(late.state.sessionId).toBe(first.sessionId);
  });

  it("starts a new session once the gap exceeds the timeout", () => {
    const first = advanceSession(null, T0).state;
    const next = advanceSession(first, T0 + SESSION_TIMEOUT_MS + 1);
    expect(next.sessionStart).toBe(true);
    expect(next.state.sessionId).not.toBe(first.sessionId);
    // The counter restarts with the session — GA4 reads `_s` per session.
    expect(next.state.hitNumber).toBe(1);
  });

  it("uses GA4's 30-minute inactivity window", () => {
    expect(SESSION_TIMEOUT_MS).toBe(30 * 60 * 1000);
  });
});
