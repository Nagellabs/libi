/**
 * Post-pack guard: fail the build if proprietary Anthropic code reached the
 * packaged artifact.
 *
 * WHY A SCAN AND NOT JUST THE GLOBS:
 *
 * libi ships GPL-3.0 and holds no licence to redistribute
 * `@anthropic-ai/claude-agent-sdk` ("© Anthropic PBC. All rights reserved.")
 * or its ~212MB platform binary. Two gates are supposed to keep them out, and
 * BOTH have blind spots:
 *
 *   - `scripts/check-licenses.sh` scans `--production` only. The packaged app
 *     ships `node_modules/**\/*` — devDependencies included — so anything the
 *     licence gate cannot see can still be packed.
 *   - `electron-builder.yml`'s `!node_modules/@anthropic-ai/**` is a
 *     TOP-LEVEL glob. It does not match a NESTED copy at
 *     `node_modules/<x>/node_modules/@anthropic-ai/**`, which npm creates
 *     whenever hoisting is blocked by a version conflict.
 *
 * So a future devDependency that nests an Anthropic package would evade both
 * gates and land back in the .dmg, silently. Task 5's original verification
 * was a one-off manual `find`. This makes it a build failure instead.
 *
 * SCOPE: structural checks (directory names) run over the whole packed tree;
 * the copyright-string check reads the metadata files a licence actually lives
 * in (package.json / LICENSE / NOTICE / README / *.md) rather than every byte
 * of a multi-GB tree, keeping the guard fast enough to run on every build.
 */

const fs = require("node:fs");
const path = require("node:path");

/** Directory names that must never appear anywhere in the packed tree. */
const FORBIDDEN_DIR_NAMES = new Set([
  // The proprietary SDK scope: the sdk itself plus its per-platform binaries.
  "@anthropic-ai",
  // The sole path that pulls the scope in. Excluded from the artifact and
  // installed at runtime instead (lib/agents/runtime-install.ts).
  "claude-agent-acp",
]);

/** The copyright line carried by every proprietary Anthropic package. */
const FORBIDDEN_STRING = "Anthropic PBC";

/** Metadata files a licence/copyright notice realistically lives in. */
function isLicenseBearingFile(name) {
  const lower = name.toLowerCase();
  if (lower === "package.json") return true;
  if (lower.startsWith("license") || lower.startsWith("licence")) return true;
  if (lower.startsWith("notice") || lower.startsWith("copying")) return true;
  if (lower.startsWith("readme")) return true;
  return lower.endsWith(".md");
}

/** Cap on a metadata file we're willing to read — real ones are tiny. */
const MAX_METADATA_BYTES = 2 * 1024 * 1024;

/**
 * Walk `root` and report every violation found.
 *
 * Pure w.r.t. the process (no throwing on a missing tree — the caller decides
 * whether absence is fatal), so it is unit-testable against a seeded temp dir.
 *
 * @param {string} root directory to scan (the packaged `node_modules`)
 * @returns {{ path: string, reason: string }[]}
 */
function scanForProprietaryCode(root) {
  const violations = [];
  if (!fs.existsSync(root)) return violations;

  /** @type {string[]} */
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir — nothing we can assert about it
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      // Symlinks are not followed: npm/pnpm layouts are full of them and a
      // cycle would hang the build. The real directory is visited on its own.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (FORBIDDEN_DIR_NAMES.has(entry.name)) {
          violations.push({
            path: full,
            reason: `proprietary/unlicensed package directory "${entry.name}" is packed into the artifact`,
          });
          // Don't descend — one report per offending tree is enough to act on.
          continue;
        }
        stack.push(full);
        continue;
      }
      if (!entry.isFile() || !isLicenseBearingFile(entry.name)) continue;
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.size > MAX_METADATA_BYTES) continue;
      let contents;
      try {
        contents = fs.readFileSync(full, "utf-8");
      } catch {
        continue;
      }
      if (contents.includes(FORBIDDEN_STRING)) {
        violations.push({
          path: full,
          reason: `contains "${FORBIDDEN_STRING}" — proprietary code cannot ship in a GPL-3.0 artifact`,
        });
      }
    }
  }
  return violations;
}

/** Human-readable, actionable failure block naming every offending path. */
function formatViolations(violations) {
  return [
    "",
    "✗ Packaged-artifact licence guard FAILED",
    "",
    "  libi ships GPL-3.0 and cannot redistribute proprietary Anthropic code.",
    "  The following made it into the packed app:",
    "",
    ...violations.map((v) => `    ${v.path}\n      → ${v.reason}`),
    "",
    "  Fix by keeping @agentclientprotocol/claude-agent-acp a devDependency and",
    "  excluding the offending path in electron-builder.yml's `files` list.",
    "  It is installed at runtime instead — see lib/agents/runtime-install.ts.",
    "",
  ].join("\n");
}

module.exports = {
  scanForProprietaryCode,
  formatViolations,
  FORBIDDEN_DIR_NAMES,
  FORBIDDEN_STRING,
};
