import { describe, it, expect } from "vitest";
import {
  applyUsageUpdate,
  toAvailableCommands,
  type SessionUsageState,
} from "@/lib/sessions/usage";

const NOW = 1_760_000_000_000;

describe("applyUsageUpdate", () => {
  it("parses a plain usage_update", () => {
    const next = applyUsageUpdate(null, { used: 82_000, size: 200_000 }, NOW);
    expect(next).toEqual({
      used: 82_000,
      size: 200_000,
      reportedSize: 200_000,
      cost: null,
      rateLimits: {},
      updatedAt: NOW,
    });
  });

  it("returns prev unchanged on malformed input (experimental-field drift)", () => {
    const prev: SessionUsageState = {
      used: 1, size: 2, reportedSize: 2, cost: null, rateLimits: {}, updatedAt: 5,
    };
    expect(applyUsageUpdate(prev, null, NOW)).toBe(prev);
    expect(applyUsageUpdate(prev, "nope", NOW)).toBe(prev);
    expect(applyUsageUpdate(prev, { used: "82k", size: 200_000 }, NOW)).toBe(prev);
    expect(applyUsageUpdate(prev, { used: 82_000, size: 0 }, NOW)).toBe(prev);
    expect(applyUsageUpdate(prev, { used: -1, size: 200_000 }, NOW)).toBe(prev);
    expect(applyUsageUpdate(null, { used: NaN, size: 200_000 }, NOW)).toBeNull();
  });

  it("extracts cost and carries it forward when a later update omits it", () => {
    const first = applyUsageUpdate(
      null,
      { used: 10, size: 100, cost: { amount: 0.48, currency: "USD" } },
      NOW,
    );
    expect(first?.cost).toEqual({ amount: 0.48, currency: "USD" });
    const second = applyUsageUpdate(first, { used: 20, size: 100 }, NOW + 1);
    expect(second?.cost).toEqual({ amount: 0.48, currency: "USD" });
  });

  it("merges rate-limit snapshots per window type", () => {
    const withFiveHour = applyUsageUpdate(
      null,
      {
        used: 10, size: 100,
        _meta: {
          "_claude/rateLimit": {
            status: "allowed", rateLimitType: "five_hour",
            utilization: 32, resetsAt: 1_760_003_600,
          },
        },
      },
      NOW,
    );
    expect(withFiveHour?.rateLimits.five_hour).toEqual({
      status: "allowed", utilization: 32, resetsAt: 1_760_003_600, updatedAt: NOW,
    });

    const withBoth = applyUsageUpdate(
      withFiveHour,
      {
        used: 12, size: 100,
        _meta: {
          "_claude/rateLimit": {
            status: "allowed_warning", rateLimitType: "seven_day", utilization: 74,
          },
        },
      },
      NOW + 1,
    );
    expect(withBoth?.rateLimits.five_hour?.utilization).toBe(32); // accumulated
    expect(withBoth?.rateLimits.seven_day).toEqual({
      status: "allowed_warning", utilization: 74, resetsAt: null, updatedAt: NOW + 1,
    });
  });

  it("ignores unknown rateLimitType and malformed meta, keeping prev rateLimits", () => {
    const prev = applyUsageUpdate(
      null,
      {
        used: 10, size: 100,
        _meta: { "_claude/rateLimit": { status: "allowed", rateLimitType: "five_hour", utilization: 1 } },
      },
      NOW,
    );
    const next = applyUsageUpdate(
      prev,
      {
        used: 11, size: 100,
        _meta: { "_claude/rateLimit": { status: "allowed", rateLimitType: "lunar_month", utilization: 9 } },
      },
      NOW + 1,
    );
    expect(next?.rateLimits).toEqual(prev?.rateLimits);
    const garbageMeta = applyUsageUpdate(prev, { used: 12, size: 100, _meta: { "_claude/rateLimit": 42 } }, NOW + 2);
    expect(garbageMeta?.rateLimits).toEqual(prev?.rateLimits);
  });

  it("carries the previous size forward when an update reports used > size and prev can hold it (stale window after a model switch)", () => {
    const prev = applyUsageUpdate(null, { used: 300_000, size: 1_000_000 }, 1000);
    const next = applyUsageUpdate(prev, { used: 310_000, size: 200_000 }, 2000);
    expect(next).toMatchObject({ used: 310_000, size: 1_000_000 });
  });

  it("raises size to used when an update reports used > size and no previous size can hold it", () => {
    const next = applyUsageUpdate(null, { used: 250_000, size: 200_000 }, 1000);
    expect(next).toMatchObject({ used: 250_000, size: 250_000 });
  });

  it("takes a smaller reported size at face value while used still fits (genuine window shrink)", () => {
    const prev = applyUsageUpdate(null, { used: 150_000, size: 1_000_000 }, 1000);
    const next = applyUsageUpdate(prev, { used: 150_000, size: 200_000 }, 2000);
    expect(next).toMatchObject({ used: 150_000, size: 200_000 });
  });

  it("accepts the authoritative correction after a stale-size stretch", () => {
    const a = applyUsageUpdate(null, { used: 300_000, size: 200_000 }, 1000); // capped to 300k
    const b = applyUsageUpdate(a, { used: 305_000, size: 1_000_000 }, 2000); // adapter corrected
    expect(b).toMatchObject({ used: 305_000, size: 1_000_000 });
  });

  it("prefers the learned window over a smaller reported size (fresh-process default seed)", () => {
    const next = applyUsageUpdate(null, { used: 73_000, size: 200_000 }, 1000, 1_000_000);
    expect(next).toMatchObject({ used: 73_000, size: 1_000_000 });
  });

  it("uses the learned window when used > size and there is no previous state", () => {
    const next = applyUsageUpdate(null, { used: 250_000, size: 200_000 }, 1000, 1_000_000);
    expect(next).toMatchObject({ used: 250_000, size: 1_000_000 });
  });

  it("ignores a learned window smaller than the reported size (bigger window wins)", () => {
    const next = applyUsageUpdate(null, { used: 73_000, size: 1_000_000 }, 1000, 200_000);
    expect(next).toMatchObject({ used: 73_000, size: 1_000_000 });
  });

  it("falls back to capping at used when even the learned window cannot hold it", () => {
    const next = applyUsageUpdate(null, { used: 1_200_000, size: 200_000 }, 1000, 1_000_000);
    expect(next).toMatchObject({ used: 1_200_000, size: 1_200_000 });
  });

  it("always preserves the adapter's raw size in reportedSize, corrections notwithstanding", () => {
    const corrected = applyUsageUpdate(null, { used: 73_000, size: 200_000 }, 1000, 1_000_000);
    expect(corrected).toMatchObject({ size: 1_000_000, reportedSize: 200_000 });
    const faceValue = applyUsageUpdate(null, { used: 10, size: 100 }, 1000);
    expect(faceValue).toMatchObject({ size: 100, reportedSize: 100 });
  });
});

describe("toAvailableCommands", () => {
  it("maps the ACP shape tolerantly", () => {
    expect(
      toAvailableCommands({
        availableCommands: [
          { name: "compact", description: "Compact the conversation", input: { hint: "instructions" } },
          { name: "model", description: "" },
          { name: "", description: "dropped" },
          "garbage",
          { description: "no name" },
        ],
      }),
    ).toEqual([
      { name: "compact", description: "Compact the conversation", inputHint: "instructions" },
      { name: "model", description: "", inputHint: null },
    ]);
  });

  it("returns [] for malformed input", () => {
    expect(toAvailableCommands(null)).toEqual([]);
    expect(toAvailableCommands({})).toEqual([]);
    expect(toAvailableCommands({ availableCommands: "x" })).toEqual([]);
  });
});
