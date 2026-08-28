/**
 * `--skip-checks` needs a CI meaning, and it must not be "trust me".
 *
 * The local record answers "did the gates run on THIS machine for THIS commit?"
 * — a question a runner can never answer yes to. The gates run in their own
 * job, on their own machine, against the commit BEFORE the version bump the
 * build jobs check out. Accepting `--ci` as sufficient would restore exactly
 * the unverified claim gate-provenance.js was written to kill:
 *
 *     ⚠  --skip-checks: trusting that tests/lint/licences ran on this exact commit.
 *
 * So the CI check asks the question that IS answerable: is the tested commit an
 * ancestor, and is a version bump the only thing between them?
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { gatesPassedOnAncestor, RELEASE_BUMP_FILES } from "../../../scripts/lib/gate-provenance";

const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

describe("gatesPassedOnAncestor", () => {
  it("refuses when the workflow passed no commit at all", () => {
    // An unset LIBI_GATES_SHA arrives as "" — the shape a missing `needs:` or a
    // renamed job output produces, and the one most likely to happen silently.
    const r = gatesPassedOnAncestor("");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("LIBI_GATES_SHA is empty");
  });

  it("refuses a commit this checkout does not have", () => {
    const r = gatesPassedOnAncestor("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("not a commit in this checkout");
  });

  it("accepts HEAD itself — the gates ran on exactly this tree", () => {
    const r = gatesPassedOnAncestor(head);
    expect(r.ok).toBe(true);
    expect(r.bumpOnly).toEqual([]);
  });

  it("allows only the three files a version bump touches", () => {
    // `npm version` rewrites the version in package.json and package-lock.json;
    // syncNoticesAfterBump then re-pins the lockfile sha256 recorded in
    // THIRD-PARTY-NOTICES.md. Anything else is a code change, and the gates'
    // result no longer covers it.
    expect([...RELEASE_BUMP_FILES].sort()).toEqual([
      "THIRD-PARTY-NOTICES.md",
      "package-lock.json",
      "package.json",
    ]);
  });

  it("rejects an unrelated commit rather than reaching for a merge base", () => {
    // The empty tree is a real object in every git repo and is not an ancestor
    // of anything — a cheap way to assert the ancestry check is actually run.
    // `git commit-tree` needs an author identity, and a CI runner has none —
    // this test passed on every dev machine and failed on the first CI run
    // ("empty ident name (for <runner@...>)"). Supplied here rather than
    // configured in the workflow so the test is hermetic: it must not depend
    // on the ambient git config of whoever runs it, and a contributor with no
    // global user.name is in exactly the runner's position.
    //
    // Identity ONLY. No GIT_AUTHOR_DATE / GIT_COMMITTER_DATE: this object is
    // dangling and thrown away, but the repo's rule against synthesised commit
    // dates has no carve-out worth arguing about, and the test does not need
    // one.
    const emptyTreeCommit = execFileSync(
      "git",
      ["commit-tree", "-m", "unrelated", "4b825dc642cb6eb9a060e54bf8d69288fbee4904"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "libi tests",
          GIT_AUTHOR_EMAIL: "tests@libi.invalid",
          GIT_COMMITTER_NAME: "libi tests",
          GIT_COMMITTER_EMAIL: "tests@libi.invalid",
        },
      },
    ).trim();
    const r = gatesPassedOnAncestor(emptyTreeCommit);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("not an ancestor of HEAD");
  });
});
