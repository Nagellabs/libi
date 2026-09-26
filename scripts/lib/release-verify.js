/**
 * Post-publish registry-verification decisions for `release-npm.js`.
 *
 * A publish's WRITES land before its READS do: npm's PUT returning 200 is not
 * proof the CDN is serving the package yet. On 0.1.14 and 0.1.15 the CDN took
 * ~10-12 minutes to start serving a brand-new publish — well past the old
 * 20×15s (4.75 min) budget — so a perfectly good publish reported itself as a
 * failure while npm was still catching up.
 *
 * These are pure decisions over observed poll state, kept out of the script
 * (which owns the real curl/npm calls and the sleep loop) so they can be
 * tested as decisions rather than as a live registry poll. Mirrors
 * `scripts/lib/release-preflight.js`.
 */

/**
 * ~25 minutes at 15s per attempt — enough to clear the CDN lag actually
 * observed on 0.1.14 (~10 min) and 0.1.15 (~12 min) with real headroom, up
 * from the old 20×15s (~4.75 min) budget that failed both of those.
 */
const VERIFY_ATTEMPTS = 100;
const VERIFY_DELAY_MS = 15_000;

/**
 * Budget for retrying the tarball GET specifically (see
 * `classifyTarballAttempt` below). This is deliberately smaller than
 * VERIFY_ATTEMPTS: by the time this check runs, the per-version document is
 * already confirmed live, so the tarball is expected to be fetchable almost
 * immediately — this budget exists to absorb a transient network blip on the
 * GET itself, not to wait out CDN propagation a second time. 20×15s = 5 min.
 */
const TARBALL_VERIFY_ATTEMPTS = 20;
const TARBALL_VERIFY_DELAY_MS = 15_000;

/**
 * Whether to print a progress line for this attempt. At 15s/attempt a
 * 100-attempt wait would otherwise print ~100 near-identical lines; instead
 * log roughly once a minute, plus always the first and last attempt so the
 * start and the final outcome are never silent.
 *
 * @param {number} attempt        1-based attempt number
 * @param {number} totalAttempts  the full VERIFY_ATTEMPTS budget
 * @param {number} delayMs        the per-attempt delay (VERIFY_DELAY_MS)
 * @param {number} [logIntervalMs] how often to log (default ~1 minute)
 */
function shouldLogAttempt(attempt, totalAttempts, delayMs, logIntervalMs = 60_000) {
  if (attempt <= 1 || attempt >= totalAttempts) return true;
  const attemptsPerLog = Math.max(1, Math.round(logIntervalMs / delayMs));
  return attempt % attemptsPerLog === 0;
}

/**
 * What to report once a verify budget is exhausted without confirming the
 * thing that budget was polling for. Shared by two callers with DIFFERENT
 * budgets and DIFFERENT missing things — the packument/doc poll
 * (VERIFY_ATTEMPTS × VERIFY_DELAY_MS, ~25 min, waiting on the version
 * document) and the tarball-GET retry (TARBALL_VERIFY_ATTEMPTS ×
 * TARBALL_VERIFY_DELAY_MS, ~5 min, waiting on a completed GET) — so
 * `attempts`/`delayMs`/`whatIsMissing` are REQUIRED, not read off the
 * module's own VERIFY_ATTEMPTS/VERIFY_DELAY_MS constants: hardcoding those
 * here previously made the tarball-retry caller report "still isn't being
 * served after ~25 minutes (100 attempts × 15s)" even though the version
 * document WAS already served and only 20×15s (~5 min) had actually elapsed.
 *
 * `published=true` is written to GITHUB_OUTPUT BEFORE either poll ever
 * starts (npm already accepted the publish at that point), so even the
 * failure wording here must never suggest the publish itself failed or
 * invite a re-dispatch — a re-run either double-bumps the version or dies on
 * "cannot publish over the previously published version".
 *
 * @param {{ pkgName: string, version: string, versionDocServed: boolean, attempts: number, delayMs: number, whatIsMissing: string }} state
 *   `attempts`/`delayMs` describe the CALLER's own budget (not necessarily
 *   VERIFY_ATTEMPTS/VERIFY_DELAY_MS); `whatIsMissing` is a clause completing
 *   "${pkgName}@${version} ${whatIsMissing} after ~N minutes" — only used
 *   when `versionDocServed` is false.
 * @returns {{ exitCode: 0 | 1, message: string }}
 */
