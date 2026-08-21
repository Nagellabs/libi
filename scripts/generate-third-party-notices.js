#!/usr/bin/env node
/**
 * Generates THIRD-PARTY-NOTICES.md — the attribution file for every
 * PRODUCTION dependency libi's packaged Electron build redistributes.
 *
 * libi is GPL-3.0-only. The packaged app bundles its production
 * `node_modules` tree wholesale (see electron-builder.yml), so every
 * permissively-licensed dependency's license text / copyright notice must
 * be reproduced somewhere in the distribution — that's the one condition
 * MIT / ISC / BSD-2 / BSD-3 / Apache-2.0 etc. all share. This script is how
 * that condition gets satisfied, mechanically and repeatably, instead of by
 * hand.
 *
 * ── Tool choice ──────────────────────────────────────────────────────────
 * Built on `license-checker@25.0.1` (npx, unpinned to a local devDependency)
 * rather than a hand-rolled license-text scraper or a different generator
 * (e.g. `oss-attribution-generator`), for one concrete reason: it's already
 * the tool `scripts/check-licenses.sh` uses to gate CI on license
 * compatibility, at the same pinned version. Reusing it means zero new
 * dependencies, one less license-parsing implementation to trust, and the
 * compliance gate and the attribution file can never quietly disagree about
 * what a given package's license even IS. license-checker's `--customPath`
 * option additionally does the actual hard part for us — reading the
 * resolved LICENSE file off disk per package and (best-effort) extracting a
 * copyright line — which is exactly the "prefer a maintained tool over
 * hand-rolling" ask.
 *
 * ── Why NOT `license-checker --production` ──────────────────────────────
 * `license-checker --production` (and `npm ls --omit=dev`, which most
 * likely backs it) both resolve against the *installed* tree, where a
 * devDependency that also happens to satisfy another package's *optional
 * peer* dependency shows up nested under that package and gets counted as
 * "production." Concretely: `@playwright/test` is a root devDependency,
 * but `next` declares it as an optional peer — so with it installed
 * (because it's a devDependency), both `license-checker --production` and
 * `npm ls --omit=dev` report `@playwright/test` *and* `playwright` as
 * production packages. A real `npm ci --omit=dev` would never install
 * either, because the only edge that pulls them in is the root
 * devDependency; the peer is optional. That is a real, verified
 * discrepancy (confirmed empirically while building this script), not a
 * hypothetical — see `computeProductionPackageSet` below for how it's
 * avoided.
 *
 * ── Methodology ──────────────────────────────────────────────────────────
 * 1. Compute the authoritative production set directly from
 *    package-lock.json's lockfileVersion-3 `packages` map, which carries a
 *    `dev` / `devOptional` boolean per resolved package — the same
 *    information `npm ci --omit=dev` itself uses. Filtering on
 *    `!dev && !devOptional` reproduces that install exactly (confirmed:
 *    vitest, playwright, @playwright/test, typescript, eslint all
 *    correctly drop out; tsx — a genuine runtime dependency, see
 *    mcp/tracking-mcp spawn logic in CLAUDE.md — correctly stays in).
 * 2. Run license-checker over the FULL installed tree (dev included; we
 *    already did our own dev/prod split in step 1) to get license id +
 *    text + copyright per package, reading real files off disk.
 * 3. Intersect (1) and (2). A production-set entry with no match in (2)
 *    means it's an optional, platform-specific package (e.g.
 *    `@next/swc-linux-x64-gnu`, `@esbuild/win32-x64`) that npm did not
 *    install for the current machine's platform — correctly absent, since
 *    a build on this machine will not bundle it either.
 *
 * Only this project's dependency tree is covered. The marketing site is a
 * separate Next.js app in its own repo (Nagellabs/libi-site) and ships
 * nothing into the packaged Electron app, so it does not belong in a
 * notices file about what that app redistributes.
 *
 * ── Usage ────────────────────────────────────────────────────────────────
 *   node scripts/generate-third-party-notices.js            # regenerate
 *   node scripts/generate-third-party-notices.js --check    # staleness only, no network, no write
 *
 * npm scripts: `npm run notices:generate` / `npm run notices:check`.
 * `npm run notices:check` also runs as `prebuild:electron` (npm's implicit
 * pre-script hook) so a stale notices file fails the release build loudly
 * instead of silently shipping an outdated one. See the comment above
 * `CHECK_MODE` handling for why regeneration itself is NOT automatic there.
 */

