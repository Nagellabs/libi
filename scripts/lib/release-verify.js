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
 * And since 0.1.17 it does not FAIL either. 0.1.16 sat in npm "processing"
 * for ~56 minutes, well past this ~25 min budget, and the run went red on a
 * good publish. Running out of budget after npm accepted the package is now
 * "accepted, not yet served": exit 0, a one-line GitHub `::warning::`
 * annotation, and the exact local command (`npm run release:verify-live --
 * <v>`, scripts/verify-npm-live.js) that finishes the check on a budget the
 * job can't afford. The long wait moves to the maintainer's machine; the
 * npm job's timeout does not grow. A tarball digest MISMATCH never comes
 * through here — the caller exits 1 on it at once, because a completed GET
 * with the wrong bytes is the one real corruption signal.
 *
 * @param {{ pkgName: string, version: string, versionDocServed: boolean, attempts: number, delayMs: number, whatIsMissing: string }} state
 *   `attempts`/`delayMs` describe the CALLER's own budget (not necessarily
 *   VERIFY_ATTEMPTS/VERIFY_DELAY_MS); `whatIsMissing` is a clause completing
 *   "${pkgName}@${version} ${whatIsMissing} after ~N minutes" — only used
 *   when `versionDocServed` is false.
 * @returns {{ exitCode: 0, kind: "served" | "accepted-not-served", message: string, annotation: string | null }}
 *   `annotation` is null on the served path; otherwise ONE line to print as-is
 *   (GitHub reads a workflow command only as a single line).
 */
function describeVerifyTimeout({ pkgName, version, versionDocServed, attempts, delayMs, whatIsMissing }) {
  if (versionDocServed) {
    return {
      exitCode: 0,
      kind: "served",
      annotation: null,
      message:
        `\n✅ ${pkgName}@${version} IS published — registry.npmjs.org serves its\n` +
        "   version document. Only the aggregated packument is still catching up,\n" +
        "   which is normal for a first publish and needs no action.",
    };
  }
  const minutes = Math.round((attempts * delayMs) / 60_000);
  const command = liveCheckCommand(version);
  return {
    exitCode: 0,
    kind: "accepted-not-served",
    annotation:
      // No comma or colon in the title: they delimit a workflow command's
      // properties, and GitHub would cut the title there.
      "::warning title=npm publish accepted - not served yet::" +
      `${pkgName}@${version} ${whatIsMissing} after ~${minutes} min, but npm ACCEPTED ` +
      `the publish. Not a failure - do NOT re-dispatch. Finish the check locally: ${command}`,
    message:
      `\n⚠️  ${pkgName}@${version} ${whatIsMissing} after ~${minutes} minutes ` +
      `(${attempts} attempts × ${delayMs / 1000}s).\n` +
      "   npm ACCEPTED the publish — `published=true` is already recorded in\n" +
      "   GITHUB_OUTPUT — so this is the registry still catching up, not a\n" +
      "   failed publish (0.1.16 took ~56 min). This run stays green.\n" +
      "   Do NOT re-dispatch the release. Finish the check from your machine,\n" +
      "   which waits up to 90 min and verifies the tarball's integrity:\n" +
      `     ${command}`,
  };
}

/** The local command that finishes a check the release run gave up on. */
function liveCheckCommand(version) {
  return `npm run release:verify-live -- ${version}`;
}

/** verify-npm-live.js's default budget: 0.1.16 took ~56 min to be served. */
const LIVE_CHECK_DEFAULT_MINUTES = 90;

/**
 * The npm-style integrity (`<algo>-<base64 digest>`) of `bytes`, computed
 * with the algorithm `expected` declares. null when `expected` names no
 * algorithm this Node can compute — not knowable, never a mismatch.
 *
 * @param {Buffer | Uint8Array} bytes
 * @param {string | null | undefined} expected  `dist.integrity`
 * @returns {string | null}
 */
function computeIntegrity(bytes, expected) {
  if (!expected || !expected.includes("-")) return null;
  const [algo] = expected.split("-");
  try {
    return `${algo}-${require("node:crypto").createHash(algo).update(bytes).digest("base64")}`;
  } catch {
    return null;
  }
}

/** Numeric x.y.z comparison; prerelease suffixes are ignored. */
function compareVersions(a, b) {
  const pa = String(a).split("-")[0].split(".").map(Number);
  const pb = String(b).split("-")[0].split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Whether the aggregated packument serves `version`: it lists the version,
 * and `dist-tags.latest` is that version — or a newer one, so a past release
 * can be re-checked after the next has shipped instead of waiting forever for
 * `latest` to point back at it. What `npx @nagellabs/libi` resolves hangs off
 * `latest`, which is why the packument is checked at all.
 *
 * @param {{ "dist-tags"?: { latest?: string }, versions?: Record<string, unknown> } | null | undefined} packument
 * @param {string} version
 */
function packumentServes(packument, version) {
  const latest = packument?.["dist-tags"]?.latest;
  if (!latest || !packument?.versions || !(version in packument.versions)) return false;
  return compareVersions(latest, version) >= 0;
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
  liveCheckCommand,
  LIVE_CHECK_DEFAULT_MINUTES,
  computeIntegrity,
  compareVersions,
  packumentServes,
};
