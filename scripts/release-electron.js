#!/usr/bin/env node
/**
 * Build a releasable desktop shell — the desktop-shell release flow, as one
 * command:
 *
 *     npm run release:electron
 *     npm run release:electron -- --skip-checks   # same-day rebuild; gates
 *                                                 # already ran via release:npm
 *
 * Run this ONLY after the npm version this shell will bundle is published
 * (`npm run release:npm`), and from the exact commit that produced it — the
 * runtime-bundle stamp is derived from the working tree, so a drifted tree
 * stamps a lie (docs-local/from-repo/RELEASING.md → "What has and has not actually been run").
 *
 * The sequence:
 *
 *   0. release window — this script ENDS BY PUBLISHING a GitHub Release,
 *      the moment every installed app starts being offered the update
 *      (within ~6h, via electron-updater). If this machine configures a
 *      window (scripts/release-window.local.json, gitignored), it only
 *      runs on the days that file allows.
 *   1. clean git tree, and HEAD already pushed (see the tag trap at step 10)
 *   2. signing preflight — a Developer ID identity in the keychain and
 *      APPLE_KEYCHAIN_PROFILE set. Without the env var electron-builder
 *      SILENTLY SKIPS notarization, which is precisely how an un-notarized
 *      dmg ships by accident; this script hard-fails instead. Plus `gh`
 *      installed and authenticated — fail here, not after a 20-minute build.
 *   3. registry preflight — package.json version must already be what the
 *      registry serves
 *   4. gates (unless --skip-checks): npm test · lint · check:licenses ·
 *      notices:check
 *   5. npm run compile:electron            → dist-electron/
 *   6. node scripts/next-build-release.js  → .next + manifest + dist-cli
 *   7. node scripts/build-runtime-bundle.js --from-registry
 *      → installs the PUBLISHED runtime into build/libi-bundle
 *   8. npx electron-builder --mac --publish never — signs, notarizes,
 *      staples (via the keychain profile), licence guard in afterPack
 *   9. verify: feed artifacts exist, stapler validate, Gatekeeper
 *      assessment on the .app inside the dmg
 *  10. publish the GitHub Release (tag v<version>, all four artifacts)
 */
const { spawnSync } = require("node:child_process");
const { existsSync, readFileSync, rmSync } = require("node:fs");
const path = require("node:path");
const { assertReleaseWindow } = require("./lib/release-window");

const ROOT = path.resolve(__dirname, "..");
const skipChecks = process.argv.includes("--skip-checks");

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

// ── 0. release window ──────────────────────────────────────────────────────
assertReleaseWindow("a desktop-shell release (it ends by publishing a GitHub Release)");

// ── 1. clean tree, HEAD pushed ─────────────────────────────────────────────
const dirty = capture("git", ["status", "--porcelain"]);
if (dirty === null || dirty !== "") {
  console.error(
    "❌ the git tree is not clean — build the shell from the exact commit\n" +
      "   that produced the published npm version.\n" + (dirty || ""),
  );
  process.exit(1);
}
// The tag trap: `gh release create` with a tag that exists nowhere creates
// it on the REMOTE's default-branch head — silently the wrong commit if the
// local work was never pushed. Require HEAD to be on origin first, and pin
// the tag to HEAD explicitly at step 10.
capture("git", ["fetch", "origin", "--quiet"]);
const headOnOrigin =
  spawnSync("git", ["merge-base", "--is-ancestor", "HEAD", "origin/main"], { cwd: ROOT })
    .status === 0;
if (!headOnOrigin) {
  console.error(
    "❌ HEAD is not on origin/main — push first, then release. The GitHub\n" +
      "   Release's tag must point at a commit the remote actually has.",
  );
  process.exit(1);
}

