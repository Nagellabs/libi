// lib/analytics/identity.ts
// Sessionisation, which gtag.js used to do for us.
//
// Dropping gtag means GA4 no longer derives sessions on its own: `sid`, `_s`,
// `_ss` and `_fv` are ours to mint. This module is the whole of that logic, kept
// pure so the rollover boundary is testable without a clock.
//
// The 30-minute inactivity window matches GA4's own default, so sessions counted
// here line up with sessions counted in the dashboard.

export const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

export interface SessionState {
  /** Unix SECONDS at session start, as a string — GA4's `sid` format. */
  sessionId: string;
  lastHitAt: number;
  /** 1-based hit counter WITHIN this session; resets when the session does. */
  hitNumber: number;
}

export function advanceSession(
  prev: SessionState | null,
  nowMs: number,
): { state: SessionState; sessionStart: boolean } {
  const expired = prev === null || nowMs - prev.lastHitAt > SESSION_TIMEOUT_MS;
  if (expired) {
    return {
      state: {
        sessionId: String(Math.floor(nowMs / 1000)),
        lastHitAt: nowMs,
        hitNumber: 1,
      },
      sessionStart: true,
    };
  }
  return {
    state: {
      sessionId: prev.sessionId,
      lastHitAt: nowMs,
      hitNumber: prev.hitNumber + 1,
    },
    sessionStart: false,
  };
}