const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const LOCKFILE_PATH = path.join(ROOT, "package-lock.json");
const PACKAGE_JSON_PATH = path.join(ROOT, "package.json");
const OUTPUT_PATH = path.join(ROOT, "THIRD-PARTY-NOTICES.md");

// Pinned to match scripts/check-licenses.sh exactly — see the comment there
// on why this floats via npx rather than a committed devDependency.
const LICENSE_CHECKER_VERSION = "25.0.1";

const CHECK_MODE = process.argv.includes("--check");

// ── Known license-identifier corrections ───────────────────────────────────
// license-checker derives its `licenses` guess from package.json's own
// "license" field, falling back to scanning the README/homepage when that
// field is a "SEE LICENSE IN <file>" pointer (as
// @anthropic-ai/claude-agent-sdk's is). For this package that fallback scan
// lands on a shields.io badge URL in the README and reports the nonsense
// identifier "Custom: https://img.shields.io/badge/...".
//
// NOTE — this override is currently a no-op in practice, and that is
// intentional. `@anthropic-ai/claude-agent-sdk` (and its platform binary)
// reach `node_modules` only via `@agentclientprotocol/claude-agent-acp`,
// which lives in `devDependencies` (see `lib/agents/runtime-install.ts`) —
// so `computeProductionPackageSet` above never puts either package into
// `prodSet`, `buildEntries` never emits an entry for it, and this label is
// never applied. libi does not redistribute it; it is installed at runtime
// straight from npm. The override is kept as a defensive safety net: if
// that package placement ever regresses back to a regular `dependencies`
// entry (the exact regression `scripts/check-licenses.sh` is written to
// catch), the mis-scraped "Custom: https://img.shields.io/..." label would
// otherwise silently misrepresent this as some ordinary open license instead
// of the "All rights reserved" grant it actually is. This corrects the
// mis-scraped *label* only, if it is ever triggered again; the extracted
// license TEXT is never altered, and the package is never dropped or hidden.
const LICENSE_LABEL_OVERRIDES = [
  {
    test: (name) =>
      name === "@anthropic-ai/claude-agent-sdk" ||
      name.startsWith("@anthropic-ai/claude-agent-sdk-"),
    label:
      "Proprietary — All Rights Reserved (not redistributed by libi; installed at runtime by lib/agents/runtime-install.ts — see scripts/check-licenses.sh)",
  },
];

