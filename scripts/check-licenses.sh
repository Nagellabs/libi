#!/usr/bin/env bash
#
# Dependency-license gate.
#
# libi ships under GPL-3.0-only. Copyleft means the licenses of everything we
# DISTRIBUTE now matter: a dependency under a source-available or proprietary
# license (SSPL, BUSL, Elastic-2.0, FSL, Commons-Clause, CC-BY-NC, or plain
# "all rights reserved") cannot be combined into a GPL work.
#
# This script fails on any production dependency whose license is not on the
# GPL-compatible allowlist below. Run it locally with `npm run check:licenses`;
# CI runs it on every push (.github/workflows/license-check.yml).
#
# Matching is EXACT on the declared license string — see the `check()` note
# below for why `license-checker --onlyAllow` alone is not enough.
#
# ── Known exceptions ────────────────────────────────────────────────────────
# One package (plus its per-platform binaries) is excluded by exact version. It
# is believed acceptable because it sits behind a process boundary rather than
# being linked into libi, but IT SHOULD BE RE-REVIEWED ON UPGRADE — that is
# precisely why it is pinned by version here rather than by name.
#
#   @sentry/cli + all eight @sentry/cli-<platform> binaries  — FSL-1.1-MIT
#     (source-available, with a competing-use restriction; converts to MIT two
#     years after each release). Pulled in transitively:
#       @nagellabs/libi → @sentry/nextjs → @sentry/bundler-plugin-core
#                       → @sentry/cli → @sentry/cli-<platform>
#     It is a standalone Rust binary invoked at BUILD time to upload source
#     maps. libi never links, imports, requires or executes it at runtime.
#
#     WHY IT CANNOT SIMPLY MOVE TO devDependencies (checked 2026-07-29, plan
#     Task 17). @sentry/cli is a hard `dependencies` entry of
#     @sentry/bundler-plugin-core, which is a hard `dependencies` entry of
#     @sentry/nextjs. So it leaves the production tree only if @sentry/nextjs
#     does — and @sentry/nextjs is a genuine RUNTIME dependency of the npm
#     package: `next.config.ts` ships in package.json#files and statically
#     imports `withSentryConfig`, and the CLI boots Next programmatically
#     (`next({ dev:false, dir })` in lib/cli/studio.ts), which re-evaluates
#     that config file at server start. Verified against a real consumer
#     install from the loopback Verdaccio harness (`npm run registry:e2e`):
#     hiding node_modules/@sentry/nextjs makes Next's own config loader fail
#     with "Cannot find module '@sentry/nextjs'" — i.e. the server cannot
#     boot. (The .next bundle itself does NOT require @sentry/* at runtime;
#     next.config.ts is the sole binding constraint.)
#
#     CONSEQUENCE, STATED PLAINLY: `npx @nagellabs/libi` DOES install
#     @sentry/cli (~150 KB) and @sentry/cli-darwin (~35 MB of FSL-licensed
#     Mach-O) onto the user's machine — confirmed by inspecting the consumer
#     node_modules produced by registry:e2e, not inferred from the manifest.
#     This is judged acceptable because it is npm's ordinary transitive
#     resolution from the user's own npm client under the user's own terms
#     with Sentry (the same reasoning that resolved the Anthropic item in
#     docs-local/pre-launch-plan.md §6a), because it is a build tool that no libi
#     code path invokes, and because electron-builder.yml already keeps it
#     out of the packaged Electron artifact — the one thing libi genuinely
#     redistributes.
#
#     WHAT WOULD MAKE THIS NOT ACCEPTABLE — re-open the decision if any of
#     these becomes true:
#       - libi ever executes sentry-cli at runtime, or ships it inside the
#         Electron artifact (check electron-builder.yml still excludes it);
#       - @sentry/cli relicenses to something without the MIT future grant,
#         or the competing-use clause is broadened;
#       - the version pinned above changes (that is what forces this re-read).
#     Considered and rejected: making next.config.ts's Sentry wrap a guarded
#     dynamic import so @sentry/nextjs could become a devDependency. It would
#     work mechanically, but it makes the build-time and runtime Next config
#     diverge, and the payoff — dropping a build tool the user obtains from
#     npm themselves — does not justify destabilising production error
#     reporting. Revisit if @sentry/cli's license worsens.
#
#   libi itself (package.json name `@nagellabs/libi`) reports UNLICENSED only
#     because its package.json sets `private: true` — the license field is
#     correctly "GPL-3.0-only".
#
# ── Anthropic packages are NOT excluded here (deliberately) ────────────────
# @anthropic-ai/claude-agent-sdk (+ its ~212MB platform binary) is proprietary
# — "© Anthropic PBC. All rights reserved." — and used to appear in this list
# as a known-risk waiver, because the packaged Electron build genuinely
# redistributed it. That is no longer true:
#
#   - `@agentclientprotocol/claude-agent-acp` (the sole path to the Anthropic
#     SDK) lives in `devDependencies`, not `dependencies` — so `--production`
#     scans here never see it or its transitive Anthropic packages at all.
#   - The packaged Electron artifact additionally excludes
#     `node_modules/@anthropic-ai/**` and the adapter itself via
#     `electron-builder.yml`'s `files` allowlist, as defense in depth.
#   - The adapter (and therefore the Anthropic SDK) is installed at RUNTIME,
#     on first use, straight from npm — see `lib/agents/runtime-install.ts`.
#     The user obtains it from Anthropic's own distribution channel, under
#     their own license with Anthropic; libi ships none of it.
#
# Because none of that reaches this script's `--production` scan, no
# exclusion is needed. If a regular `dependencies` entry on
# `@agentclientprotocol/claude-agent-acp` (or a direct entry on the SDK
# itself) ever reappears — e.g. via a careless package.json merge — this gate
# is exactly the thing that MUST catch it and fail. Do not re-add either
# package to EXCLUDE to make that failure go away; fix the dependency
# placement instead. See `docs-local/superpowers/plans/2026-07-27-unbundle-claude-cli.md`
# for the full history, and `docs-local/pre-launch-plan.md` §6/§6a for the resolved
# tracking item.
# ────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# GPL-3.0-compatible licenses. Deliberately does NOT include: SSPL, BUSL,
# Elastic-2.0, FSL, Commons-Clause, CC-BY-NC, or GPL-2.0-only.
#
# NOTE: this is a plain newline-separated string, joined with ';' below — it is
# NOT shell code, so it must not contain comments or blank lines.
# The trailing "Apache 2.0" (with a space) is a non-SPDX spelling declared by
# qrcode-terminal; license-checker matches the raw string, so both forms are
# needed. Same license as Apache-2.0.
ALLOW='MIT
ISC
Apache-2.0
BSD-2-Clause
BSD-3-Clause
0BSD
BlueOak-1.0.0
Unlicense
CC0-1.0
CC-BY-3.0
CC-BY-4.0
MPL-2.0
LGPL-3.0-or-later
GPL-3.0-only
GPL-3.0-or-later
Python-2.0
Artistic-2.0
(MIT OR CC0-1.0)
Apache 2.0
(MIT OR WTFPL)
(BSD-2-Clause OR MIT OR Apache-2.0)
MIT AND ISC'

