// `release-npm.js`'s post-publish registry poll used to give up after
// 20×15s (~4.75 min). On 0.1.14 and 0.1.15 the CDN took ~10-12 minutes to
// start serving a brand-new publish, so a perfectly good publish reported
// itself as a failure while npm was still catching up.
//
// These are the pure decisions inside that poll — how long to wait, when to
// log an attempt, what to say once the budget is exhausted, and whether a
// downloaded tarball actually matches what the registry claims — pulled out
// so they can be tested as decisions rather than as a live registry poll
// (mirrors scripts/lib/release-preflight.js).
import { describe, it, expect } from "vitest";

import fs from "node:fs";
import path from "node:path";

import {
  VERIFY_ATTEMPTS,
  VERIFY_DELAY_MS,
  TARBALL_VERIFY_ATTEMPTS,
  TARBALL_VERIFY_DELAY_MS,
  shouldLogAttempt,
  describeVerifyTimeout,
  tarballIntegrityMatches,
  classifyTarballAttempt,
  curlGetSucceeded,
  computeIntegrity,
  packumentServes,
  liveCheckCommand,
  LIVE_CHECK_DEFAULT_MINUTES,
} from "@/scripts/lib/release-verify.js";

describe("verify budget", () => {
  it("is long enough to clear the observed CDN lag (~12 min on 0.1.15), with headroom", () => {
    const totalMs = VERIFY_ATTEMPTS * VERIFY_DELAY_MS;
    expect(totalMs).toBeGreaterThanOrEqual(20 * 60_000); // at least 20 minutes
    expect(totalMs).toBeLessThanOrEqual(30 * 60_000); // sanity: not unbounded
  });
});

describe("shouldLogAttempt", () => {
  it("always logs the first attempt", () => {
    expect(shouldLogAttempt(1, VERIFY_ATTEMPTS, VERIFY_DELAY_MS)).toBe(true);
  });

  it("always logs the final attempt", () => {
    expect(shouldLogAttempt(VERIFY_ATTEMPTS, VERIFY_ATTEMPTS, VERIFY_DELAY_MS)).toBe(true);
  });

  it("does not log every attempt at a 15s delay (would be ~100 lines over 25 min)", () => {
    const logged = Array.from({ length: VERIFY_ATTEMPTS }, (_, i) => i + 1).filter((a) =>
      shouldLogAttempt(a, VERIFY_ATTEMPTS, VERIFY_DELAY_MS),
    );
    // Roughly once a minute over a 25-minute wait: ~25 lines, nowhere near 100.
    expect(logged.length).toBeLessThan(40);
    expect(logged.length).toBeGreaterThan(10);
  });

  it("logs roughly once a minute", () => {
    // 15s per attempt → 4 attempts per minute.
    expect(shouldLogAttempt(4, 100, 15_000)).toBe(true);
    expect(shouldLogAttempt(8, 100, 15_000)).toBe(true);
    expect(shouldLogAttempt(2, 100, 15_000)).toBe(false);
    expect(shouldLogAttempt(3, 100, 15_000)).toBe(false);
  });
});

