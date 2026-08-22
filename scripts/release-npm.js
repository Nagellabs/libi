#!/usr/bin/env node
/**
 * Release `@nagellabs/libi` to npm — the npm-publish release flow, as one
 * command:
 *
 *     npm run release:npm -- patch      # or minor / major / none
 *     npm run release:npm -- patch --dry-run
 *
 * `none` skips the version bump (the tree already carries the version to
 * publish). `--dry-run` runs every gate and build but replaces the real
 * publish with `npm publish --dry-run` and skips the registry verification.
 *
 * The sequence, each step gating the next:
 *
 *   0. release window — if this machine configures one
 *      (scripts/release-window.local.json, gitignored), publishing only
 *      runs on the days it allows. `--dry-run` is exempt: it publishes
 *      nothing, so rehearsing it any day is fine.
 *   1. clean git tree
 *   2. publish guards — `private: true` must be gone (removing it is a
 *      conscious act; this script refuses rather than removes),
 *      `publishConfig.access` must be "public"
 *   3. npm test · npm run lint · npm run check:licenses · notices:check
 *   4. version bump (`npm version <type>` — commits + tags), then
 *      REGENERATE the third-party notices: the bump rewrites the version
 *      inside package-lock.json, whose sha256 the notices file pins, so
 *      step 3's `notices:check` is invalidated by step 4. Left unfixed it
 *      surfaces as a stale-notices failure in `release:electron`.
 *   5. node scripts/next-build-release.js — the RELEASE build: .next with
 *      Sentry reporting baked in (packaged apps install this very tarball,
 *      so a plain `npm run build` here would ship desktop users a
 *      non-reporting runtime), the externals manifest, and dist-cli
 *   6. npm run registry:e2e — full publish → install rehearsal on Verdaccio
 *   7. npm publish. npm handles its own auth, and on a 2FA account that is
 *      now a WEB flow, not an OTP prompt: it prints an
 *      https://www.npmjs.com/auth/cli/… URL and waits on
 *      "Press ENTER to open in the browser". It therefore needs a real
 *      terminal and a human — it cannot be piped or automated. If the
 *      publish alone fails after the bump has already happened, DO NOT
 *      re-run with a bump type (that double-bumps): re-run with `none`,
 *      which publishes the version already in package.json.
 *   8. verify what the registry actually serves (npm view)
 */
const { spawnSync } = require("node:child_process");
const { existsSync, readFileSync, rmSync } = require("node:fs");
const path = require("node:path");
const { assertReleaseWindow } = require("./lib/release-window");
const { recordGatesPassed } = require("./lib/gate-provenance");
const {
  decideDistElectron,
  decideBump,
  needsVersionPush,
} = require("./lib/release-preflight");

const ROOT = path.resolve(__dirname, "..");
const PKG_NAME = "@nagellabs/libi";

