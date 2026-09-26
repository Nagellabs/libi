// Guards the relationship between `release-npm.js`'s registry-verify polls
// and the "Publish to npm" job's `timeout-minutes` in the workflow: a
// GitHub Actions job that hits its own timeout is killed mid-poll, which
// looks identical to a real failure even though `published=true` may
// already be recorded. The job timeout must always leave headroom over the
// COMBINED worst case of BOTH sequential polls — the packument/doc poll
// (VERIFY_ATTEMPTS × VERIFY_DELAY_MS) runs first, and only once it succeeds
// does the tarball-GET retry (TARBALL_VERIFY_ATTEMPTS × TARBALL_VERIFY_DELAY_MS)
// start — plus the build/test/publish steps that run before either poll.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  VERIFY_ATTEMPTS,
  VERIFY_DELAY_MS,
  TARBALL_VERIFY_ATTEMPTS,
  TARBALL_VERIFY_DELAY_MS,
} from "@/scripts/lib/release-verify.js";

describe("release-npm.yml npm job timeout vs. the registry-verify budget", () => {
  it("gives the job strictly more time than both verify polls combined can take", () => {
    const src = readFileSync(
      path.join(process.cwd(), ".github/workflows/release-npm.yml"),
      "utf8",
    );
    const npmJobStart = src.indexOf("\n  npm:\n");
    expect(npmJobStart, "the npm job must exist in the workflow").toBeGreaterThan(-1);
    // Bound the search to this job's block (up to the next top-level job key).
    const nextJobStart = src.indexOf("\n  # ── ", npmJobStart + 1);
    const jobBlock = src.slice(npmJobStart, nextJobStart === -1 ? undefined : nextJobStart);

    const match = jobBlock.match(/timeout-minutes:\s*(\d+)/);
    expect(match, "the npm job must declare timeout-minutes").not.toBeNull();
    const timeoutMs = Number(match![1]) * 60_000;

    // Worst case is the SUM, not either budget alone: the doc poll must
    // finish (successfully or via its own timeout branch) before the
    // tarball-GET retry ever starts.
    const combinedVerifyBudgetMs =
      VERIFY_ATTEMPTS * VERIFY_DELAY_MS + TARBALL_VERIFY_ATTEMPTS * TARBALL_VERIFY_DELAY_MS;
    expect(timeoutMs).toBeGreaterThan(combinedVerifyBudgetMs);
    // Headroom for the steps that run before/after both polls (checkout, npm
    // install, the release build, registry:e2e, the publish itself) — not
    // just the combined polls with zero margin.
    expect(timeoutMs - combinedVerifyBudgetMs).toBeGreaterThanOrEqual(15 * 60_000);
  });
});
