/**
 * The retry policy every mediabunny `UrlSource` in the app is constructed with.
 *
 * Regression cover for 2026-08-18: mediabunny's DEFAULT policy retries a
 * same-origin fetch failure forever (its only give-up branch is a cross-origin
 * CORS heuristic, and libi media URLs are always same-origin). With the local
 * server gone, every video source spun on an unreachable URL indefinitely,
 * emitting mediabunny's per-attempt `console.error` — which Next's dev overlay
 * renders as "Console TypeError: Failed to fetch" — while never rejecting, so
 * the decode pump's own catch never ran.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  mediaFetchRetryDelay,
  MAX_FETCH_RETRIES,
} from "@/lib/engine/media-fetch-retry";

const URL_STR = "http://127.0.0.1:3456/api/files/video-file-1";
const failure = new TypeError("Failed to fetch");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mediaFetchRetryDelay", () => {
  it("retries a transient failure instead of failing on the first error", () => {
    const delay = mediaFetchRetryDelay(1, failure, URL_STR);
    expect(delay).not.toBeNull();
    expect(delay).toBeGreaterThan(0);
  });

  it("keeps retrying up to MAX_FETCH_RETRIES", () => {
    for (let attempt = 1; attempt <= MAX_FETCH_RETRIES; attempt++) {
      expect(mediaFetchRetryDelay(attempt, failure, URL_STR)).not.toBeNull();
    }
  });

  // THE bug: the default policy never returns null for a same-origin URL.
  it("gives up once the retries are exhausted", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(mediaFetchRetryDelay(MAX_FETCH_RETRIES + 1, failure, URL_STR)).toBeNull();
  });

  it("stays given-up on every later attempt (never resumes the loop)", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const attempt of [MAX_FETCH_RETRIES + 2, 50, 5_000]) {
      expect(mediaFetchRetryDelay(attempt, failure, URL_STR)).toBeNull();
    }
  });

  it("bounds the total time a read can spend retrying to a few seconds", () => {
    let totalSec = 0;
    for (let attempt = 1; ; attempt++) {
      const delay = mediaFetchRetryDelay(attempt, failure, URL_STR);
      if (delay === null) break;
      totalSec += delay;
      // Guards the loop itself: an unbounded policy would never break.
      expect(attempt).toBeLessThanOrEqual(MAX_FETCH_RETRIES);
    }
    // Long enough to ride out a blip, short enough that a frozen preview
    // resolves within one user action.
    expect(totalSec).toBeGreaterThan(1);
    expect(totalSec).toBeLessThan(10);
  });

  it("backs off — each delay is at least as long as the one before it", () => {
    let prev = 0;
    for (let attempt = 1; attempt <= MAX_FETCH_RETRIES; attempt++) {
      const delay = mediaFetchRetryDelay(attempt, failure, URL_STR)!;
      expect(delay).toBeGreaterThanOrEqual(prev);
      prev = delay;
    }
  });

  it("returns finite non-negative delays (mediabunny throws on anything else)", () => {
    for (let attempt = 1; attempt <= MAX_FETCH_RETRIES; attempt++) {
      const delay = mediaFetchRetryDelay(attempt, failure, URL_STR)!;
      expect(Number.isFinite(delay)).toBe(true);
      expect(delay).toBeGreaterThanOrEqual(0);
    }
  });

  it("names the url and the error when it gives up", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mediaFetchRetryDelay(MAX_FETCH_RETRIES + 1, failure, URL_STR);
    expect(warn).toHaveBeenCalledTimes(1);
    const [message, detail] = warn.mock.calls[0];
    expect(String(message)).toContain(URL_STR);
    expect(detail).toBe("Failed to fetch");
  });

  it("does not log while it is still retrying", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let attempt = 1; attempt <= MAX_FETCH_RETRIES; attempt++) {
      mediaFetchRetryDelay(attempt, failure, URL_STR);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  // `UrlSource` accepts a Request or URL, and the give-up log must not throw
  // on either — it runs on the failure path, where a second error is worst.
  it("describes URL and Request sources without throwing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mediaFetchRetryDelay(MAX_FETCH_RETRIES + 1, failure, new URL(URL_STR));
    mediaFetchRetryDelay(MAX_FETCH_RETRIES + 1, failure, new Request(URL_STR));
    for (const call of warn.mock.calls) {
      expect(String(call[0])).toContain("/api/files/video-file-1");
    }
  });

  it("survives a non-Error rejection value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(mediaFetchRetryDelay(MAX_FETCH_RETRIES + 1, "boom", URL_STR)).toBeNull();
    expect(warn.mock.calls[0][1]).toBe("boom");
  });
});