// ── 2. signing preflight ───────────────────────────────────────────────────
if (process.platform !== "darwin") {
  console.error("❌ this script currently builds the macOS shell and must run on macOS.");
  process.exit(1);
}
const identities = capture("security", ["find-identity", "-v", "-p", "codesigning"]) ?? "";
if (!identities.includes("Developer ID Application")) {
  console.error(
    "❌ no `Developer ID Application` identity in the keychain — signing would\n" +
      "   fall back to ad-hoc and every user would see “Libi is damaged”.\n" +
      "   Create/download a Developer ID Application certificate from the Apple\n" +
      "   Developer portal (or Xcode → Settings → Accounts → Manage Certificates)\n" +
      "   and install it into this machine's login keychain, then re-run.",
  );
  process.exit(1);
}
if (!process.env.APPLE_KEYCHAIN_PROFILE) {
  console.error(
    "❌ APPLE_KEYCHAIN_PROFILE is not set — electron-builder would build,\n" +
      "   sign, and then SILENTLY SKIP notarization. Set it first:\n" +
      '     export APPLE_KEYCHAIN_PROFILE="libi-notary"',
  );
  process.exit(1);
}
// gh is what publishes the release at the end — discover a missing login
// now, not after the 20-minute build.
if (spawnSync("gh", ["auth", "status"], { cwd: ROOT }).status !== 0) {
  console.error(
    "❌ the GitHub CLI is not authenticated (`gh auth status` failed) —\n" +
      "   this script ends by publishing the release with `gh`. Run\n" +
      "   `gh auth login` first.",
  );
  process.exit(1);
}

// ── 3. registry preflight ──────────────────────────────────────────────────
const version = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf-8")).version;
const served = capture("npm", ["view", "@nagellabs/libi", "version"]);
if (served !== version) {
  console.error(
    `❌ package.json says ${version} but the registry serves ${served ?? "(nothing)"}.\n` +
      "   The shell bundles a PUBLISHED runtime (--from-registry). Publish first\n" +
      "   (npm run release:npm), or check out the tag that produced the published\n" +
      "   version.",
  );
  process.exit(1);
}
console.log(`\n📦 building the shell around published @nagellabs/libi@${version}`);

// ── 4. gates ───────────────────────────────────────────────────────────────
if (skipChecks) {
  console.log("⚠  --skip-checks: trusting that tests/lint/licences ran on this exact commit.");
} else {
  run("tests", "npm", ["test"]);
  run("lint", "npm", ["run", "lint"]);
  run("licence gate", "npm", ["run", "check:licenses"]);
  // The packaged app ships THIRD-PARTY-NOTICES.md inside the runtime bundle;
  // this chain calls compile:electron + electron-builder directly, so the
  // `prebuild:electron` hook that normally runs this check never fires here.
  run("notices freshness", "npm", ["run", "notices:check"]);
}

// ── 5–8. build chain ───────────────────────────────────────────────────────
// Empty `release/` first. Step 9 proves the artifacts exist BY NAME and step 10
// uploads those names to the GitHub Release — so a leftover from an earlier
// build satisfies the check and ships instead. The names that matter are
// version-free or reused across runs (`Libi-arm64.dmg`, `latest-mac.yml`,
// `Libi-<v>-arm64-mac.zip`), which is exactly the set a re-run would inherit.
//
// Not hypothetical: on 2026-08-14, going into the first shell release, this
// directory still held an Aug-13 `Libi-arm64.dmg`, an Aug-13 zip + blockmap and
// an Aug-13 `latest-mac.yml` alongside Jul-29 Linux/Windows output. Had the
// build produced nothing, every existence check would have passed, `stapler
// validate` would have validated the OLD (already stapled) dmg, and users would
// have been served a signed binary from a different commit.
//
// Deliberately after the preflight: a failed gate should not destroy artifacts.
const releaseDir = path.join(ROOT, "release");
if (existsSync(releaseDir)) {
  rmSync(releaseDir, { recursive: true, force: true });
  console.log("\n▶ cleared release/ — artifacts are verified by name, so leftovers could ship");
}

run("compile the shell", "npm", ["run", "compile:electron"]);
run("release build (.next + manifest + dist-cli)", "node", ["scripts/next-build-release.js"]);
run("runtime bundle from the registry", "node", [
  "scripts/build-runtime-bundle.js",
  "--from-registry",
]);
// `--publish never` is explicit: electron-builder.yml now carries a `publish`
// section (the shell's electron-updater feed), and with a GH_TOKEN in the env
// electron-builder would otherwise upload MID-BUILD, before the staple /
// Gatekeeper / feed-artifact verification below has run. Publishing is step
// 10, after everything is verified — via gh, not electron-builder. The
// publish CONFIG still takes effect at build time: it writes app-update.yml
// into Resources/ and emits latest-mac.yml, both of which the updater needs.
run("package + sign + notarize + staple", "npx", [
  "electron-builder",
  "--mac",
  "--publish",
  "never",
]);