# All eight @sentry/cli-<platform> packages are listed, not just the developer's
# own. They are optionalDependencies of @sentry/cli gated by os/cpu, so npm
# installs exactly ONE — a different one on every platform. This gate runs on
# macOS locally and on ubuntu-latest in CI (.github/workflows/license-check.yml),
# where the installed package is @sentry/cli-linux-x64. Listing only the local
# one passes here and fails there. Each was confirmed FSL-1.1-MIT at 2.58.6
# (`npm view @sentry/cli-<platform>@2.58.6 license`), same as the base package.
EXCLUDE='@sentry/cli@2.58.6;@sentry/cli-darwin@2.58.6;@sentry/cli-linux-x64@2.58.6;@sentry/cli-linux-arm64@2.58.6;@sentry/cli-linux-arm@2.58.6;@sentry/cli-linux-i686@2.58.6;@sentry/cli-win32-x64@2.58.6;@sentry/cli-win32-arm64@2.58.6;@sentry/cli-win32-i686@2.58.6;@nagellabs/libi@0.1.0'

# ── Why this does the matching itself instead of `license-checker --onlyAllow`
# `--onlyAllow` is a SUBSTRING test, not an equality test. license-checker
# 25.0.1 (lib/index.js) accepts a package when
#   restricted[item].licenses.indexOf(allowedLicense) !== -1
# so any declared license that merely CONTAINS an allowed token slips through:
# "FSL-1.1-MIT" contains "MIT", "AGPL-3.0-only" contains "GPL-3.0-only", and a
# hypothetical "MIT WITH Commons-Clause" contains "MIT".
#
# That was not theoretical here. Negative-testing this gate on 2026-07-29 (plan
# Task 17 Step 3) showed it exited 0 with the @sentry/cli waiver REMOVED — it
# printed "FSL-1.1-MIT: 2" in the summary and still declared success. The
# waiver above was inert, and every FSL/Commons-Clause-style license whose
# string happens to embed an allowed SPDX id would have shipped unnoticed.
#
# So: ask license-checker only for the FACTS (--json, with --excludePackages
# applied), and do the allowlist comparison here, by exact string equality.
EXACT_MATCH_JS='
const fs = require("node:fs");
const allow = new Set(
  process.env.ALLOW_LIST.split("\n").map((s) => s.trim()).filter(Boolean),
);
const json = JSON.parse(fs.readFileSync(process.env.LICENSE_JSON, "utf8"));
const counts = new Map();
const bad = [];
for (const [pkg, meta] of Object.entries(json)) {
  const raw = meta.licenses;
  const lic = Array.isArray(raw)
    ? raw.join(" , ")
    : String(raw === undefined || raw === null ? "UNKNOWN" : raw);
  counts.set(lic, (counts.get(lic) || 0) + 1);
  if (!allow.has(lic)) bad.push(pkg + "  ->  " + lic);
}
const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
for (const [lic, n] of rows) {
  console.log(
    "   " + String(n).padStart(4) + "  " + lic +
      (allow.has(lic) ? "" : "   <== NOT ON THE ALLOWLIST"),
  );
}
if (bad.length > 0) {
  console.error("");
  console.error("   FAILED: " + bad.length + " production package(s) declare a license that is");
  console.error("   not on the GPL-3.0 allowlist (exact match):");
  for (const b of bad) console.error("     " + b);
  console.error("");
  console.error("   Fix the dependency placement. Only add an exact name@version to");
  console.error("   EXCLUDE with a written justification in this scripts header.");
  process.exit(1);
}
console.log("   OK: all production licenses are on the GPL-3.0 allowlist (exact match)");
'

check() {
  local dir="$1" label="$2"
  echo "── $label ──"
  if [ ! -d "$dir/node_modules" ]; then
    echo "   ⚠️  skipped: $dir/node_modules not installed"
    return 0
  fi
  local json
  json="$(mktemp)"
  ( cd "$dir" && npx --yes license-checker@25.0.1 \
      --production \
      --excludePackages "$EXCLUDE" \
      --json ) > "$json"
  if ALLOW_LIST="$ALLOW" LICENSE_JSON="$json" node -e "$EXACT_MATCH_JS"; then
    rm -f "$json"
  else
    rm -f "$json"
    return 1
  fi
}

echo "Checking production dependency licenses against the GPL-3.0 allowlist…"
echo
check "." "root (app + CLI)"
echo
echo "Done. Matching is exact: an UNKNOWN, a Custom URL, or any unrecognised"
echo "spelling fails outright rather than being quietly tolerated — that is"
echo "where Commons-Clause, BUSL and FSL hide."