describe("describeVerifyTimeout", () => {
  it("reports success (exit 0) when the version document IS being served", () => {
    const outcome = describeVerifyTimeout({
      pkgName: "@nagellabs/libi",
      version: "0.1.16",
      versionDocServed: true,
      attempts: VERIFY_ATTEMPTS,
      delayMs: VERIFY_DELAY_MS,
      whatIsMissing: "unused on the success path",
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.kind).toBe("served");
    expect(outcome.annotation).toBeNull();
    expect(outcome.message).toMatch(/IS published/i);
  });

  // npm PUT already returned 200 (published=true is already in GITHUB_OUTPUT
  // by the time this runs) but the CDN still isn't serving even the
  // per-version document after the whole budget. Until 0.1.17 this exited 1,
  // so 0.1.16 — held ~56 min in npm "processing" — turned the run red on a
  // good publish. It is now "accepted, not yet served": green, with a
  // ::warning:: annotation and the exact local command that finishes the
  // check. It must still never read as "the publish failed" — that invites a
  // re-dispatch, which either double-bumps or dies on a duplicate version.
  it("npm-accepted-but-not-served exits 0 with a ::warning:: and names `npm run release:verify-live -- <v>`", () => {
    const outcome = describeVerifyTimeout({
      pkgName: "@nagellabs/libi",
      version: "0.1.16",
      versionDocServed: false,
      attempts: VERIFY_ATTEMPTS,
      delayMs: VERIFY_DELAY_MS,
      whatIsMissing: "still isn't being served",
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.kind).toBe("accepted-not-served");
    // GitHub reads an annotation only as ONE line starting with the command.
    expect(outcome.annotation).toMatch(/^::warning( [^:]*)?::/);
    expect(outcome.annotation).not.toContain("\n");
    expect(outcome.annotation).toContain("npm run release:verify-live -- 0.1.16");
    expect(outcome.message).toContain("npm run release:verify-live -- 0.1.16");
    expect(outcome.message).toMatch(/ACCEPTED the publish/i);
    expect(outcome.message).toMatch(/published=true/);
    expect(outcome.message).toMatch(/never re-dispatch|do not re-dispatch/i);
    expect(outcome.message).not.toMatch(/re-publish/i);
    // Reflects the CALLER's own budget, not a hardcoded number.
    expect(outcome.message).toMatch(/~25 minutes/);
    expect(outcome.message).toMatch(/100 attempts × 15s/);
    expect(outcome.message).toMatch(/still isn't being served/);
  });

  // THE BUG: this helper is shared by the packument/doc poll (~25 min,
  // 100×15s) and the tarball-GET retry (~5 min, 20×15s). Before this fix the
  // message hardcoded the doc-poll's own VERIFY_ATTEMPTS/VERIFY_DELAY_MS, so
  // the tarball-retry caller reported "still isn't being served after ~25
  // minutes (100 attempts × 15s)" even though the version document WAS
  // served and only 5 minutes had actually elapsed. Passing a different
  // budget must produce text that matches THAT budget, not the doc-poll's.
  it("reflects a different (smaller) caller-supplied budget accurately, not the doc-poll's own numbers", () => {
    const outcome = describeVerifyTimeout({
      pkgName: "@nagellabs/libi",
      version: "0.1.16",
      versionDocServed: false,
      attempts: TARBALL_VERIFY_ATTEMPTS,
      delayMs: TARBALL_VERIFY_DELAY_MS,
      whatIsMissing: "its tarball still couldn't be confirmed by a successful GET",
    });
    // A GET that never completed proves nothing about the bytes: same
    // "accepted, not yet served" verdict, not a failure.
    expect(outcome.exitCode).toBe(0);
    expect(outcome.kind).toBe("accepted-not-served");
    expect(outcome.message).toMatch(/its tarball still couldn't be confirmed by a successful GET/);
    expect(outcome.message).toMatch(/~5 minutes/);
    expect(outcome.message).toMatch(/20 attempts × 15s/);
    // Must NOT carry the doc-poll's budget/wording over by accident.
    expect(outcome.message).not.toMatch(/~25 minutes/);
    expect(outcome.message).not.toMatch(/100 attempts/);
    expect(outcome.message).not.toMatch(/still isn't being served/);
    expect(outcome.message).toMatch(/ACCEPTED the publish/i);
    expect(outcome.message).toMatch(/never re-dispatch|do not re-dispatch/i);
  });
});

describe("tarballIntegrityMatches", () => {
  it("matches identical integrity strings", () => {
    expect(tarballIntegrityMatches("sha512-abc123==", "sha512-abc123==")).toBe(true);
  });

  it("flags a mismatch as a real problem, not CDN lag", () => {
    expect(tarballIntegrityMatches("sha512-abc123==", "sha512-def456==")).toBe(false);
  });

  it("returns null (not yet knowable) when either side is missing", () => {
    expect(tarballIntegrityMatches(null, "sha512-def456==")).toBeNull();
    expect(tarballIntegrityMatches("sha512-abc123==", undefined)).toBeNull();
    expect(tarballIntegrityMatches(null, null)).toBeNull();
  });
});

describe("classifyTarballAttempt", () => {
  // A GET that fails outright (curl exit status, empty body — a network
  // hiccup) is NOT evidence of a corrupted tarball. Reporting it as
  // corruption (as the caller used to) would fail a good release over a
  // transient blip; it must be retried instead.
  it("is inconclusive on a failed GET, never 'mismatch'", () => {
    expect(
      classifyTarballAttempt({ getSucceeded: false, actual: null, expected: "sha512-abc123==" }),
    ).toBe("inconclusive");
  });

  // Only a GET that actually returned bytes whose digest disagrees with the
  // registry's declared dist.integrity is a real corruption signal.
  it("is 'mismatch' only for a successful GET whose digest disagrees", () => {
    expect(
      classifyTarballAttempt({
        getSucceeded: true,
        actual: "sha512-abc123==",
        expected: "sha512-def456==",
      }),
    ).toBe("mismatch");
  });

  it("is 'match' for a successful GET whose digest agrees", () => {
    expect(
      classifyTarballAttempt({
        getSucceeded: true,
        actual: "sha512-abc123==",
        expected: "sha512-abc123==",
      }),
    ).toBe("match");
  });

  // Defensive: a "succeeded" GET that somehow yielded no digest is still
  // not knowable, not a mismatch.
  it("is inconclusive if getSucceeded is true but actual is missing", () => {
    expect(
      classifyTarballAttempt({ getSucceeded: true, actual: null, expected: "sha512-abc123==" }),
    ).toBe("inconclusive");
  });
});

// THE BUG this guards against: `curl -sL <tarball-url>` on a not-yet-served
// tarball gets HTTP 404 with a JSON error body (`{"error":"Not found"}`) from
// the registry, but curl still exits 0 — without `-f` it has no concept of
// "the response was an error", it just fetched *something*. release-npm.js
// used to treat that exit-0 as a successful GET, hash the error body, find it
// disagreed with `dist.integrity`, and declare "real corruption" on a release
// that was simply not fully propagated yet. `-f` makes curl exit non-zero on
// an HTTP error response, which is what curlGetSucceeded's `status === 0`
// check depends on.
describe("curlGetSucceeded", () => {
  it("is false when curl exits non-zero, even with a body (a `-f` HTTP-error exit)", () => {
    expect(curlGetSucceeded({ status: 22, stdout: Buffer.from('{"error":"Not found"}') })).toBe(false);
  });

  it("is false on a non-zero exit with an empty body", () => {
    expect(curlGetSucceeded({ status: 1, stdout: Buffer.alloc(0) })).toBe(false);
  });

  it("is false on exit 0 with an empty body (nothing was actually fetched)", () => {
    expect(curlGetSucceeded({ status: 0, stdout: Buffer.alloc(0) })).toBe(false);
    expect(curlGetSucceeded({ status: 0, stdout: "" })).toBe(false);
  });

  it("is false when stdout is null/undefined even on exit 0", () => {
    expect(curlGetSucceeded({ status: 0, stdout: null })).toBe(false);
    expect(curlGetSucceeded({ status: 0, stdout: undefined })).toBe(false);
  });

  it("is true on exit 0 with a non-empty body, for a Buffer or a string", () => {
    expect(curlGetSucceeded({ status: 0, stdout: Buffer.from("tarball bytes") })).toBe(true);
    expect(curlGetSucceeded({ status: 0, stdout: "some json" })).toBe(true);
  });
});

// Guards must-fix #1 directly at the source level: the tarball GET and the
// version-doc GET must both pass curl `-f` (fail-on-HTTP-error), so a
// not-yet-served registry response (404 + JSON error body) makes curl exit
// non-zero — "inconclusive, retry" — rather than exit 0 with an error body
// that gets hashed and reported as tarball corruption.
describe("release-npm.js curl invocations (source guard)", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "..", "..", "scripts", "release-npm.js"),
    "utf8",
  );

  function bodyOf(fnName: string): string {
    const start = source.indexOf(`function ${fnName}(`);
    expect(start, `function ${fnName} not found in release-npm.js`).toBeGreaterThanOrEqual(0);
    const nextFn = source.indexOf("\nfunction ", start + 1);
    return source.slice(start, nextFn === -1 ? undefined : nextFn);
  }

  it("fetchVersionDoc's curl call includes -f", () => {
    const body = bodyOf("fetchVersionDoc");
    const curlArgsMatch = body.match(/spawnSync\(\s*"curl",\s*\[([^\]]*)\]/);
    expect(curlArgsMatch, "expected a spawnSync(\"curl\", [...]) call in fetchVersionDoc").not.toBeNull();
    const argsSrc = curlArgsMatch![1];
    expect(argsSrc).toMatch(/-f\b|-[a-zA-Z]*f[a-zA-Z]*"/); // e.g. "-f", "-fs", "-fsSL"
  });

  it("the tarball GET (verifyTarballIntegrity) curl call includes -f", () => {
    const body = bodyOf("verifyTarballIntegrity");
    const curlArgsMatch = body.match(/spawnSync\("curl",\s*\[([^\]]*)\]/);
    expect(curlArgsMatch, "expected a spawnSync(\"curl\", [...]) call in verifyTarballIntegrity").not.toBeNull();
    const argsSrc = curlArgsMatch![1];
    expect(argsSrc).toMatch(/"-f[a-zA-Z]*"/); // e.g. "-fsSL", "-fL"
  });
});

describe("the live check's pure pieces", () => {
  it("names the command a maintainer runs locally to finish the check", () => {
    expect(liveCheckCommand("0.1.17")).toBe("npm run release:verify-live -- 0.1.17");
  });

  it("waits 90 minutes by default — 0.1.16 took ~56", () => {
    expect(LIVE_CHECK_DEFAULT_MINUTES).toBe(90);
  });

  it("computes an npm-style integrity string with the declared algorithm", () => {
    const bytes = Buffer.from("tarball bytes");
    const sha512 = computeIntegrity(bytes, "sha512-whatever");
    expect(sha512).toMatch(/^sha512-[A-Za-z0-9+/]+=*$/);
    expect(computeIntegrity(bytes, "sha1-x")).toMatch(/^sha1-/);
    expect(computeIntegrity(bytes, sha512!)).toBe(sha512);
    // An integrity string naming no algorithm we can compute is not knowable.
    expect(computeIntegrity(bytes, "nonsense")).toBeNull();
    expect(computeIntegrity(bytes, null)).toBeNull();
  });

  describe("packumentServes", () => {
    const pack = (latest: string, versions: string[]) => ({
      "dist-tags": { latest },
      versions: Object.fromEntries(versions.map((v) => [v, {}])),
    });

    it("is true once the packument lists the version and latest points at it", () => {
      expect(packumentServes(pack("0.1.17", ["0.1.16", "0.1.17"]), "0.1.17")).toBe(true);
    });

    it("is false while the packument still shows the previous release", () => {
      expect(packumentServes(pack("0.1.16", ["0.1.16"]), "0.1.17")).toBe(false);
      // listed but latest not moved yet
      expect(packumentServes(pack("0.1.16", ["0.1.16", "0.1.17"]), "0.1.17")).toBe(false);
    });

    it("accepts an OLDER version once a newer one is latest (re-checking a past release)", () => {
      expect(packumentServes(pack("0.1.18", ["0.1.16", "0.1.17", "0.1.18"]), "0.1.17")).toBe(true);
      expect(packumentServes(pack("0.1.10", ["0.1.9", "0.1.10"]), "0.1.9")).toBe(true);
    });

    it("is false for an absent or malformed packument", () => {
      expect(packumentServes(null, "0.1.17")).toBe(false);
      expect(packumentServes({}, "0.1.17")).toBe(false);
    });
  });
});

// A slow registry must never turn a good publish red — and must never be able
// to hide a real corruption or cost the version commit/tag push either.
describe("release-npm.js keeps the two things a lenient timeout must not touch", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "..", "..", "scripts", "release-npm.js"),
    "utf8",
  );

  it("a tarball digest MISMATCH still exits 1 at once", () => {
    const at = source.indexOf('if (status === "mismatch")');
    expect(at, "mismatch branch not found").toBeGreaterThan(-1);
    const branch = source.slice(at, source.indexOf("}", source.indexOf("process.exit", at)) + 1);
    expect(branch).toContain("process.exit(1)");
    expect(branch).toMatch(/real corruption signal/);
  });

  it("records published=true before any poll starts, so the push step still runs", () => {
    const published = source.indexOf('"published=true\\n"');
    const firstPoll = source.indexOf("for (let attempt = 1; attempt <= VERIFY_ATTEMPTS");
    expect(published).toBeGreaterThan(-1);
    expect(firstPoll).toBeGreaterThan(published);
  });

  it("prints the ::warning:: annotation on the accepted-not-served path", () => {
    expect(source).toContain("outcome.annotation");
  });
});