// ── 9. verify the artifact ─────────────────────────────────────────────────
// Assess the APP inside the mounted dmg, not the dmg container: the dmg is
// deliberately unsigned (electron-builder's dmg.sign default), so
// `spctl -t install <dmg>` reports "no usable signature" even for a
// perfectly notarized artifact — verified 2026-08-11 on the first accepted
// submission. What Gatekeeper actually judges at launch is the .app.
// Version-free on purpose (electron-builder.yml `dmg.artifactName`): the
// marketing site links to releases/latest/download/Libi-arm64.dmg.
const dmg = path.join(ROOT, "release", `Libi-arm64.dmg`);

// The shell's update feed. Every installed app asks GitHub Releases for
// `latest-mac.yml` and downloads the `.zip` it names (electron/shell-updater.ts)
// — a release uploaded without them makes every installed shell's update
// check fail, silently, forever. Catch that here, not in the field.
const feedArtifacts = [
  path.join(ROOT, "release", "latest-mac.yml"),
  path.join(ROOT, "release", `Libi-${version}-arm64-mac.zip`),
  path.join(ROOT, "release", `Libi-${version}-arm64-mac.zip.blockmap`),
];
const missingFeed = feedArtifacts.filter((p) => !existsSync(p));
if (missingFeed.length > 0) {
  console.error(
    "❌ the shell-update feed artifacts were not produced:\n" +
      missingFeed.map((p) => `   - ${p}`).join("\n") +
      "\n   Installed apps read these from the GitHub Release to self-update —" +
      "\n   check the `publish:` section of electron-builder.yml.",
  );
  process.exit(1);
}

run("staple check", "xcrun", ["stapler", "validate", dmg]);
console.log("\n▶ Gatekeeper assessment (the .app inside the dmg — can take a few minutes)");
run("mount dmg", "hdiutil", ["attach", dmg, "-nobrowse", "-quiet"]);
const volume = `/Volumes/Libi ${version}-arm64`;
const verdict = spawnSync("spctl", ["-a", "-vv", "-t", "execute", path.join(volume, "Libi.app")], {
  cwd: ROOT,
  encoding: "utf-8",
});
const spctlOut = (verdict.stdout || "") + (verdict.stderr || "");
console.log(spctlOut.trim());
spawnSync("hdiutil", ["detach", volume, "-quiet"], { cwd: ROOT });
if (verdict.status !== 0 || !/Notarized Developer ID/.test(spctlOut)) {
  console.error("❌ Gatekeeper does not accept the app as Notarized Developer ID — do not ship it.");
  process.exit(1);
}

console.log(
  `\n✔ release/Libi-arm64.dmg (v${version}) is signed, notarized, stapled and\n` +
    "  Gatekeeper-accepted. Publishing the GitHub Release…",
);

// ── 10. publish the GitHub Release ─────────────────────────────────────────
// This is the outward step: the moment latest-mac.yml is on the LATEST
// release, every installed app is offered the update within ~6h
// (electron/shell-updater.ts checks on boot and every 6h). All four
// artifacts ship together — the dmg for humans, the zip + blockmap +
// latest-mac.yml for the updater.
const tag = `v${version}`;
const headSha = capture("git", ["rev-parse", "HEAD"]);
const assets = [dmg, ...feedArtifacts];
const releaseExists =
  spawnSync("gh", ["release", "view", tag], { cwd: ROOT }).status === 0;
if (releaseExists) {
  // A re-run after a failed upload: replace the assets on the existing
  // release rather than failing on "already exists".
  run(`upload assets to existing release ${tag}`, "gh", [
    "release",
    "upload",
    tag,
    ...assets,
    "--clobber",
  ]);
} else {
  run(`create GitHub release ${tag}`, "gh", [
    "release",
    "create",
    tag,
    ...assets,
    "--title",
    `Libi ${version}`,
    "--generate-notes",
    // Pin the tag to the exact commit this build came from (verified pushed
    // in step 1) — without this, a nonexistent tag lands on the remote's
    // default-branch head, whatever that happens to be.
    "--target",
    headSha,
  ]);
}

console.log(
  `\n✅ Libi ${version} is released: https://github.com/Nagellabs/libi/releases/tag/${tag}\n` +
    "   Installed desktop apps will offer this update within ~6h.\n\n" +
    "   Recommended before announcing — boot the dmg you just shipped and check:\n" +
    "   bundled-runtime boot works offline, a fetched-runtime boot is preferred\n" +
    "   over the bundled one when both are valid, and an out-of-range runtime\n" +
    "   is rejected rather than loaded.",
);
