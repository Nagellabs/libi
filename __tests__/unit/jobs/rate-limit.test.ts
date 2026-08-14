import { describe, it, expect, afterEach, beforeAll } from "vitest";
import {
  SlidingWindowRateLimiter,
  isPaidJobKind,
  checkPaidJobRateLimit,
  __resetPaidJobRateLimiterForTests,
  PAID_JOB_RATE_LIMIT,
  PAID_JOB_RATE_WINDOW_MS,
} from "@/lib/jobs/rate-limit";
import {
  __resetRunnerRegistryForTests,
  registerBuiltinRunners,
} from "@/lib/jobs/runners/registry";

// isPaidJobKind sources truth from the runner registry's `paid` flag, so the
// built-in runners must be registered before the classification assertions run.
beforeAll(() => {
  __resetRunnerRegistryForTests();
  registerBuiltinRunners();
});

describe("SlidingWindowRateLimiter", () => {
  it("allows exactly `limit` hits within the window, then limits", () => {
    const rl = new SlidingWindowRateLimiter(3, 1000);
    expect(rl.check(0).allowed).toBe(true);
    expect(rl.check(100).allowed).toBe(true);
    expect(rl.check(200).allowed).toBe(true);
    const denied = rl.check(300);
    expect(denied.allowed).toBe(false);
    // Oldest hit was at t=0; frees at t=1000, so 700ms from now (t=300).
    expect(denied.retryAfterMs).toBe(700);
  });

  it("slides: a hit aging out of the window frees a slot", () => {
    const rl = new SlidingWindowRateLimiter(2, 1000);
    expect(rl.check(0).allowed).toBe(true);
    expect(rl.check(500).allowed).toBe(true);
    expect(rl.check(900).allowed).toBe(false);
    // At t=1001 the first hit (t=0) has expired → one slot free again.
    expect(rl.check(1001).allowed).toBe(true);
    // But the window is full again (t=500 and t=1001 in window).
    expect(rl.check(1002).allowed).toBe(false);
  });

  it("fully resets after the whole window elapses", () => {
    const rl = new SlidingWindowRateLimiter(2, 1000);
    rl.check(0);
    rl.check(10);
    expect(rl.check(20).allowed).toBe(false);
    // Well past the window — all prior hits expired.
    expect(rl.check(5000).allowed).toBe(true);
    expect(rl.check(5001).allowed).toBe(true);
    expect(rl.check(5002).allowed).toBe(false);
  });

  it("reset() clears the recorded hits", () => {
    const rl = new SlidingWindowRateLimiter(1, 1000);
    expect(rl.check(0).allowed).toBe(true);
    expect(rl.check(1).allowed).toBe(false);
    rl.reset();
    expect(rl.check(2).allowed).toBe(true);
  });
});

describe("paid job classification", () => {
  it("classifies the two fal.ai-backed kinds as paid", () => {
    expect(isPaidJobKind("tracking_provider")).toBe(true);
    expect(isPaidJobKind("extra_analysis_model")).toBe(true);
  });

  it("classifies local kinds as non-paid", () => {
    for (const kind of [
      "proxy_gen",
      "filmstrip_gen",
      "export",
      "export_render",
      "tracking",
      "music_generate",
      "whisper_model_download",
      "tts_model_download",
      "music_model_download",
      "piece_dup",
      "remote_fetch",
      "analysis_describe_frame",
      "dev_slow",
    ]) {
      expect(isPaidJobKind(kind)).toBe(false);
    }
  });
});

describe("checkPaidJobRateLimit", () => {
  afterEach(() => __resetPaidJobRateLimiterForTests());

  it("never limits non-paid kinds regardless of volume", () => {
    for (let i = 0; i < PAID_JOB_RATE_LIMIT * 5; i++) {
      expect(checkPaidJobRateLimit("proxy_gen", i).allowed).toBe(true);
    }
  });

  it("limits a paid kind past PAID_JOB_RATE_LIMIT within the window", () => {
    for (let i = 0; i < PAID_JOB_RATE_LIMIT; i++) {
      expect(checkPaidJobRateLimit("extra_analysis_model", i).allowed).toBe(true);
    }
    const denied = checkPaidJobRateLimit("extra_analysis_model", PAID_JOB_RATE_LIMIT);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it("shares one budget across all paid kinds", () => {
    for (let i = 0; i < PAID_JOB_RATE_LIMIT; i++) {
      expect(checkPaidJobRateLimit("tracking_provider", i).allowed).toBe(true);
    }
    // A different paid kind draws from the same bucket → already exhausted.
    expect(
      checkPaidJobRateLimit("extra_analysis_model", PAID_JOB_RATE_LIMIT).allowed,
    ).toBe(false);
  });

  it("recovers after the window elapses", () => {
    for (let i = 0; i < PAID_JOB_RATE_LIMIT; i++) {
      checkPaidJobRateLimit("tracking_provider", i);
    }
    expect(checkPaidJobRateLimit("tracking_provider", PAID_JOB_RATE_LIMIT).allowed).toBe(
      false,
    );
    expect(
      checkPaidJobRateLimit("tracking_provider", PAID_JOB_RATE_WINDOW_MS + 1).allowed,
    ).toBe(true);
  });
});
