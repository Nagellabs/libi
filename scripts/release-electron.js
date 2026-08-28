#!/usr/bin/env node
/**
 * Build a releasable desktop shell — the desktop-shell release flow, as one
 * command:
 *
 *     npm run release:electron
 *     npm run release:electron -- --skip-checks   # same-day rebuild; gates
 *                                                 # already ran via release:npm
 *
 * TARGETS. `--target=mac` (the default) is the flow described below and the
 * one a maintainer runs by hand. `--target=win` builds the NSIS installer and
 * must run on Windows — there is no cross-compilation, because the native
 * modules inside the app are rebuilt for the host's ABI mid-build. Windows is
 * not code-signed yet, deliberately: sequencing it after the flow works means
 * SmartScreen's warning is observed on the unsigned build rather than guessed.
 *
 * WHERE IT RUNS. `--ci` switches the macOS signing inputs from a local keychain
 * to environment variables supplied by the `release` GitHub Environment, and
 * `--no-github-release` suppresses step 10 so mac and Windows — which build on
 * different runners — can be collected into ONE release by
 * scripts/release-github.js afterwards. Everything else is identical; a CI
 * release runs the same gates and the same verification as a local one.
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
 *   9. verify: feed artifacts exist, notarize + staple the DMG ITSELF
 *      (electron-builder only staples the .app, then wraps it), re-digest it
 *      in latest-mac.yml, stapler validate, Gatekeeper assessment on the
 *      .app inside the dmg
 *  10. publish the GitHub Release (tag v<version>, all four artifacts)
 */
const { spawnSync } = require("node:child_process");
const {
  copyFileSync,
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} = require("node:fs");
const { createHash } = require("node:crypto");
const path = require("node:path");
const { assertReleaseWindow } = require("./lib/release-window");
const {
  gatesPassedOnAncestor,
  gatesPassedOnHead,
  recordGatesPassed,
} = require("./lib/gate-provenance");

const ROOT = path.resolve(__dirname, "..");
const skipChecks = process.argv.includes("--skip-checks");

// Which desktop shell to build. `mac` is the historical behaviour and stays the
// default, so every existing invocation means exactly what it always meant.
const targetArg = process.argv.find((a) => a.startsWith("--target="));
const target = targetArg ? targetArg.slice("--target=".length) : "mac";
if (!["mac", "win"].includes(target)) {
  console.error(`usage: --target=mac|win (got ${JSON.stringify(target)})`);
  process.exit(1);
}
const isMacTarget = target === "mac";

// Running on a GitHub runner rather than the maintainer's Mac. The signing
// material arrives as environment variables from a protected Environment
// instead of living in a local keychain — see the manual-setup section of
// docs-local/release/next-release.md.
const ci = process.argv.includes("--ci");

// Publishing the GitHub Release is a SEPARATE step in the CI pipeline: mac and
// Windows build on different runners, and the release must carry both sets of
// artifacts, so neither build job may create it. scripts/release-github.js does
// it once, after both have finished.
const publishRelease = !process.argv.includes("--no-github-release");

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
// electron-builder cross-compiles poorly and we do not try: each target builds
// on its own OS, because the native modules bundled into the app are rebuilt
// for that OS's ABI during the build.
const requiredPlatform = isMacTarget ? "darwin" : "win32";
if (process.platform !== requiredPlatform) {
  console.error(
    `❌ --target=${target} must run on ${requiredPlatform}, not ${process.platform}.\n` +
      "   Native modules are rebuilt for the host during the build, so a\n" +
      "   cross-built shell would ship the wrong binaries.",
  );
  process.exit(1);
}

