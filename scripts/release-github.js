#!/usr/bin/env node
/**
 * Publish the GitHub Release — the ONE outward step of a release, done once,
 * after every platform has built.
 *
 *     node scripts/release-github.js --assets <dir> [--tag vX.Y.Z] [--dry-run]
 *
 * WHY THIS IS SEPARATE. `release-electron.js` used to end by creating the
 * release itself, which was correct while macOS was the only shell. It is not
 * correct with two: mac builds on a macOS runner and Windows on a Windows one,
 * so whichever finished first would create a release carrying half the
 * artifacts — and a release missing `latest.yml` leaves every Windows user
 * with an update check that fails silently, forever.
 *
 * So both build jobs run with `--no-github-release`, upload their output as
 * workflow artifacts, and this runs last against the merged directory.
 *
 * WHAT IT REFUSES TO SHIP. Both update feeds must be present. electron-updater
 * reads `latest-mac.yml` / `latest.yml` from the LATEST release; publishing
 * without one is not a partial release, it is a broken updater for that
 * platform. If a platform was deliberately not built, say so explicitly with
 * --allow-missing=mac|win rather than letting an absent file pass unnoticed.
 */
const { spawnSync } = require("node:child_process");
const { existsSync, readdirSync, statSync } = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const argv = process.argv.slice(2);

function flag(name, fallback = null) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const dryRun = argv.includes("--dry-run");
const assetsDir = path.resolve(ROOT, flag("assets") ?? "release");
const allowMissing = (flag("allow-missing") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

for (const p of allowMissing) {
  if (!["mac", "win"].includes(p)) {
    console.error(`❌ --allow-missing takes mac and/or win, got ${JSON.stringify(p)}`);
    process.exit(1);
  }
}

const version = require(path.join(ROOT, "package.json")).version;
const tag = flag("tag") ?? `v${version}`;

if (!existsSync(assetsDir) || !statSync(assetsDir).isDirectory()) {
  console.error(`❌ --assets must be a directory that exists (got ${assetsDir})`);
  process.exit(1);
}

// Flat, one level down, or both: `actions/download-artifact` without a `name`
// creates a subdirectory per artifact, and with one flattens into the target.
// Accepting both means the workflow can change its mind without breaking this.
function collect(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    // Dotfiles are never release assets. macOS drops .DS_Store into any
    // directory it has looked at, and uploading it to a release is the kind of
    // thing nobody notices until someone points at it.
    if (e.name.startsWith(".")) return [];
    const full = path.join(dir, e.name);
    return e.isDirectory() ? collect(full) : [full];
  });
}
const found = collect(assetsDir);

// The updater feeds, per platform. Each is the file that makes that platform's
// installed apps able to see this release at all.
const FEEDS = { mac: "latest-mac.yml", win: "latest.yml" };
const missingFeeds = Object.entries(FEEDS)
  .filter(([platform]) => !allowMissing.includes(platform))
  .filter(([, file]) => !found.some((f) => path.basename(f) === file));

if (missingFeeds.length > 0) {
  console.error(
    "❌ update-feed artifacts are missing from the asset set:\n" +
      missingFeeds.map(([p, f]) => `   - ${f} (${p})`).join("\n") +
      "\n\n   Every installed app reads this file from the LATEST release to\n" +
      "   discover updates. Publishing without it breaks that platform's\n" +
      "   updater permanently — not just for this version.\n\n" +
      "   If a platform was deliberately not built, say so:\n" +
      `     node scripts/release-github.js --assets=${assetsDir} --allow-missing=${missingFeeds.map(([p]) => p).join(",")}`,
  );
  process.exit(1);
}

// A build that produced nothing leaves an empty directory, and `gh release
// create` with no assets happily makes an empty release.
if (found.length === 0) {
  console.error(`❌ no files under ${assetsDir} — there is nothing to publish.`);
  process.exit(1);
}

console.log(`\n📦 publishing ${tag} with ${found.length} asset(s):`);
for (const f of found) {
  console.log(`   ${(statSync(f).size / 1024 / 1024).toFixed(1).padStart(7)} MB  ${path.basename(f)}`);
}
if (allowMissing.length > 0) {
  console.log(`\n⚠  deliberately shipping WITHOUT: ${allowMissing.join(", ")}`);
}

if (dryRun) {
  console.log("\n✅ dry run — nothing was published.");
  process.exit(0);
}

function run(title, cmd, args) {
  console.log(`\n▶ ${title}\n  $ ${cmd} ${args.join(" ")}`);
  const res = spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT });
  if (res.status !== 0) {
    console.error(`\n❌ step failed: ${title} (exit ${res.status})`);
    process.exit(res.status ?? 1);
  }
}

// Pin the tag to the exact commit this release was built from. Without
// `--target`, `gh release create` puts a nonexistent tag on the remote's
// default-branch head — whatever that happens to be by then.
const headSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf-8" })
  .stdout.trim();

const exists = spawnSync("gh", ["release", "view", tag], { cwd: ROOT }).status === 0;
if (exists) {
  // A re-run after a failed upload replaces the assets rather than failing.
  run(`upload assets to existing release ${tag}`, "gh", [
    "release", "upload", tag, ...found, "--clobber",
  ]);
} else {
  run(`create GitHub release ${tag}`, "gh", [
    "release", "create", tag, ...found,
    "--title", `Libi ${version}`,
    "--generate-notes",
    "--target", headSha,
  ]);
}

console.log(
  `\n✅ Libi ${version} is released: https://github.com/Nagellabs/libi/releases/tag/${tag}\n` +
    "   Installed desktop apps will offer this update within ~6h.",
);
