import { describe, it, expect, vi, afterEach } from "vitest";
import {
  fetchFalCost,
  billingWindowStart,
  FAL_BILLING_URL,
} from "@/lib/fal/billing";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(handler: (url: string) => Response | Error) {
  const calls: string[] = [];
  globalThis.fetch = (vi.fn(async (url: string | URL | Request) => {
    const u = typeof url === "string" ? url : (url as Request).url ?? String(url);
    calls.push(u);
    const out = handler(u);
    if (out instanceof Error) throw out;
    return out;
  }) as unknown) as typeof fetch;
  return calls;
}

describe("billingWindowStart", () => {
  it("subtracts a 7-day skew margin from a valid generatedAt (stored timestamps can be local-mislabeled-UTC)", () => {
    expect(billingWindowStart("2026-06-11T12:00:00.000Z")).toBe(
      "2026-06-04T12:00:00.000Z",
    );
  });

  it("falls back to a 90-day window when generatedAt is missing or invalid", () => {
    const now = Date.parse("2026-07-04T00:00:00.000Z");
    const expected = new Date(
      now - 90 * 24 * 3600 * 1000 - 7 * 24 * 3600 * 1000,
    ).toISOString();
    expect(billingWindowStart(undefined, now)).toBe(expected);
    expect(billingWindowStart("not-a-date", now)).toBe(expected);
  });
});

describe("fetchFalCost", () => {
  const base = { requestId: "req-1", apiKey: "k" };

  it("sends request_id AND an explicit start (fal defaults start to 24h ago)", async () => {
    const calls = mockFetch(
      () => new Response(JSON.stringify({ billing_events: [] }), { status: 200 }),
    );
    await fetchFalCost({ ...base, generatedAt: "2026-06-11T12:00:00.000Z" });
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]);
    expect(`${url.origin}${url.pathname}`).toBe(FAL_BILLING_URL);
    expect(url.searchParams.get("request_id")).toBe("req-1");
    expect(url.searchParams.get("start")).toBe("2026-06-04T12:00:00.000Z");
  });

  it("resolves nano-USD to USD", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({ billing_events: [{ cost_estimate_nano_usd: 83_200_000 }] }),
          { status: 200 },
        ),
    );
    expect(await fetchFalCost(base)).toEqual({ kind: "resolved", amountUsd: 0.0832 });
  });

  it("is pending on an empty event list and on a 0-cost placeholder event", async () => {
    mockFetch(
      () => new Response(JSON.stringify({ billing_events: [] }), { status: 200 }),
    );
    expect(await fetchFalCost(base)).toEqual({ kind: "pending" });

    mockFetch(
      () =>
        new Response(
          JSON.stringify({ billing_events: [{ cost_estimate_nano_usd: 0 }] }),
          { status: 200 },
        ),
    );
    expect(await fetchFalCost(base)).toEqual({ kind: "pending" });
  });

  it("is forbidden on 403 and 401 (fal billing needs an ADMIN-scoped key)", async () => {
    for (const status of [403, 401]) {
      mockFetch(
        () =>
          new Response(
            JSON.stringify({ error: { type: "authorization_error" } }),
            { status },
          ),
      );
      const outcome = await fetchFalCost(base);
      expect(outcome.kind).toBe("forbidden");
      expect((outcome as { message: string }).message).toMatch(/ADMIN-scoped/);
    }
  });

  it("is an error (with status) on other non-OK responses", async () => {
    mockFetch(() => new Response("boom", { status: 500 }));
    const outcome = await fetchFalCost(base);
    expect(outcome.kind).toBe("error");
    expect((outcome as { status?: number }).status).toBe(500);
  });

  it("is an error on network failure", async () => {
    mockFetch(() => new Error("ECONNREFUSED"));
    const outcome = await fetchFalCost(base);
    expect(outcome.kind).toBe("error");
    expect((outcome as { message: string }).message).toMatch(/ECONNREFUSED/);
  });
});
