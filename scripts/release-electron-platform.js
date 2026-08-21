#!/usr/bin/env node
/**
 * Build and publish the Linux / Windows desktop shells.
 *
 * `release-electron.js` is and stays the macOS flow: its middle third is
 * Developer-ID signing, notarization, stapling and Gatekeeper assessment, none
 * of which has a Linux or Windows analogue. Rather than thread a platform
 * variable through all of that, this is its sibling for the platforms that
 * only need "build, verify, upload".
 *
 *     # on the target-platform machine (a QA VM), no credentials required:
 *     node scripts/release-electron-platform.js --build
 *
 *     # back on the machine that holds the gh credential:
 *     node scripts/release-electron-platform.js --attach linux ./release-linux
 *
 * ── Why build and upload are separate commands ────────────────────────────
 * The build has to happen ON the target platform: electron-builder's NSIS and
 * fpm steps plus the native-module rebuild are not reliably cross-compilable
 * from macOS. But the machines that do that building are throwaway QA VMs, and
 * the rig's standing rule is that no credential of any kind is ever placed on
 * one. `gh` auth is a credential. So the VM produces artifacts, they are copied
 * back, and the upload happens from the machine that already holds the token.
 *
 * ── The feed-file gate ────────────────────────────────────────────────────
 * electron-updater resolves a DIFFERENT feed file per platform: `latest.yml`
 * on Windows, `latest-linux.yml` on Linux, `latest-mac.yml` on macOS. Publish
 * a platform's installer without its feed file and every user on that platform
 * gets a shell whose update check fails silently, forever — no error, no
 * prompt, just permanently stuck.
 *
 * This is not hypothetical. On 2026-08-16 a locally built AppImage reported,
 * live: shell.phase="error", "Cannot find latest-linux.yml in the ...",
 * because the GitHub release carried only the mac feed. `--attach` refuses to
 * upload a platform's artifacts unless that platform's feed file is among them.
 */
const { spawnSync } = require("node:child_process");
const { existsSync, readFileSync, readdirSync, rmSync } = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const version = JSON.parse(
  readFileSync(path.join(ROOT, "package.json"), "utf-8"),
).version;

// ── the per-platform artifact contract ─────────────────────────────────────
// `installers` are what humans download; `feed` is what electron-updater reads.
// Both must reach the release. Names come from electron-builder.yml — the deb
// and AppImage names are pinned there (`deb.artifactName`, and AppImage's
// default `${productName}-${version}.AppImage`) and were confirmed against a
// real build on 2026-08-16.
const PLATFORMS = {
  linux: {
    builderFlag: "--linux",
    installers: (v) => [`Libi-${v}.AppImage`, `libi_${v}_amd64.deb`],
    feed: ["latest-linux.yml"],
  },
  win: {
    builderFlag: "--win",
    // NSIS default artifactName is `${productName} Setup ${version}.${ext}`,
    // and electron-builder emits a .blockmap beside it for differential
    // downloads. NOT yet confirmed against a real Windows build — the first
    // `--build` run on Windows should be checked against this list, and this
    // comment removed once it has.
    installers: (v) => [`Libi Setup ${v}.exe`, `Libi Setup ${v}.exe.blockmap`],
    feed: ["latest.yml"],
  },
};

function die(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

function run(title, cmd, args, opts = {}) {
  console.log(`\n▶ ${title}\n  ${cmd} ${args.join(" ")}`);
  const res = spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT, ...opts });
  if (res.status !== 0) die(`${title} failed (exit ${res.status})`);
}

function capture(cmd, args) {
  const res = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf-8" });
  return res.status === 0 ? res.stdout.trim() : null;
}

/** Current platform as a PLATFORMS key, or null on macOS. */
function hostPlatform() {
  if (process.platform === "linux") return "linux";
  if (process.platform === "win32") return "win";
  return null;
}

// ── mode: --build ──────────────────────────────────────────────────────────

