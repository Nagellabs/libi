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
 *   4. version bump (`npm version <type>` — commits + tags)
 *   5. node scripts/next-build-release.js — the RELEASE build: .next with
 *      Sentry reporting baked in (packaged apps install this very tarball,
 *      so a plain `npm run build` here would ship desktop users a
 *      non-reporting runtime), the externals manifest, and dist-cli
 *   6. npm run registry:e2e — full publish → install rehearsal on Verdaccio
 *   7. npm publish (npm prompts for the 2FA OTP itself)
 *   8. verify what the registry actually serves (npm view)
 */
const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { assertReleaseWindow } = require("./lib/release-window");

const ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const bump = args.find((a) => !a.startsWith("--"));

if (!["patch", "minor", "major", "none"].includes(bump ?? "")) {
  console.error(
    "usage: npm run release:npm -- <patch|minor|major|none> [--dry-run]\n" +
      "  none      publish the version already in package.json (no bump)\n" +
      "  --dry-run run everything, but `npm publish --dry-run` at the end",
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

// ── 4. version ─────────────────────────────────────────────────────────────
if (bump !== "none") {
  run(`version bump (${bump})`, "npm", ["version", bump]);
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
const served = capture("npm", ["view", "@nagellabs/libi", "version"]);
const latest = capture("npm", ["view", "@nagellabs/libi", "dist-tags.latest"]);
const shellApi = capture("npm", ["view", "@nagellabs/libi", "libi.shellApiVersion"]);
console.log(`\n  registry serves : ${served}\n  dist-tags.latest: ${latest}\n  shellApiVersion : ${shellApi}`);
if (served !== version || latest !== version) {
  console.error("❌ the registry does not serve the version just published — investigate before announcing.");
  process.exit(1);
}
console.log(
  `\n✅ @nagellabs/libi@${version} is live.\n` +
    "   Desktop installs see it via the in-app update check (within ~6h);\n" +
    "   `npx @nagellabs/libi` picks it up on next invocation.\n" +
    "   Don't forget: git push the version commit + tag.",
);
