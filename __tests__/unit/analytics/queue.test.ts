import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_ATTEMPTS,
  backoffMs,
  drainAnalyticsQueue,
  enqueueAnalyticsEvent,
  runScheduledDrain,
  __resetAnalyticsQueueForTests,
} from "@/lib/analytics/queue";

describe("backoffMs", () => {
  it("grows exponentially so a dead network is not hammered", () => {
    expect(backoffMs(1)).toBeLessThan(backoffMs(2));
    expect(backoffMs(2)).toBeLessThan(backoffMs(3));
  });

  it("caps, so a long-offline install still retries on a sane cadence", () => {
    expect(backoffMs(MAX_ATTEMPTS)).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  it("starts within a minute — a transient blip should not delay the funnel", () => {
    expect(backoffMs(1)).toBeLessThanOrEqual(60_000);
  });
});

describe("enqueueAnalyticsEvent", () => {
  beforeEach(() => __resetAnalyticsQueueForTests());

  it("never throws, whatever the caller passes", () => {
    expect(() => enqueueAnalyticsEvent("agent_connected")).not.toThrow();
    // A caller passing junk must not take down the flow it was measuring.
    expect(() =>
      enqueueAnalyticsEvent("agent_connected", { nested: { a: 1 }, u: undefined }),
    ).not.toThrow();
  });

  it("returns synchronously — callers never await analytics", () => {
    const r = enqueueAnalyticsEvent("agent_connected");
    expect(r).toBeUndefined();
  });

  it("writes nothing at all when the hard kill-switch is set", async () => {
    // LIBI_ANALYTICS_DISABLED=1 is the user's hard kill-switch.
    // ANALYTICS_KILL_SWITCH is a module-load-time constant, so it can only
    // be exercised by stubbing the env var and reloading the module fresh
    // — same shape as the restart-durability test below.
    vi.stubEnv("LIBI_ANALYTICS_DISABLED", "1");
    vi.resetModules();
    try {
      const fresh = await import("@/lib/analytics/queue");
      fresh.__resetAnalyticsQueueForTests();
      fresh.enqueueAnalyticsEvent("agent_connected");

      const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const r = await fresh.drainAnalyticsQueue({ fetchImpl });
      // Queuing rows that will never be sent and never cleared is exactly
      // what a kill-switch must not do — assert nothing was ever queued,
      // not merely that the drain happened not to send it.
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(r).toEqual({ sent: 0, failed: 0, dropped: 0 });
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("writes nothing once the user has opted out in settings", async () => {
    const { setAnalyticsSettings } = await import("@/lib/db/settings");
    setAnalyticsSettings({ enabled: false });
    try {
      enqueueAnalyticsEvent("agent_connected");

      // Drain with settings forced back to enabled: if enqueue had actually
      // written a row despite the opt-out, this would send it. The drain
      // itself already clears the queue on opt-out (requirement #2) — the
      // hole this closes is a build where the drain never starts at all,
      // which would otherwise leave the opted-out user's rows sitting on
      // disk forever.
      const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      const r = await drainAnalyticsQueue({
        fetchImpl,
        getSettings: () => ({
          enabled: true,
          userId: "u",
          optOutAt: null,
          firstRunNoticeShown: true,
          milestones: [],
        }),
      });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(r.sent).toBe(0);
    } finally {
      setAnalyticsSettings({ enabled: true, optOutAt: null });
    }
  });
});

describe("drainAnalyticsQueue", () => {
  beforeEach(() => __resetAnalyticsQueueForTests());

  it("sends a queued event and removes it on 2xx", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    enqueueAnalyticsEvent("agent_connected", { agent: "codex" });
    const r1 = await drainAnalyticsQueue({ fetchImpl });
    expect(r1.sent).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const url = String(fetchImpl.mock.calls[0][0]);
    expect(url).toContain("en=agent_connected");
    expect(url).toContain("ep.agent=codex");

    // Gone: a second drain has nothing to do.
    const r2 = await drainAnalyticsQueue({ fetchImpl });
    expect(r2.sent).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps the event and backs off when the send fails", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
    enqueueAnalyticsEvent("agent_connected");
    const r = await drainAnalyticsQueue({ fetchImpl, now: () => 1_000 });
    expect(r.sent).toBe(0);
    expect(r.failed).toBe(1);
    // Not due yet, so an immediate re-drain must not re-send.
    const again = await drainAnalyticsQueue({ fetchImpl, now: () => 1_500 });
    expect(again.failed).toBe(0);
    // Due after the backoff.
    const later = await drainAnalyticsQueue({
      fetchImpl,
      now: () => 1_000 + backoffMs(1) + 1,
    });
    expect(later.failed).toBe(1);
  });

  it("treats a non-2xx as a failure — a 400 means we encoded it wrong", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 400 }));
    enqueueAnalyticsEvent("agent_connected");
    const r = await drainAnalyticsQueue({ fetchImpl, now: () => 1_000 });
    expect(r.sent).toBe(0);
    expect(r.failed).toBe(1);
  });

  it("gives up after MAX_ATTEMPTS instead of retrying forever", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
    enqueueAnalyticsEvent("agent_connected");
    let now = 1_000;
    let dropped = 0;
    for (let i = 0; i < MAX_ATTEMPTS + 1; i++) {
      const r = await drainAnalyticsQueue({ fetchImpl, now: () => now });
      dropped += r.dropped;
      now += 60 * 60 * 1000; // always past any backoff
    }
    expect(dropped).toBe(1);
    const after = await drainAnalyticsQueue({ fetchImpl, now: () => now });
    expect(after.failed).toBe(0);
  });

  it("does not send anything at all once the user has opted out", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    enqueueAnalyticsEvent("agent_connected");
    const r = await drainAnalyticsQueue({
      fetchImpl,
      getSettings: () => ({
        enabled: false,
        userId: "u",
        optOutAt: 1,
        firstRunNoticeShown: true,
        milestones: [],
      }),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    // The queue is CLEARED, not merely paused — holding events for someone who
    // opted out is the one behaviour a privacy toggle must not have.
    expect(r.dropped).toBeGreaterThan(0);
    const after = await drainAnalyticsQueue({ fetchImpl });
    expect(after.sent).toBe(0);
  });

  it("opens a GA4 session on the first hit and reuses it on the next", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    enqueueAnalyticsEvent("first_launch");
    enqueueAnalyticsEvent("persona_selected");
    await drainAnalyticsQueue({ fetchImpl });
    const first = new URL(String(fetchImpl.mock.calls[0][0])).searchParams;
    const second = new URL(String(fetchImpl.mock.calls[1][0])).searchParams;
    expect(first.get("_ss")).toBe("1");
    expect(second.get("_ss")).toBeNull();
    expect(second.get("sid")).toBe(first.get("sid"));
    expect(second.get("_s")).toBe("2");
  });

  it("survives a restart — the row is in the DB, not in memory", async () => {
    __resetAnalyticsQueueForTests();
    enqueueAnalyticsEvent("agent_connected");
    // Simulate a restart: throw away every module-level cache, keep the DB.
    vi.resetModules();
    const fresh = await import("@/lib/analytics/queue");
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const r = await fresh.drainAnalyticsQueue({ fetchImpl });
    expect(r.sent).toBe(1);
  });
});