// ── Vendored assets (not npm packages) ─────────────────────────────────────
// Fonts committed under public/fonts/ ship inside the npm tarball (package.json
// `files` includes `public/**/*`) and therefore inside the packaged desktop app.
// license-checker never sees them: it walks node_modules, and these are neither
// dependencies nor installed. They are enumerated by hand here so the notices
// file covers everything libi actually redistributes, not just its npm tree.
//
// Every one is SIL Open Font License 1.1. OFL §2 permits bundling and
// redistribution with software provided each copy carries the copyright notice
// and the license, which is satisfied by the `licenseFile` shipped next to each
// font. OFL §5 additionally requires the Font Software stay under OFL and not be
// redistributed under any other license — so these files are NOT covered by
// libi's own GPL-3.0-only grant, and this section is where that is stated.
// None of them declares a Reserved Font Name.
const VENDORED_FONTS = [
  { family: "Inter", files: ["Inter-Regular.ttf", "Inter-SemiBold.ttf", "Inter-Bold.ttf", "Inter-ExtraBold.ttf"], dir: "public/fonts/2d", licenseFile: "public/fonts/2d/Inter-LICENSE.txt", url: "https://github.com/rsms/inter" },
  { family: "JetBrains Mono", files: ["JetBrainsMono-Regular.ttf", "JetBrainsMono-Bold.ttf"], dir: "public/fonts/2d", licenseFile: "public/fonts/2d/JetBrainsMono-OFL.txt", url: "https://github.com/JetBrains/JetBrainsMono" },
  { family: "Geist", files: ["Geist-Regular.ttf"], dir: "public/fonts/3d", licenseFile: "public/fonts/3d/geist-OFL.txt", url: "https://github.com/vercel/geist-font" },
  { family: "Archivo Black", files: ["ArchivoBlack-Regular.ttf"], dir: "public/fonts/3d", licenseFile: "public/fonts/3d/archivoblack-OFL.txt", url: "https://github.com/Omnibus-Type/Archivo" },
  { family: "Bungee", files: ["Bungee-Regular.ttf"], dir: "public/fonts/3d", licenseFile: "public/fonts/3d/bungee-OFL.txt", url: "https://github.com/djrrb/bungee" },
  { family: "Anton", files: ["Anton-Regular.ttf"], dir: "public/fonts/3d", licenseFile: "public/fonts/3d/anton-OFL.txt", url: "https://github.com/googlefonts/AntonFont" },
];

/** First non-empty line of a font's license file — its copyright statement. */
function fontCopyright(licenseFile) {
  const abs = path.join(ROOT, licenseFile);
  if (!fs.existsSync(abs)) return null;
  for (const line of fs.readFileSync(abs, "utf8").split(/\r?\n/)) {
    if (line.trim()) return line.trim();
  }
  return null;
}

/**
 * Hash of the vendored-asset set: every font file's bytes plus its license
 * file's bytes. This joins the lockfile hash in the staleness marker so that
 * ADDING A FONT WITHOUT REGENERATING FAILS `notices:check` — the whole point of
 * having the gate. Hashing only package-lock.json would leave vendored assets
 * silently un-gated, which is the hole this closes.
 */
function computeVendoredHash() {
  const h = crypto.createHash("sha256");
  for (const f of VENDORED_FONTS) {
    h.update(f.family);
    for (const file of [...f.files.map((n) => path.join(f.dir, n)), f.licenseFile]) {
      const abs = path.join(ROOT, file);
      h.update(file);
      h.update(fs.existsSync(abs) ? sha256File(abs) : "MISSING");
    }
  }
  return h.digest("hex");
}

/**
 * Every vendored font file referenced above must exist, and so must its license
 * file. A font shipped without its license would breach OFL §2, so this is a
 * hard failure rather than a warning.
 */
function assertVendoredFontsIntact() {
  const missing = [];
  for (const f of VENDORED_FONTS) {
    for (const file of [...f.files.map((n) => path.join(f.dir, n)), f.licenseFile]) {
      if (!fs.existsSync(path.join(ROOT, file))) missing.push(file);
    }
  }
  if (missing.length > 0) {
    console.error(
      "[notices] vendored font files or their licenses are missing:\n" +
        missing.map((m) => `  - ${m}`).join("\n") +
        "\n  A bundled font MUST ship its license (SIL OFL 1.1 \u00a72).",
    );
    process.exit(1);
  }
}

function isSentryCli(name) {
  return name === "@sentry/cli" || name.startsWith("@sentry/cli-");
}