if (isMacTarget && ci) {
  // On a runner there is no login keychain and no `security find-identity`
  // result to inspect: electron-builder imports the certificate from CSC_LINK
  // into a temporary keychain it creates itself. Check the inputs instead —
  // all of them, because a MISSING one does not fail the build, it silently
  // produces an unsigned or un-notarized app that ships looking fine.
  const required = [
    ["CSC_LINK", "base64 of the Developer ID Application .p12"],
    ["CSC_KEY_PASSWORD", "the .p12 export password"],
    ["APPLE_API_KEY", "path to the App Store Connect .p8 written by the workflow"],
    ["APPLE_API_KEY_ID", "the key's 10-character Key ID"],
    ["APPLE_API_ISSUER", "the App Store Connect issuer UUID"],
  ];
  const missing = required.filter(([k]) => !process.env[k]);
  if (missing.length > 0) {
    console.error(
      "❌ macOS signing material is incomplete on this runner:\n" +
        missing.map(([k, why]) => `   - ${k} — ${why}`).join("\n") +
        "\n\n   These come from the `release` GitHub Environment. A missing one does\n" +
        "   NOT fail electron-builder — it produces an unsigned or un-notarized\n" +
        "   app that looks like a successful build, which is the exact accident\n" +
        "   APPLE_KEYCHAIN_PROFILE exists to prevent locally.",
    );
    process.exit(1);
  }
  if (!existsSync(process.env.APPLE_API_KEY)) {
    console.error(
      `❌ APPLE_API_KEY points at ${process.env.APPLE_API_KEY}, which does not exist.\n` +
        "   The workflow decodes the .p8 secret to that path before this step.",
    );
    process.exit(1);
  }
  console.log("  CI signing material present (CSC_LINK + App Store Connect API key)");
} else if (isMacTarget) {
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
}
// gh is what publishes the release at the end — discover a missing login
// now, not after the 20-minute build.
if (publishRelease && spawnSync("gh", ["auth", "status"], { cwd: ROOT }).status !== 0) {
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
  // This used to print "trusting that tests/lint/licences ran on this exact
  // commit" and verify nothing — a claim in the release log that no one could
  // check. `release:npm` now records the commit its gates passed on, so the
  // claim is testable; refuse when it does not hold.
  // Locally: the gates wrote a record on THIS machine for THIS commit.
  // In CI they cannot have — they ran in their own job, on their own runner,
  // against the commit BEFORE the version bump this job checks out. So verify
  // the thing that actually matters there: that nothing but the bump separates
  // the tested commit from this one.
  const provenance = ci
    ? gatesPassedOnAncestor(process.env.LIBI_GATES_SHA)
    : gatesPassedOnHead();
  if (!provenance.ok) {
    console.error(`❌ --skip-checks cannot be honoured: ${provenance.reason}`);
    process.exit(1);
  }
  console.log(
    ci
      ? `✔ --skip-checks: gates passed on ${String(provenance.record.sha).slice(0, 8)}, and only\n` +
          `  the version bump separates it from HEAD (${provenance.bumpOnly.join(", ") || "no diff"}).`
      : `✔ --skip-checks: gates [${provenance.record.gates.join(", ")}] passed on this exact\n` +
          `  commit at ${provenance.record.at}.`,
  );
} else {
  run("tests", "npm", ["test"]);
  run("lint", "npm", ["run", "lint"]);
  run("licence gate", "npm", ["run", "check:licenses"]);
  // The packaged app ships THIRD-PARTY-NOTICES.md inside the runtime bundle;
  // this chain calls compile:electron + electron-builder directly, so the
  // `prebuild:electron` hook that normally runs this check never fires here.
  run("notices freshness", "npm", ["run", "notices:check"]);
  recordGatesPassed(["test", "lint", "check:licenses", "notices:check"]);
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
run(
  isMacTarget ? "package + sign + notarize + staple" : "package (NSIS installer)",
  "npx",
  ["electron-builder", isMacTarget ? "--mac" : "--win", "--publish", "never"],
);

// ── 9. verify the artifact ─────────────────────────────────────────────────
// Windows. There is no signature to check yet (code signing is deliberately
// sequenced after the flow works end to end), so what matters here is that all
// three artifacts a user and an updater need actually exist.
let assets;
if (!isMacTarget) {
  const installer = path.join(ROOT, "release", `Libi Setup ${version}.exe`);
  // electron-updater on Windows resolves `latest.yml` and the blockmap beside
  // it. Ship the installer alone and every Windows user gets a shell whose
  // update check fails silently, forever — confirmed live on Linux, where a
  // running AppImage reported "Cannot find latest-linux.yml".
  const winFeed = [
    path.join(ROOT, "release", "latest.yml"),
    `${installer}.blockmap`,
  ];
  const missingWin = [installer, ...winFeed].filter((f) => !existsSync(f));
  if (missingWin.length > 0) {
    console.error(
      "❌ the Windows artifacts were not produced:\n" +
        missingWin.map((f) => `   - ${f}`).join("\n"),
    );
    process.exit(1);
  }
  // A SECOND, version-free copy of the same installer — not a rename.
  //
  // libi-site wants a permanent link, and GitHub resolves `latest` dynamically
  // but matches asset names LITERALLY, so `Libi Setup 0.1.4.exe` can never be
  // one. The dmg solves this by being version-free (electron-builder.yml
  // `dmg.artifactName`).
  //
  // Windows cannot copy that trick by renaming, because unlike the dmg the NSIS
  // installer IS the electron-updater feed artifact: `latest.yml` names it, and
  // reusing one name across versions breaks blockmap differential downloads and
  // CDN caching — the exact hazard `dmg.artifactName`'s comment documents for
  // the mac ZIP. So the versioned installer stays exactly as it is, and this is
  // a copy beside it for humans to click.
  const stableInstaller = path.join(ROOT, "release", "Libi-Setup-x64.exe");
  copyFileSync(installer, stableInstaller);

  const mb = (f) => (statSync(f).size / 1024 / 1024).toFixed(1);
  console.log(
    `\n✔ release/Libi Setup ${version}.exe (${mb(installer)} MB), its blockmap and\n` +
      "  latest.yml are present, plus release/Libi-Setup-x64.exe — the same bytes\n" +
      "  under a version-free name, so libi-site can link to\n" +
      "  releases/latest/download/Libi-Setup-x64.exe permanently.\n" +
      "  UNSIGNED by design — SmartScreen will warn, and the installer must be\n" +
      "  booted on a real Windows 11 desktop before it is attached to a release\n" +
      "  (docs-local/release/next-release.md).",
  );
  assets = [installer, stableInstaller, ...winFeed];
}


if (isMacTarget) {
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

  // ── 9a. notarize and staple the DMG ITSELF ─────────────────────────────────
  // electron-builder notarizes and staples the .app, then builds the dmg AROUND
  // the stapled app. The dmg container therefore carries no ticket of its own —
  // `stapler validate <dmg>` fails with "does not have a ticket stapled to it"
  // even though the app inside is perfectly notarized. Observed on the first
  // shell release, 2026-08-14: notarization succeeded, the app validated and
  // assessed as Notarized Developer ID, and this script still died at the staple
  // check below.
  //
  // It matters beyond the check passing. The .app's ticket only covers the app
  // once extracted; the DMG is what the user downloads and opens first, and
  // without its own ticket Gatekeeper has to reach Apple to clear it. Offline or
  // behind a captive portal, that is exactly the "damaged / cannot be opened"
  // experience notarization exists to prevent. So submit the dmg too, and staple
  // it, before anything validates it.
  const stapled = spawnSync("xcrun", ["stapler", "validate", dmg], { cwd: ROOT });
  if (stapled.status !== 0) {
    // Locally the credentials live in a keychain profile; on a runner there is
    // no keychain to hold one, so the same App Store Connect API key that
    // electron-builder used for the .app notarizes the dmg too.
    const notaryAuth = ci
      ? ["--key", process.env.APPLE_API_KEY,
         "--key-id", process.env.APPLE_API_KEY_ID,
         "--issuer", process.env.APPLE_API_ISSUER]
      : ["--keychain-profile", process.env.APPLE_KEYCHAIN_PROFILE];
    run("notarize the dmg", "xcrun", [
      "notarytool", "submit", dmg,
      ...notaryAuth,
      "--wait",
    ]);
    run("staple the dmg", "xcrun", ["stapler", "staple", dmg]);

    // Stapling REWRITES the dmg — it grew 2416 bytes on the first release — so
    // the digest electron-builder recorded for it in latest-mac.yml is now a lie.
    // The updater downloads the zip (`path:`), which stapling never touches, so
    // updates would still work; shipping a feed with a wrong checksum in it
    // would not be defensible anyway.
    const feedPath = path.join(ROOT, "release", "latest-mac.yml");
    const sha512 = createHash("sha512").update(readFileSync(dmg)).digest("base64");
    const size = statSync(dmg).size;
    const before = readFileSync(feedPath, "utf-8");
    const after = before.replace(
      /(- url: Libi-arm64\.dmg\n\s+sha512: )[^\n]+(\n\s+size: )\d+/,
      (_m, head, mid) => `${head}${sha512}${mid}${size}`,
    );
    if (after === before) {
      console.error(
        "❌ could not update the dmg's digest in latest-mac.yml — the feed would\n" +
          "   advertise a checksum the stapled dmg no longer has. Fix by hand before shipping.",
      );
      process.exit(1);
    }
    writeFileSync(feedPath, after);
    console.log("[release] re-digested the stapled dmg in latest-mac.yml");

    // The dmg's blockmap was generated from the PRE-staple bytes, so it now
    // describes a file that no longer exists. It is not in `feedArtifacts` and is
    // not uploaded, so nothing is broken today — but a stale blockmap sitting
    // beside a shipped artifact is a trap waiting for whoever adds it to the
    // upload list, and differential downloads would fail silently. Delete it
    // rather than leave a lie on disk; electron-updater uses the ZIP's blockmap,
    // which stapling never touches.
    const dmgBlockmap = `${dmg}.blockmap`;
    if (existsSync(dmgBlockmap)) {
      rmSync(dmgBlockmap, { force: true });
      console.log("[release] removed the pre-staple dmg blockmap (it described the unstapled file)");
    }
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
      "  Gatekeeper-accepted.",
  );
  // The dmg for humans; the zip + blockmap + latest-mac.yml for the updater.
  assets = [dmg, ...feedArtifacts];
}

// ── 10. publish the GitHub Release ─────────────────────────────────────────
// This is the outward step: the moment latest-mac.yml is on the LATEST
// release, every installed app is offered the update within ~6h
// (electron/shell-updater.ts checks on boot and every 6h). All four
// artifacts ship together — the dmg for humans, the zip + blockmap +
// latest-mac.yml for the updater.
if (!publishRelease) {
  console.log(
    `\n✅ ${target} artifacts are built and verified. NOT publishing a GitHub\n` +
      "   Release — this run was asked not to (--no-github-release), because the\n" +
      "   release must carry mac AND Windows artifacts and they are built on\n" +
      "   different runners. scripts/release-github.js publishes once, after both.",
  );
  process.exit(0);
}

const tag = `v${version}`;
const headSha = capture("git", ["rev-parse", "HEAD"]);
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
