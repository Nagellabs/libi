/**
 * The version bump must be followed by a notices regeneration.
 *
 * `release-npm.js` verifies `notices:check` at step 3 and then INVALIDATES it at
 * step 4: `npm version` writes the new version into package-lock.json, whose
 * sha256 is the `source-lockfile-sha256` marker recorded in
 * THIRD-PARTY-NOTICES.md. Nothing re-checks it, so the breakage surfaces in a
 * different command — `prebuild:electron` re-runs the same check, and
 * `release:electron` dies on its first step complaining the notices are stale
 * against a lockfile nobody edited.
 *
 * That cost a release-day detour on 0.1.1 and again on 0.1.2. The second one is
 * why this is a test and not a comment: the trap was already documented, and
 * documentation did not stop it happening twice.
 *
 * Asserted on source because the script is a top-to-bottom CommonJS release
 * driver with no exports and side effects on import — there is nothing to call.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const SRC = readFileSync(
  path.join(process.cwd(), "scripts/release-npm.js"),
  "utf8",
);

describe("release-npm.js keeps the notices in sync with the version bump", () => {
  it("calls the re-sync inside the bump branch", () => {
    const bumpBlock = SRC.slice(
      SRC.indexOf('if (bump !== "none") {'),
      SRC.indexOf("const version = pkg().version;"),
    );
    expect(bumpBlock).toContain('run(`version bump (${bump})`');
    expect(bumpBlock).toContain("syncNoticesAfterBump()");
  });

  it("re-syncs AFTER the bump, never before — order is the whole bug", () => {
    const block = SRC.slice(
      SRC.indexOf('if (bump !== "none") {'),
      SRC.indexOf("const version = pkg().version;"),
    );
    const bumpAt = block.indexOf('run(`version bump');
    const syncAt = block.indexOf("syncNoticesAfterBump()");
    expect(bumpAt, "the version bump call must be present").toBeGreaterThan(-1);
    expect(syncAt, "the re-sync call must be present").toBeGreaterThan(-1);
    expect(syncAt).toBeGreaterThan(bumpAt);
  });

  it("regenerates, folds into the version commit, and re-points the tag", () => {
    const fn = SRC.slice(
      SRC.indexOf("function syncNoticesAfterBump()"),
      SRC.indexOf("// ── 4. version"),
    );
    expect(fn).toContain("notices:generate");
    // One clean version commit, not a trailing fixup.
    expect(fn).toContain('"--amend"');
    // The tag npm version created points at the PRE-amend commit.
    expect(fn).toMatch(/tag",\s*\n?\s*"-f"/);
    // And it must no-op when there is nothing to fold in.
    expect(fn).toContain("git");
    expect(fn).toMatch(/status",\s*\n?\s*"--porcelain"/);
  });

  it("still runs notices:check among the gates before the bump", () => {
    // The pre-bump check is not redundant: it catches a notices file that was
    // already stale before the release started (a dependency change nobody
    // regenerated for), which the post-bump regeneration would silently paper
    // over by rewriting it.
    expect(SRC).toContain('recordGatesPassed(["test", "lint", "check:licenses", "notices:check"])');
  });
});