function doBuild() {
  const plat = hostPlatform();
  if (!plat) {
    die(
      "--build must run ON the target platform (linux or win32).\n" +
        "   macOS shells are built by `npm run release:electron`; NSIS and fpm\n" +
        "   do not cross-compile reliably from darwin.",
    );
  }

  // The runtime bundle is fetched from the REGISTRY, so the published npm
  // version must already exist and must match this tree. Same rule the macOS
  // flow enforces — a shell that bundles a different runtime than its version
  // claims is the worst kind of release bug, because nothing looks wrong.
  const served = capture("npm", ["view", "@nagellabs/libi", "version"]);
  if (served !== version) {
    die(
      `package.json is ${version} but the registry serves ${served ?? "nothing"}.\n` +
        "   Publish the npm package first — the shell bundles the PUBLISHED runtime.",
    );
  }

  // Clear release/ for exactly the reason the macOS script does: artifacts are
  // verified BY NAME, so a leftover from an earlier build satisfies every
  // check and ships in place of a build that actually produced nothing.
  const releaseDir = path.join(ROOT, "release");
  if (existsSync(releaseDir)) {
    rmSync(releaseDir, { recursive: true, force: true });
    console.log("\n▶ cleared release/ — artifacts are verified by name");
  }

  run("compile the shell", "npm", ["run", "compile:electron"]);
  run("release build (.next + manifest + dist-cli)", "node", [
    "scripts/next-build-release.js",
  ]);
  run("runtime bundle from the registry", "node", [
    "scripts/build-runtime-bundle.js",
    "--from-registry",
  ]);
  // `--publish never` for the same reason as the macOS flow: with a GH_TOKEN
  // in the env electron-builder would upload mid-build, before verification.
  run("package", "npx", [
    "electron-builder",
    PLATFORMS[plat].builderFlag,
    "--publish",
    "never",
  ]);

  verifyArtifacts(plat, releaseDir);
  console.log(
    `\n✅ ${plat} artifacts built and verified in release/.\n` +
      "   Copy them to the machine holding the gh credential, then:\n" +
      `   node scripts/release-electron-platform.js --attach ${plat} <dir>\n`,
  );
}

// ── shared verification ────────────────────────────────────────────────────

function verifyArtifacts(plat, dir) {
  const spec = PLATFORMS[plat];
  const wanted = [...spec.installers(version), ...spec.feed];
  const missing = wanted.filter((f) => !existsSync(path.join(dir, f)));

  if (missing.length > 0) {
    const present = existsSync(dir) ? readdirSync(dir) : [];
    const feedMissing = missing.filter((m) => spec.feed.includes(m));
    die(
      `expected ${plat} artifacts are missing from ${dir}:\n` +
        missing.map((f) => `   - ${f}`).join("\n") +
        `\n\n   present: ${present.length ? present.join(", ") : "(nothing)"}` +
        (feedMissing.length
          ? "\n\n   NOTE: the missing file(s) include this platform's UPDATE FEED." +
            "\n   Publishing without it leaves every user on this platform with a" +
            "\n   shell whose update check fails silently, forever."
          : ""),
    );
  }

  console.log(`\n✔ ${plat} artifact set complete:`);
  for (const f of wanted) console.log(`   - ${f}`);
  return wanted.map((f) => path.join(dir, f));
}

// ── mode: --attach ─────────────────────────────────────────────────────────

function doAttach(plat, dir) {
  if (!PLATFORMS[plat]) {
    die(`unknown platform "${plat}" — expected one of: ${Object.keys(PLATFORMS).join(", ")}`);
  }
  const abs = path.resolve(dir);
  if (!existsSync(abs)) die(`artifact directory does not exist: ${abs}`);

  if (spawnSync("gh", ["auth", "status"], { cwd: ROOT }).status !== 0) {
    die("gh is not authenticated — `gh auth login` first (this is why --build and --attach are separate).");
  }

  const assets = verifyArtifacts(plat, abs);

  const tag = `v${version}`;
  if (spawnSync("gh", ["release", "view", tag], { cwd: ROOT }).status !== 0) {
    die(
      `GitHub release ${tag} does not exist yet.\n` +
        "   The macOS flow (`npm run release:electron`) creates the release and\n" +
        "   pins its tag to the built commit. Run that first, then attach the\n" +
        "   other platforms to it.",
    );
  }

  run(`upload ${plat} assets to ${tag}`, "gh", [
    "release",
    "upload",
    tag,
    ...assets,
    "--clobber",
  ]);

  console.log(
    `\n✅ ${plat} artifacts are on https://github.com/Nagellabs/libi/releases/tag/${tag}\n` +
      `   Installed ${plat} shells will now resolve ${PLATFORMS[plat].feed.join(", ")}.\n`,
  );
}

// ── entry ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
if (argv[0] === "--build") {
  doBuild();
} else if (argv[0] === "--attach") {
  const [, plat, dir] = argv;
  if (!plat || !dir) {
    die("usage: --attach <linux|win> <artifact-dir>");
  }
  doAttach(plat, dir);
} else {
  die(
    "usage:\n" +
      "   node scripts/release-electron-platform.js --build            (on the target platform)\n" +
      "   node scripts/release-electron-platform.js --attach <linux|win> <dir>   (where gh is authed)",
  );
}