function describeVerifyTimeout({ pkgName, version, versionDocServed, attempts, delayMs, whatIsMissing }) {
  if (versionDocServed) {
    return {
      exitCode: 0,
      message:
        `\n✅ ${pkgName}@${version} IS published — registry.npmjs.org serves its\n` +
        "   version document. Only the aggregated packument is still catching up,\n" +
        "   which is normal for a first publish and needs no action.",
    };
  }
  const minutes = Math.round((attempts * delayMs) / 60_000);
  return {
    exitCode: 1,
    message:
      `\n❌ ${pkgName}@${version} ${whatIsMissing} after ~${minutes} minutes ` +
      `(${attempts} attempts × ${delayMs / 1000}s).\n` +
      "   npm ACCEPTED the publish — `published=true` is already recorded in\n" +
      "   GITHUB_OUTPUT — so this is the CDN/network still lagging behind, not a\n" +
      "   failed publish. Poll the registry yourself; do NOT re-dispatch the release.",
  };
}

/**
 * Whether a tarball's actually-computed integrity matches what the registry's
 * per-version document declares (`dist.integrity`). Returns `null` — not yet
 * knowable — when either side hasn't been observed yet, so callers can
 * distinguish "haven't checked" from "checked and it disagrees".
 *
 * A mismatch is a real corruption/tampering signal (a GET that 200s with
 * wrong bytes), which a HEAD request can never catch — the reason the caller
 * must GET the tarball rather than HEAD it.
 *
 * @param {string | null | undefined} actual    integrity computed from the downloaded bytes
 * @param {string | null | undefined} expected  `dist.integrity` from the version document
 * @returns {boolean | null}
 */
function tarballIntegrityMatches(actual, expected) {
  if (!actual || !expected) return null;
  return actual === expected;
}

/**
 * Classify a single tarball-verification attempt.
 *
 * The caller GETs (never HEADs) the tarball and, only if that GET actually
 * returned bytes, computes their digest. A GET that fails outright — a
 * network hiccup, a truncated/empty body, a non-zero curl exit — proves
 * NOTHING about the tarball's contents: it is a failed *attempt*, not a
 * failed *comparison*, and must be retried rather than reported as
 * corruption. Only a successful GET whose computed digest disagrees with
 * the registry's declared `dist.integrity` is a real corruption signal.
 *
 * @param {{ getSucceeded: boolean, actual: string | null, expected: string | null }} state
 * @returns {"match" | "mismatch" | "inconclusive"}
 */
function classifyTarballAttempt({ getSucceeded, actual, expected }) {
  if (!getSucceeded) return "inconclusive";
  const matches = tarballIntegrityMatches(actual, expected);
  if (matches === null) return "inconclusive";
  return matches ? "match" : "mismatch";
}

/**
 * Whether a curl GET actually succeeded: a completed process (status 0) that
 * returned a non-empty body.
 *
 * Without `-f`, curl exits 0 even on an HTTP error response — the npm
 * registry answers a not-yet-served tarball or version doc with HTTP 404 and
 * a JSON error body (`{"error":"Not found"}`), and plain `curl -sL`/`-s`
 * fetches that body and exits 0 as if it were a real success. The caller
 * MUST pass `-f` (fail-on-HTTP-error) so a non-2xx response makes curl exit
 * non-zero, which is what the `status === 0` check here depends on to tell
 * "really got the thing" apart from "got an error page about the thing".
 * Getting this wrong is exactly how a CDN-propagation lag used to get
 * reported as "real corruption": the error body's hash disagreed with
 * `dist.integrity`, and a completed-but-wrong GET is the only case
 * `classifyTarballAttempt` treats as a genuine mismatch.
 *
 * @param {{ status: number | null | undefined, stdout: Buffer | string | null | undefined }} res
 * @returns {boolean}
 */
function curlGetSucceeded(res) {
  return res?.status === 0 && !!res?.stdout && res.stdout.length > 0;
}

module.exports = {
  VERIFY_ATTEMPTS,
  VERIFY_DELAY_MS,
  TARBALL_VERIFY_ATTEMPTS,
  TARBALL_VERIFY_DELAY_MS,
  shouldLogAttempt,
  describeVerifyTimeout,
  tarballIntegrityMatches,
  classifyTarballAttempt,
  curlGetSucceeded,
};