function isNotable(name) {
  return isSentryCli(name) || LICENSE_LABEL_OVERRIDES.some((o) => o.test(name));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

/**
 * The authoritative production (name@version) set — see the big comment at
 * the top of the file for why this reads package-lock.json directly instead
 * of trusting `license-checker --production` / `npm ls --omit=dev`.
 */
function computeProductionPackageSet(lockfilePath) {
  const lock = readJson(lockfilePath);
  if (!lock.lockfileVersion || lock.lockfileVersion < 3) {
    throw new Error(
      `Expected package-lock.json lockfileVersion >= 3 (npm 7+ "packages" map with dev/devOptional flags); got ${lock.lockfileVersion}. ` +
        "Regenerate the lockfile with a modern npm before running this script.",
    );
  }
  const prod = new Set();
  for (const [key, entry] of Object.entries(lock.packages || {})) {
    if (key === "") continue; // the root package (libi) itself
    const idx = key.lastIndexOf("node_modules/");
    if (idx === -1) continue;
    const name = key.slice(idx + "node_modules/".length);
    if (!entry.version) continue;
    if (entry.dev || entry.devOptional) continue;
    prod.add(`${name}@${entry.version}`);
  }
  return prod;
}

/**
 * Shells out to license-checker over the FULL installed tree (dev included
 * — production filtering already happened in computeProductionPackageSet)
 * with a custom output format that pulls the actual on-disk license text
 * and a best-effort copyright line per package.
 */
function runLicenseChecker() {
  const formatPath = path.join(os.tmpdir(), `libi-notices-format-${process.pid}.json`);
  const format = {
    name: "",
    version: "",
    licenses: "",
    repository: "",
    licenseFile: "none",
    licenseText: "none",
    copyright: "",
  };
  fs.writeFileSync(formatPath, JSON.stringify(format));

  try {
    const result = spawnSync(
      "npx",
      ["--yes", `license-checker@${LICENSE_CHECKER_VERSION}`, "--json", "--customPath", formatPath],
      {
        cwd: ROOT,
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 128,
        shell: process.platform === "win32",
      },
    );
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(`license-checker exited with code ${result.status}.\n${result.stderr || ""}`);
    }
    return JSON.parse(result.stdout);
  } finally {
    fs.rmSync(formatPath, { force: true });
  }
}

function normalizeLicense(licenses) {
  if (Array.isArray(licenses)) return licenses.join(" OR ");
  return licenses || "UNKNOWN";
}

/**
 * Intersects the production set with license-checker's full scan, applies
 * label overrides, and picks the best available attribution body per
 * package: full license text > detected copyright line > an explicit
 * "not found" admission. Never silently drops a package that IS in the
 * production set and IS physically present on disk.
 */
function buildEntries(prodSet, lcData) {
  const entries = [];
  for (const key of prodSet) {
    const data = lcData[key];
    // Not physically installed on this machine — an optional,
    // platform-specific package (e.g. @next/swc-linux-x64-gnu on a darwin
    // build machine) that npm correctly did not fetch for this platform.
    // A build produced here will not bundle it either, so it's correctly
    // absent rather than a gap.
    if (!data) continue;

    const atIdx = key.lastIndexOf("@");
    const name = key.slice(0, atIdx);
    const version = key.slice(atIdx + 1);

    let license = normalizeLicense(data.licenses);
    const override = LICENSE_LABEL_OVERRIDES.find((o) => o.test(name));
    if (override) license = override.label;

    const text = data.licenseText && data.licenseText !== "none" ? data.licenseText.trim() : "";
    const copyright = (data.copyright || "").trim();

    let bodyKind = "none";
    let body = "";
    if (text) {
      bodyKind = "text";
      body = text;
    } else if (copyright) {
      bodyKind = "copyright";
      body = copyright;
    }

    entries.push({
      name,
      version,
      license,
      repository: (data.repository || "").trim(),
      bodyKind,
      body,
      notable: isNotable(name),
    });
  }

  // Deterministic order: never rely on license-checker's or the lockfile's
  // own key ordering.
  entries.sort((a, b) => {
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    return a.version.localeCompare(b.version, undefined, { numeric: true });
  });
  return entries;
}

/** Picks a backtick fence longer than any backtick run inside `text`. */
function fenceFor(text) {
  let longest = 0;
  const re = /`+/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    longest = Math.max(longest, m[0].length);
  }
  return "`".repeat(Math.max(3, longest + 1));
}

function codeBlock(text) {
  const fence = fenceFor(text);
  return `${fence}\n${text}\n${fence}`;
}

