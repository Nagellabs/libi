import { describe, it, expect, beforeEach } from "vitest";
import {
  __resetRunnerRegistryForTests,
  registerBuiltinRunners,
  listRunners,
  getRunner,
} from "@/lib/jobs/runners/registry";

/**
 * Structural guard for the paid-job rate limiter (`lib/jobs/rate-limit.ts`).
 * The limiter derives its cost-bearing set from the `paid: true` flag on the
 * runner definitions, NOT a hand-maintained list — so a future paid runner
 * cannot silently bypass the billing rate-limiter by being forgotten in a
 * literal. This test fails the moment a paid-provider runner ships without the
 * flag, or an unexpected runner gains it.
 */
describe("Runner paid-flag coverage", () => {
  beforeEach(() => {
    __resetRunnerRegistryForTests();
    registerBuiltinRunners();
  });

  it("the removed paid runners are not registered", () => {
    expect(getRunner("extra_analysis_model")).toBeNull();
    expect(getRunner("tracking_provider")).toBeNull();
  });

  it("a known-local runner has a falsy paid flag", () => {
    expect(getRunner("proxy_gen")?.paid).toBeFalsy();
  });

  it("no built-in runner is flagged paid (every remaining kind is local compute)", () => {
    const paidKinds = listRunners()
      .filter((r) => r.paid === true)
      .map((r) => r.kind)
      .sort();
    expect(paidKinds).toEqual([]);
  });

  it("every *_provider runner is flagged paid", () => {
    // Provider-backed runners call an external (paid) API by convention. If a
    // new `*_provider` runner lands without `paid: true`, it would bypass the
    // billing limiter — this catches that.
    for (const r of listRunners()) {
      if (r.kind.includes("_provider")) {
        expect(r.paid, `runner ${r.kind} matches paid-provider pattern`).toBe(
          true,
        );
      }
    }
  });
});