/** Portable synchronous sleep — no `sleep(1)` dependency, works on Windows. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
// No argument = work it out. An explicit one still wins; see `decideBump`.
const explicitBump = args.find((a) => !a.startsWith("--")) ?? null;

if (explicitBump !== null && !["patch", "minor", "major", "none"].includes(explicitBump)) {
  console.error(
    "usage: npm run release:npm -- [patch|minor|major|none] [--dry-run]\n" +
      "  (no argument)  work out from npm + git whether a bump is needed\n" +
      "  none           publish the version already in package.json (no bump)\n" +
      "  --dry-run      run everything, but `npm publish --dry-run` at the end",
  );
  process.exit(1);
}

function run(title, cmd, cmdArgs, opts = {}) {
  console.log(`\n▶ ${title}\n  $ ${cmd} ${cmdArgs.join(" ")}`);
  const res = spawnSync(cmd, cmdArgs, { stdio: "inherit", cwd: ROOT, ...opts });
  if (res.status !== 0) {
    console.error(`\n❌ step failed: ${title} (exit ${res.status})`);
    process.exit(res.status ?? 1);
  }
}

function capture(cmd, cmdArgs) {
  const res = spawnSync(cmd, cmdArgs, { cwd: ROOT, encoding: "utf-8" });
  return res.status === 0 ? res.stdout.trim() : null;
}

const pkg = () => JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf-8"));

// ── 0. release window ──────────────────────────────────────────────────────
// A dry run publishes nothing, so it may rehearse the whole pipeline any day.
if (!dryRun) assertReleaseWindow("an npm publish");

// ── 1. clean tree ──────────────────────────────────────────────────────────
const dirty = capture("git", ["status", "--porcelain"]);
if (dirty === null || dirty !== "") {
  console.error(
    "❌ the git tree is not clean. Commit or stash first — the publish must\n" +
      "   come from a reproducible commit.\n" + (dirty || ""),
  );
  process.exit(1);
}

// ── 2. publish guards ──────────────────────────────────────────────────────
{
  const p = pkg();
  if (p.private === true) {
    console.error(
      '❌ package.json still has `"private": true` — the accidental-publish\n' +
        "   guard. Removing it is a deliberate act, for the first publish only:\n" +
        "   delete the line, commit, and re-run.",
    );
    process.exit(1);
  }
  if (p.publishConfig?.access !== "public") {
    console.error(
      '❌ publishConfig.access must be "public" — a scoped package publishes\n' +
        "   as restricted (paid, invisible) without it.",
    );
    process.exit(1);
  }
}
// `dist-electron/` blocks the pack — but the guard that says so lives in
// `prepack`, which runs inside `registry:e2e`, which is step 6. Discovering it
// there costs the whole gate run first; it cost exactly that on 2026-08-14.
//
// It then blocked 0.1.2 and 0.1.3 on consecutive release days, because the
// trigger is "opened the desktop shell since the last release" — a normal
// thing to do. So the two questions are now asked separately: is it there, and
// is anything USING it. The original refusal survives for the case it was
// written for (a running `npm run electron` loads its whole process tree from
// that directory); it just no longer fires when nothing is running.
{
  const distElectron = path.join(ROOT, "dist-electron");
  const exists = existsSync(distElectron);
  // `pgrep -f` covers darwin and linux; `decideDistElectron` refuses outright
  // on win32 rather than trust a probe that cannot answer there.
  const somethingRunning =
    exists &&
    process.platform !== "win32" &&
    spawnSync("pgrep", ["-f", distElectron], { encoding: "utf-8" }).status === 0;

  switch (decideDistElectron({ exists, somethingRunning, platform: process.platform })) {
    case "remove":
      rmSync(distElectron, { recursive: true, force: true });
      console.log(
        "  removed a stale dist-electron/ (nothing was running from it).\n" +
          "  Regenerate any time with `npm run compile:electron`.",
      );
      break;
    case "refuse":
      console.error(
        "❌ dist-electron/ is present and in use — `npm pack` would refuse (npm\n" +
          "   force-includes whatever package.json#main points at, even against the\n" +
          "   `files` allowlist, so the Electron main-process build would ship inside\n" +
          "   the npm CLI tarball).\n\n" +
          "   Something is running out of that directory — quit it, then re-run.\n" +
          "   (Refusing rather than deleting: a running `npm run electron` loads its\n" +
          "   entire process tree from there.)",
      );
      process.exit(1);
      break;
    default:
      break;
  }
}

// Publish credentials, checked in seconds rather than after ~12 minutes of
// gates. `release-electron.js` already fails fast on signing and `gh`; this is
// the same idea for the one thing that can only fail at the very last step.
{
  const who = capture("npm", ["whoami"]);
  if (!who) {
    console.error(
      "❌ not logged in to npm (`npm whoami` failed) — the publish at step 7\n" +
        "   would fail after every gate has run. Run `npm login` first.",
    );
    process.exit(1);
  }
  console.log(`  npm user: ${who}`);
  // npm requires a publish to be backed by EITHER a 2FA one-time password OR a
  // granular token with "bypass 2FA" enabled. With neither, it does not prompt
  // — it just returns E403 at the end, which is how 2026-08-14 was lost. We
  // cannot tell a granular bypass token from a classic one here, so this warns
  // rather than refusing; a bypass token is a legitimate (if riskier) setup.
  const profile = capture("npm", ["profile", "get"]) ?? "";
  if (/two-factor auth:\s*disabled/i.test(profile)) {
    console.warn(
      "\n⚠  npm reports `two-factor auth: disabled` on this account.\n" +
        "   If this machine authenticates with a classic token, the publish will\n" +
        "   fail at the very end with:\n" +
        "     E403 … Two-factor authentication or granular access token with\n" +
        "     bypass 2fa enabled is required to publish packages.\n" +
        "   Fix by enabling 2FA (npmjs.com → Account → Two-factor authentication,\n" +
        "   then `npm logout && npm login`), or by using a granular access token\n" +
        "   scoped to @nagellabs/* with 2FA-bypass. Continuing — a bypass token\n" +
        "   is indistinguishable from here.\n",
    );
  }
}

if (!process.env.SENTRY_AUTH_TOKEN) {
  console.warn(
    "⚠  SENTRY_AUTH_TOKEN is not set — the build will succeed but production\n" +
      "   stack traces in Sentry stay minified (no source-map upload).",
  );
}

// ── 3. gates ───────────────────────────────────────────────────────────────
run("tests", "npm", ["test"]);
run("lint", "npm", ["run", "lint"]);
run("licence gate", "npm", ["run", "check:licenses"]);
// The tarball ships THIRD-PARTY-NOTICES.md (`files` in package.json), and the
// only other place this check runs is `prebuild:electron` — which this script
// never touches. A dep bump without `notices:generate` would otherwise ship
// stale attributions.
run("notices freshness", "npm", ["run", "notices:check"]);

// Record what just passed, and on which commit, so a same-day
// `release:electron --skip-checks` can VERIFY that claim instead of asserting it.
recordGatesPassed(["test", "lint", "check:licenses", "notices:check"]);

/**
 * Re-sync THIRD-PARTY-NOTICES.md with the lockfile the version bump just
 * rewrote, and fold it into the version commit.
 *
 * WHY THIS EXISTS. Step 3 verifies `notices:check` — and then step 4 breaks
 * exactly what it verified. `npm version` writes the new version INTO
 * package-lock.json, which changes the lockfile's sha256, which no longer
 * matches the `source-lockfile-sha256` marker recorded in
 * THIRD-PARTY-NOTICES.md. Nothing here notices, because the check already ran.
 *
 * The damage surfaces later and somewhere else: `prebuild:electron` re-runs the
 * same check, so `npm run release:electron` dies on its FIRST step with
 * "THIRD-PARTY-NOTICES.md is stale relative to package-lock.json" — against a
 * lockfile nobody edited, in a different command, possibly hours later. It cost
 * a release-day detour on 0.1.1 and again on 0.1.2. Documenting it did not stop
 * the second one, so it is fixed here instead.
 *
 * Only the marker line changes (a version bump touches no dependency), so this
 * is an amend rather than a second commit — `npm version` should leave ONE
 * clean commit. The tag it just created is re-pointed at the amended commit;
 * nothing has been pushed at this point, so that is safe.
 */
