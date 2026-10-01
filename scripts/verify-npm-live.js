#!/usr/bin/env node
/**
 * Finish a registry check the release run stopped waiting for.
 *
 *   npm run release:verify-live -- <version> [--minutes N]
 *   node scripts/verify-npm-live.js <version> [--minutes N]
 *
 * WHY. npm can hold a publish in "processing" far longer than a CI job should
 * sit polling: 0.1.16 took ~56 minutes to be served, past release-npm.js's
 * ~25 min budget, and the run went red on a good publish. That budget now ends
 * GREEN with a warning naming this command (scripts/lib/release-verify.js,
 * describeVerifyTimeout), and the long wait happens here, on the maintainer's
 * machine, instead of in a job whose timeout would have to grow to match.
 *
 * WHAT. Read-only, against registry.npmjs.org, the same three checks the
 * release run makes:
 *   1. the per-version document is served (authoritative; updates first);
 *   2. the aggregated packument lists the version and `latest` is it or newer
 *      (what `npx @nagellabs/libi` resolves);
 *   3. the tarball, fetched with GET (never HEAD), hashes to the document's
 *      `dist.integrity`.
 *
 * EXIT. 0 — all three check out. 1 — the tarball's bytes do NOT match
 * `dist.integrity`: a real corruption signal, reported at once and never
 * retried into a pass. 2 — still not served when the budget (default 90 min)
 * ran out: npm accepted it and has not caught up; run it again later. A GET
 * that fails (404, network error, empty body) proves nothing about the bytes
 * and is retried, never counted as a mismatch.
 *
 * The decisions live in ./lib/release-verify.js, shared with release-npm.js.
 * `verifyLive` takes fetch, sleep and the clock as arguments so the tests can
 * fake the registry and time.
 */
const {
  VERIFY_DELAY_MS,
  LIVE_CHECK_DEFAULT_MINUTES,
  shouldLogAttempt,
  classifyTarballAttempt,
  computeIntegrity,
  packumentServes,
} = require("./lib/release-verify");

const PKG_NAME = "@nagellabs/libi";
const REGISTRY = "https://registry.npmjs.org";

/**
 * @param {string[]} argv  arguments after the script name
 * @returns {{ version: string, minutes: number }}
 */
function parseArgs(argv) {
  let version = null;
  let minutes = LIVE_CHECK_DEFAULT_MINUTES;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    let m = null;
    if (a === "--minutes") m = argv[++i];
    else if (a.startsWith("--minutes=")) m = a.slice("--minutes=".length);
    else if (!a.startsWith("--") && version === null) version = a;
    else throw new Error(`usage: verify-npm-live.js <version> [--minutes N] (unexpected "${a}")`);
    if (m !== null) {
      minutes = Number(m);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        throw new Error(`--minutes must be a positive number, got "${m}"`);
      }
    }
  }
  if (version === null) throw new Error("usage: verify-npm-live.js <version> [--minutes N]");
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
    throw new Error(`"${version}" is not a version (expected x.y.z)`);
  }
  return { version, minutes };
}

/**
 * Default per-request bound. A stalled registry socket (no response, no
 * error) would otherwise hang past `minutes` forever — this is what makes
 * every `fetch` call here actually bounded.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The tarball's bound. The signal also bounds the body read, and the tarball
 * is tens of MB (0.1.16: 26 MB) — at the per-request bound a slow connection
 * aborted every attempt mid-body and the check could never pass.
 */
const TARBALL_TIMEOUT_MS = 10 * 60_000;

/** GET a URL; null on a network error, a timeout, or a non-2xx answer. */
async function tryFetch(fetch, url, init, timeoutMs = REQUEST_TIMEOUT_MS) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    return res && res.ok ? res : null;
  } catch {
    return null;
  }
}