function renderMarkdown(entries, meta) {
  const lines = [];

  lines.push("<!--");
  lines.push("  THIS FILE IS GENERATED by scripts/generate-third-party-notices.js — do not hand-edit.");
  lines.push("  Regenerate: npm run notices:generate");
  lines.push("  Staleness check (no network, no write): npm run notices:check");
  lines.push(`  source-lockfile-sha256: ${meta.lockfileHash}`);
  lines.push(`  vendored-assets-sha256: ${meta.vendoredHash}`);
  lines.push("-->");
  lines.push("");
  lines.push("# Third-Party Notices");
  lines.push("");
  lines.push(
    "libi is distributed under the GPL-3.0-only license (see `LICENSE` at the repository root). " +
      "The packaged Electron application bundles its production `node_modules` dependency tree, " +
      "and this file reproduces the license and copyright notice of every package in that tree, " +
      "as required by their respective licenses.",
  );
  lines.push("");
  lines.push(
    "Generated from `package-lock.json`'s production set (i.e. what `npm ci --omit=dev` would " +
      "install) intersected with the packages actually present in `node_modules` on the machine " +
      "that generated this file. This is why the exact list can vary slightly by build platform — " +
      "optional, platform-specific binaries (`@next/swc-*`, `@esbuild/*`, `@rollup/rollup-*`, " +
      "prebuilt native addons, etc.) only appear for the platform that built them; npm never " +
      "installs the others, so a build produced on this machine never bundles them either.",
  );
  lines.push("");
  lines.push(`**Package count:** ${entries.length}`);
  lines.push("");

  const notable = entries.filter((e) => e.notable);
  if (notable.length > 0) {
    lines.push("## Notable licenses");
    lines.push("");
    lines.push(
      "These packages are deliberately excluded from the GPL-compatibility gate in " +
        "`scripts/check-licenses.sh` and ship in the packaged app despite carrying non-GPL-compatible " +
        "terms (see that script for the reasoning behind each exclusion). They are called out here, " +
        "not buried in the alphabetical list below, and their full license text is reproduced in " +
        "their entry like every other package:",
    );
    lines.push("");
    for (const e of notable) {
      lines.push(`- **${e.name}@${e.version}** — ${e.license}`);
    }
    lines.push("");
  }

  const missing = entries.filter((e) => e.bodyKind === "none");
  if (missing.length > 0) {
    lines.push("## Packages with no discoverable license text");
    lines.push("");
    lines.push(
      "license-checker could not find a license file or a copyright statement for these packages " +
        "on disk. Their declared license identifier is shown; nothing has been guessed or fabricated. " +
        "Verify these by hand if precise reproduction matters for your use of this distribution:",
    );
    lines.push("");
    for (const e of missing) {
      lines.push(`- **${e.name}@${e.version}** — declared license: ${e.license}`);
    }
    lines.push("");
  }

  lines.push("## Bundled fonts");
  lines.push("");
  lines.push(
    "These font files are committed under `public/fonts/` and ship inside the npm tarball " +
      "(and therefore inside the packaged desktop app). They are not npm packages, so " +
      "license-checker never sees them — they are enumerated by hand so this file covers " +
      "everything libi redistributes, not only its dependency tree.",
  );
  lines.push("");
  lines.push(
    "**All of them are licensed under the SIL Open Font License, Version 1.1, and remain so.** " +
      "OFL \u00a75 requires that the Font Software be distributed entirely under the OFL and not " +
      "under any other license, so these files are **not** covered by libi's own GPL-3.0-only " +
      "grant. None of them declares a Reserved Font Name. The full license text accompanies each " +
      "font in the file named below, as OFL \u00a72 requires.",
  );
  lines.push("");
  for (const f of VENDORED_FONTS) {
    const copyright = fontCopyright(f.licenseFile);
    lines.push(`### ${f.family}`);
    lines.push("");
    lines.push("**License:** SIL Open Font License 1.1");
    lines.push(`**Upstream:** ${f.url}`);
    lines.push(`**License file:** \`${f.licenseFile}\``);
    lines.push(`**Files:** ${f.files.map((n) => `\`${f.dir}/${n}\``).join(", ")}`);
    lines.push("");
    if (copyright) lines.push(codeBlock(copyright));
    lines.push("");
  }

  lines.push("## All packages");
  lines.push("");
  for (const e of entries) {
    lines.push(`### ${e.name}@${e.version}`);
    lines.push("");
    lines.push(`**License:** ${e.license}`);
    if (e.repository) lines.push(`**Repository:** ${e.repository}`);
    lines.push("");
    if (e.bodyKind === "text") {
      lines.push(codeBlock(e.body));
    } else if (e.bodyKind === "copyright") {
      lines.push("_Full license text not found in the package; detected copyright line:_");
      lines.push("");
      lines.push(codeBlock(e.body));
    } else {
      lines.push(
        `> **No license text or copyright statement could be found in this package.** ` +
          `Declared license identifier: **${e.license}**. Verify manually.`,
      );
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

function checkStaleness(lockfileHash, vendoredHash) {
  if (!fs.existsSync(OUTPUT_PATH)) {
    console.error(
      `[notices] ${path.relative(ROOT, OUTPUT_PATH)} does not exist.\n` +
        "  Run: npm run notices:generate",
    );
    process.exit(1);
  }
  const existing = fs.readFileSync(OUTPUT_PATH, "utf8");
  const match = existing.match(/source-lockfile-sha256:\s*([0-9a-f]{64})/);
  if (!match || match[1] !== lockfileHash) {
    console.error(
      `[notices] ${path.relative(ROOT, OUTPUT_PATH)} is stale relative to package-lock.json.\n` +
        "  Run: npm run notices:generate\n" +
        "  Then review and commit the diff before releasing.",
    );
    process.exit(1);
  }
  // Vendored assets get their own marker: a font added under public/fonts/
  // does not touch package-lock.json, so the lockfile hash alone would let it
  // ship unrecorded.
  const vendoredMatch = existing.match(/vendored-assets-sha256:\s*([0-9a-f]{64})/);
  if (!vendoredMatch || vendoredMatch[1] !== vendoredHash) {
    console.error(
      `[notices] ${path.relative(ROOT, OUTPUT_PATH)} is stale relative to the vendored assets under public/fonts/.\n` +
        "  A font was added, removed, or changed without regenerating the notices.\n" +
        "  Run: npm run notices:generate",
    );
    process.exit(1);
  }
  console.log(
    `[notices] ${path.relative(ROOT, OUTPUT_PATH)} is up to date with package-lock.json and the vendored assets.`,
  );
}

function main() {
  const lockfileHash = sha256File(LOCKFILE_PATH);
  assertVendoredFontsIntact();
  const vendoredHash = computeVendoredHash();

  if (CHECK_MODE) {
    checkStaleness(lockfileHash, vendoredHash);
    return;
  }

  // package.json is read only to confirm the lockfile belongs to this repo;
  // libi's own package is never a dependency of itself so it never needs
  // excluding from the production set computed below.
  readJson(PACKAGE_JSON_PATH);

  console.log("[notices] Computing production dependency set from package-lock.json...");
  const prodSet = computeProductionPackageSet(LOCKFILE_PATH);
  console.log(`[notices] ${prodSet.size} production (name@version) entries in package-lock.json.`);

  console.log("[notices] Running license-checker (shells out via npx; may take a moment)...");
  const lcData = runLicenseChecker();

  const entries = buildEntries(prodSet, lcData);
  console.log(`[notices] ${entries.length} of those are physically present in node_modules on this machine.`);

  const missingCount = entries.filter((e) => e.bodyKind === "none").length;
  if (missingCount > 0) {
    console.warn(
      `[notices] ${missingCount} package(s) have no discoverable license text or copyright line — listed explicitly in the output, not omitted.`,
    );
  }

  const markdown = renderMarkdown(entries, { lockfileHash, vendoredHash });
  fs.writeFileSync(OUTPUT_PATH, markdown);
  console.log(`[notices] Wrote ${path.relative(ROOT, OUTPUT_PATH)} (${entries.length} packages).`);
}

main();