function syncNoticesAfterBump() {
  run("regenerate notices (the version bump invalidated them)", "npm", [
    "run",
    "notices:generate",
  ]);
  const dirty = capture("git", ["status", "--porcelain", "THIRD-PARTY-NOTICES.md"]);
  if (!dirty) {
    console.log("   notices already in sync — nothing to fold in");
    return;
  }
  const v = pkg().version;
  run("fold the notices into the version commit", "git", [
    "add",
    "THIRD-PARTY-NOTICES.md",
  ]);
  run("amend", "git", ["commit", "--amend", "--no-edit"]);
  // `npm version` tagged the pre-amend commit; move the tag to the real one.
  run("re-point the version tag", "git", ["tag", "-f", "-a", "-m", `v${v}`, `v${v}`]);
  console.log(`   notices re-synced and folded into the v${v} commit`);
}

// ── 4. version ─────────────────────────────────────────────────────────────
// Work out whether a bump is needed rather than trusting the maintainer to
// remember which flag this run wants. See `scripts/lib/release-preflight.js`
// for why one signal settles it and why every other branch is a refusal.
const bump = (() => {
  const pkgVersion = pkg().version;
  const tag = `v${pkgVersion}`;

  const versionDocStatus = capture("curl", [
    "-s", "-o", "/dev/null", "-w", "%{http_code}",
    `https://registry.npmjs.org/${encodeURIComponent(PKG_NAME)}/${pkgVersion}`,
  ]);
  // The per-version document is authoritative and updates BEFORE the
  // packument — step 8 documents the lag that makes the reverse unreliable.
  const publishedThisVersion = versionDocStatus === "200";

  // `time` still lists a version that was unpublished; `versions` does not.
  // That difference is the only way to see a number npm will never take again.
  let everPublishedThisVersion = publishedThisVersion;
  if (!publishedThisVersion) {
    const packument = capture("curl", ["-s", `https://registry.npmjs.org/${encodeURIComponent(PKG_NAME)}`]);
    try {
      everPublishedThisVersion = Boolean(JSON.parse(packument)?.time?.[pkgVersion]);
    } catch {
      everPublishedThisVersion = false; // unreachable registry: fall through to the git checks
    }
  }

  const tagExists =
    spawnSync("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], { cwd: ROOT }).status === 0;
  const tagAtHead =
    tagExists &&
    capture("git", ["rev-list", "-n", "1", tag]) === capture("git", ["rev-parse", "HEAD"]);

  const decision = decideBump({
    pkgVersion,
    publishedThisVersion,
    everPublishedThisVersion,
    tagExists,
    tagAtHead,
    explicitBump,
  });

  if (decision.action === "refuse") {
    console.error(`❌ ${decision.reason}`);
    process.exit(1);
  }
  if (decision.action === "publish-as-is") {
    console.log(
      explicitBump === "none"
        ? `  no bump requested — publishing ${pkgVersion} as it stands`
        : `  ${pkgVersion} is bumped and tagged but not on npm — resuming that publish, not bumping again`,
    );
    return "none";
  }
  console.log(
    explicitBump
      ? `  bumping (${decision.bump}, as asked)`
      : `  ${pkgVersion} is already on npm — bumping (${decision.bump})`,
  );
  return decision.bump;
})();

if (bump !== "none") {
  run(`version bump (${bump})`, "npm", ["version", bump]);
  syncNoticesAfterBump();
}
const version = pkg().version;
console.log(`\n📦 releasing @nagellabs/libi@${version}${dryRun ? " (dry run)" : ""}`);

// ── 5. release build ───────────────────────────────────────────────────────
run("release build (.next + externals manifest + dist-cli)", "node", [
  "scripts/next-build-release.js",
]);

// ── 6. rehearsal ───────────────────────────────────────────────────────────
run("local-registry rehearsal", "npm", ["run", "registry:e2e"]);

// ── 7. publish ─────────────────────────────────────────────────────────────
run(
  dryRun ? "publish (DRY RUN)" : "publish",
  "npm",
  dryRun ? ["publish", "--dry-run"] : ["publish"],
);

// ── 8. verify the registry ─────────────────────────────────────────────────
if (dryRun) {
  console.log("\n✅ dry run complete — nothing was published.");
  process.exit(0);
}
// A publish's WRITES land before its READS do. npm serves the per-version
// document and the aggregated packument from different caches, and a brand-new
// scoped package's packument lags: on 2026-08-14 `npm view` answered E404 for
// about four minutes after `npm publish` had returned PUT 200. This check used
// to be a single `npm view` that exited 1 on mismatch, so a perfectly good
// first publish reported itself as a failure.
//
// Poll instead, and lead with the per-version document — it is authoritative
// and updates first. Only give up after the packument has had time to catch up.
const VERIFY_ATTEMPTS = 20;
const VERIFY_DELAY_MS = 15_000;
function versionDocExists() {
  const res = spawnSync(
    "curl",
    ["-s", "-o", "/dev/null", "-w", "%{http_code}",
      `https://registry.npmjs.org/${encodeURIComponent(PKG_NAME)}/${version}`],
    { encoding: "utf-8" },
  );
  return res.stdout.trim() === "200";
}
let served = null;
let latest = null;
for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt++) {
  served = capture("npm", ["view", PKG_NAME, "version"]);
  latest = capture("npm", ["view", PKG_NAME, "dist-tags.latest"]);
  if (served === version && latest === version) break;
  const doc = versionDocExists();
  console.log(
    `  [${attempt}/${VERIFY_ATTEMPTS}] packument ${served ?? "404"} · ` +
      `version document ${doc ? "200 (published ✓)" : "not yet"} — waiting for the CDN…`,
  );
  if (attempt === VERIFY_ATTEMPTS) {
    if (doc) {
      console.log(
        `\n✅ ${PKG_NAME}@${version} IS published — registry.npmjs.org serves its\n` +
          "   version document. Only the aggregated packument is still catching up,\n" +
          "   which is normal for a first publish and needs no action.",
      );
      break;
    }
    console.error(
      `❌ ${PKG_NAME}@${version} is not being served, and its version document is\n` +
        "   absent too — this is a real failure, not CDN lag. Check\n" +
        "   ~/.npm/_logs for the PUT status before announcing or re-publishing.",
    );
    process.exit(1);
  }
  sleepSync(VERIFY_DELAY_MS);
}
const shellApi = capture("npm", ["view", PKG_NAME, "libi.shellApiVersion"]);
console.log(`\n  registry serves : ${served}\n  dist-tags.latest: ${latest}\n  shellApiVersion : ${shellApi}`);
console.log(
  `\n✅ ${PKG_NAME}@${version} is live.\n` +
    "   Desktop installs see it via the in-app update check (within ~6h);\n" +
    "   `npx @nagellabs/libi` picks it up on next invocation." +
    // Ask what is TRUE OF THE REPO, not what this run happened to do. The old
    // check was `bump !== "none"` — "did I bump this run?" — so on 0.1.3, where
    // the bump had happened in an earlier aborted run, the reminder was
    // suppressed on the one run that needed it.
    (needsVersionPush({
      commitUnpushed: capture("git", ["log", "--oneline", "origin/main..HEAD"]) !== "",
      tagUnpushed:
        capture("git", ["ls-remote", "--tags", "origin", `v${version}`]) === "",
    })
      ? "\n   Don't forget: git push the version commit + tag."
      : ""),
);