/**
 * Overlapping drains.
 *
 * `startAnalyticsDrain` fires its tick on a fixed 15s interval and did not
 * await the previous one. Rows are NOT reserved — the SELECT filters only on
 * `nextAttemptAt <= now`, and a row is deleted only AFTER its send resolves —
 * so a batch that outruns the interval means the next tick selects the same
 * still-unresolved rows and POSTs them again. `/g/collect` has no idempotency,
 * so every duplicate counts, and over-reporting looks like healthy numbers.
 */
describe("runScheduledDrain — one drain at a time", () => {
  beforeEach(() => __resetAnalyticsQueueForTests());

  it("skips a scheduled tick while the previous drain is still outstanding", async () => {
    const pending: Array<(r: Response) => void> = [];
    const fetchImpl = vi.fn(
      () => new Promise<Response>((resolve) => pending.push(resolve)),
    ) as unknown as typeof fetch;

    enqueueAnalyticsEvent("agent_connected");
    enqueueAnalyticsEvent("persona_selected");

    const first = runScheduledDrain({ fetchImpl });
    // The drain runs synchronously up to its first `await fetchImpl(...)`.
    expect(pending.length).toBe(1);

    // The 15s tick lands while row 1 is still in flight. It must not start a
    // second pass over the same unresolved rows.
    const second = runScheduledDrain({ fetchImpl });
    expect(second).toBe(first);
    expect(pending.length).toBe(1);

    pending[0](new Response(null, { status: 204 }));
    await Promise.resolve();
    await Promise.resolve();
    expect(pending.length).toBe(2);
    pending[1](new Response(null, { status: 204 }));
    await first;

    // Two queued rows, two POSTs. Not three, not four.
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
    const names = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => new URL(String(c[0])).searchParams.get("en"),
    );
    expect(new Set(names).size).toBe(2);
  });

  it("lets the next tick run once the outstanding drain has settled", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    enqueueAnalyticsEvent("agent_connected");
    await runScheduledDrain({ fetchImpl });
    enqueueAnalyticsEvent("persona_selected");
    await runScheduledDrain({ fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("releases the guard even when the drain rejects", async () => {
    const boom = vi.fn().mockRejectedValue(new Error("no db"));
    await runScheduledDrain({ getSettings: boom as never });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    enqueueAnalyticsEvent("agent_connected");
    await runScheduledDrain({ fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

/**
 * `_fv` is how GA4 derives New Users. It used to be gated on a module-level
 * `hasAttemptedAnyHit` flag that resets with the process — so every relaunch
 * of libi registered a brand-new user and inflated the funnel's denominator
 * over the life of the install.
 */
describe("first-visit flag — once per install, not once per process", () => {
  beforeEach(() => __resetAnalyticsQueueForTests());

  it("sends _fv on the very first hit and never again, across a restart", async () => {
    const marked = new Set<string>();
    const markMilestoneOnce = vi.fn((name: string) => {
      if (marked.has(name)) return false;
      marked.add(name);
      return true;
    });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));

    enqueueAnalyticsEvent("first_launch");
    await drainAnalyticsQueue({ fetchImpl, markMilestoneOnce });
    expect(new URL(String(fetchImpl.mock.calls[0][0])).searchParams.get("_fv")).toBe("1");

    // Simulate a relaunch: every module-level cache is gone, the persisted
    // milestone is not.
    vi.resetModules();
    const fresh = await import("@/lib/analytics/queue");
    fresh.enqueueAnalyticsEvent("agent_connected");
    await fresh.drainAnalyticsQueue({ fetchImpl, markMilestoneOnce });

    const second = new URL(String(fetchImpl.mock.calls[1][0])).searchParams;
    expect(second.get("_fv")).toBeNull();
    // And it asked the PERSISTED primitive, not an in-process boolean.
    expect(markMilestoneOnce).toHaveBeenCalled();
  });

  it("does not reuse the 'launch' milestone, which already means something else", async () => {
    const markMilestoneOnce = vi.fn(() => true);
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    enqueueAnalyticsEvent("first_launch");
    await drainAnalyticsQueue({ fetchImpl, markMilestoneOnce });
    for (const [name] of markMilestoneOnce.mock.calls as unknown as string[][]) {
      expect(name).not.toBe("launch");
      expect(name).not.toBe("first_message");
    }
  });
});
