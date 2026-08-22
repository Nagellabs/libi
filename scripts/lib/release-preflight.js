/**
 * Release-day decisions `release-npm.js` used to make the maintainer make.
 *
 * Both of these are the same failure: the script knew exactly what was wrong
 * and what the remedy was, printed it, and then made a human type it — on
 * release day, under time pressure, with a half-finished release on disk.
 *
 * They live here, as pure functions over observed state, so they can be tested
 * as decisions rather than as a script. The script wires the real filesystem,
 * the real registry and the real git calls into them.
 */

/**
 * What to do about a `dist-electron/` directory sitting in the tree.
 *
 * `npm pack` force-includes whatever `package.json#main` points at, even
 * against the `files` allowlist, so the Electron main-process build would ship
 * inside the npm CLI tarball. The guard has existed for that; what it did NOT
 * do is clear a directory nothing is using.
 *
 * It blocked 0.1.2 and 0.1.3 on consecutive release days. The trigger is
 * "opened the desktop shell at some point since the last release", which is a
 * completely normal thing to do.
 *
 * The original refusal was still right for the case it was written for, and
 * that reason is preserved verbatim: **a running `npm run electron` loads its
 * entire process tree from that directory.** Deleting it out from under a live
 * shell is a genuinely bad outcome. So this asks the two questions separately.
 *
 * @param {{ exists: boolean, somethingRunning: boolean, platform: string }} state
 * @returns {"proceed" | "remove" | "refuse"}
 */
function decideDistElectron({ exists, somethingRunning, platform }) {
  if (!exists) return "proceed";
  // On win32 we cannot ask the liveness question honestly — `pgrep` is not
  // there, and a probe that silently answers "nothing found" would delete a
  // running app's process tree. A release that stops on Windows is an
  // inconvenience; that would be a bug report.
  if (platform === "win32") return "refuse";
  return somethingRunning ? "refuse" : "remove";
}

/**
 * Whether this release needs a version bump, or should publish what is already
 * in `package.json`.
 *
 * The rule the script documented and enforced with nothing:
 *
 * > If the publish alone fails after the bump has already happened, DO NOT
 * > re-run with a bump type (that double-bumps): re-run with `none`.
 *
 * On 0.1.3 the `patch` run bumped, committed and tagged, then `npm publish` sat
 * at the 2FA browser prompt and was never completed. Re-running the same
 * command would have silently released 0.1.4 and skipped 0.1.3 forever. The
 * only thing preventing that was somebody remembering a doc line.
 *
 * ONE signal settles it: **is the version in `package.json` already on npm?**
 * Everything else is corroboration, and every other branch here is a refusal
 * rather than a guess.
 *
 * @param {object} state
 * @param {string} state.pkgVersion            version in package.json
 * @param {boolean} state.publishedThisVersion the per-version registry doc exists
 * @param {boolean} state.everPublishedThisVersion  present in the packument's `time` map
 * @param {boolean} state.tagExists            a `v<version>` tag exists
 * @param {boolean} state.tagAtHead            that tag points at HEAD
 * @param {string|null} state.explicitBump     "patch"|"minor"|"major"|"none"|null
 * @returns {{ action: "bump"|"publish-as-is"|"refuse", bump?: string, reason?: string }}
 */
function decideBump({
  pkgVersion,
  publishedThisVersion,
  everPublishedThisVersion,
  tagExists,
  tagAtHead,
  explicitBump,
}) {
  // An explicit choice always wins. Auto-detect decides WHETHER to bump, never
  // how much, and a human who types `minor` knows something this cannot infer.
  if (explicitBump === "none") return { action: "publish-as-is" };
  if (explicitBump) return { action: "bump", bump: explicitBump };

  // The tree is at a released version: this is a fresh release. Default patch.
  if (publishedThisVersion) return { action: "bump", bump: "patch" };

  // 404 in the version doc is NOT automatically "free to publish". npm lets a
  // version be unpublished within 72h and then refuses that exact number
  // forever. The packument's `time` map still lists it while `versions` does
  // not — that difference is the only way to tell, and getting it wrong means
  // passing every gate and dying at the last step.
  if (everPublishedThisVersion) {
    return {
      action: "refuse",
      reason:
        `${pkgVersion} was published and then unpublished. npm will never accept ` +
        `that version number again — bump to the next one explicitly.`,
    };
  }

  if (!tagExists) {
    return {
      action: "refuse",
      reason:
        `${pkgVersion} is not on npm and has no v${pkgVersion} tag. That is not a ` +
        `state this script produces — package.json was probably edited by hand. ` +
        `Say what you want explicitly (\`none\` to publish it as-is).`,
    };
  }

  if (!tagAtHead) {
    return {
      action: "refuse",
      reason:
        `v${pkgVersion} exists but does not point at HEAD, so publishing would ship ` +
        `code the tag does not cover. Moving the tag is a decision about what ` +
        `v${pkgVersion} means — make it deliberately, not here.`,
    };
  }

  // Bumped, tagged, never published: a previous run died at the publish. This
  // is the 0.1.3 case, and resuming is exactly right.
  return { action: "publish-as-is" };
}

/**
 * Should the run remind the maintainer to push the version commit and tag?
 *
 * The old check asked *did I bump this run?* — the wrong question. On 0.1.3 the
 * bump had happened in an earlier aborted run, so the answer was "no" and the
 * reminder was suppressed on the one run where it was needed. Ask what is
 * actually true of the repo instead.
 *
 * @param {{ commitUnpushed: boolean, tagUnpushed: boolean }} state
 */
function needsVersionPush({ commitUnpushed, tagUnpushed }) {
  return Boolean(commitUnpushed || tagUnpushed);
}

module.exports = { decideDistElectron, decideBump, needsVersionPush };