async function tryJson(fetch, url, init, timeoutMs) {
  const res = await tryFetch(fetch, url, init, timeoutMs);
  if (!res) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Poll until the version is fully served, a mismatch is seen, or the budget
 * runs out.
 *
 * @param {{
 *   version: string,
 *   minutes: number,
 *   fetch: (url: string, init?: object) => Promise<{ ok: boolean, status: number, json(): Promise<any>, arrayBuffer(): Promise<ArrayBuffer> }>,
 *   sleep: (ms: number) => Promise<void>,
 *   now: () => number,
 *   log: (line: string) => void,
 *   error: (line: string) => void,
 *   delayMs?: number,
 *   requestTimeoutMs?: number,
 *   tarballTimeoutMs?: number,
 * }} opts
 * @returns {Promise<0 | 1 | 2>}
 */
async function verifyLive({
  version,
  minutes,
  fetch,
  sleep,
  now,
  log,
  error,
  delayMs = VERIFY_DELAY_MS,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  tarballTimeoutMs = TARBALL_TIMEOUT_MS,
}) {
  const enc = encodeURIComponent(PKG_NAME);
  const docUrl = `${REGISTRY}/${enc}/${version}`;
  const packUrl = `${REGISTRY}/${enc}`;
  const budgetMs = minutes * 60_000;
  const totalAttempts = Math.max(1, Math.ceil(budgetMs / delayMs));
  const start = now();

  let doc = null;
  let packOk = false;
  let stage = "version document";
  log(`checking ${PKG_NAME}@${version} on ${REGISTRY} for up to ${minutes} min…`);

  for (let attempt = 1; ; attempt++) {
    // 1. the per-version document
    if (!doc) {
      doc = await tryJson(fetch, docUrl, undefined, requestTimeoutMs);
      if (doc && doc.version !== version) doc = null;
    }
    // 2. the aggregated packument (abbreviated form: dist-tags + versions)
    if (doc && !packOk) {
      stage = "packument";
      const pack = await tryJson(
        fetch,
        packUrl,
        { headers: { accept: "application/vnd.npm.install-v1+json" } },
        requestTimeoutMs,
      );
      packOk = packumentServes(pack, version);
    }
    // 3. the tarball's bytes against dist.integrity
    if (doc && packOk) {
      stage = "tarball";
      const expected = doc.dist?.integrity ?? null;
      const tarball = doc.dist?.tarball;
      const res = tarball ? await tryFetch(fetch, tarball, undefined, tarballTimeoutMs) : null;
      let bytes = null;
      if (res) {
        try {
          bytes = Buffer.from(await res.arrayBuffer());
        } catch {
          bytes = null;
        }
      }
      const getSucceeded = !!bytes && bytes.length > 0;
      const actual = getSucceeded ? computeIntegrity(bytes, expected) : null;
      const status = classifyTarballAttempt({ getSucceeded, actual, expected });
      if (status === "match") {
        log(
          `\n✅ ${PKG_NAME}@${version} is live: version document served, packument ` +
            `serves it, tarball integrity verified (${expected}).`,
        );
        return 0;
      }
      if (status === "mismatch") {
        error(
          `\n❌ ${PKG_NAME}@${version}'s tarball does not match its registry-declared\n` +
            "   dist.integrity.\n" +
            `   expected: ${expected}\n` +
            `   actual  : ${actual}\n` +
            "   This is a real corruption signal, not registry lag — investigate before\n" +
            "   telling anyone the release is out.",
        );
        return 1;
      }
      // inconclusive: the GET failed or the doc lacks dist fields — retry.
    }

    const elapsed = now() - start;
    if (elapsed + delayMs > budgetMs) {
      error(
        `\n⏳ ${PKG_NAME}@${version} is still not served (waiting on the ${stage}) after ` +
          `~${Math.round(elapsed / 60_000)} min.\n` +
          "   If npm accepted the publish, this is the registry still catching up, not a\n" +
          "   failed publish — do NOT re-publish. Run this again later:\n" +
          `     npm run release:verify-live -- ${version}`,
      );
      return 2;
    }
    if (shouldLogAttempt(attempt, totalAttempts, delayMs)) {
      log(`  [${attempt}] waiting on the ${stage} (${Math.round(elapsed / 1000)}s so far)…`);
    }
    await sleep(delayMs);
  }
}

module.exports = { verifyLive, parseArgs };

if (require.main === module) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(64);
  }
  verifyLive({
    ...args,
    fetch: globalThis.fetch,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: Date.now,
    log: (l) => console.log(l),
    error: (l) => console.error(l),
  }).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
