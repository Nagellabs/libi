// Which commit the release gates last passed on.
//
// `release:electron --skip-checks` exists so a same-day shell release doesn't
// re-run the suite `release:npm` just ran. Its banner said
//
//     ⚠  --skip-checks: trusting that tests/lint/licences ran on this exact commit.
//
// and nothing anywhere verified that. It was a claim, not a check — true on
// 2026-08-14 only because the one file that had changed since the gates ran was
// hand-checked for test coverage. Get that wrong and a shell ships around a
// runtime nobody tested, with a reassuring line in the log saying otherwise.
//
// So the gates now record the commit they passed on, and `--skip-checks`
// refuses when that isn't HEAD. Machine-local and gitignored: it is evidence
// about THIS working copy, meaningless anywhere else.
const { spawnSync } = require("node:child_process");
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const FILE = path.join(ROOT, ".libi-release-gates.json");

function headSha() {
  const res = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf-8" });
  return res.status === 0 ? res.stdout.trim() : null;
}

/** Record that the named gates passed on the current HEAD. */
function recordGatesPassed(gates) {
  const sha = headSha();
  if (!sha) return;
  writeFileSync(
    FILE,
    JSON.stringify({ sha, gates, at: new Date().toISOString() }, null, 2) + "\n",
  );
}

/**
 * `{ ok: true, record }` when the gates are known to have passed on HEAD.
 * `{ ok: false, reason }` otherwise — no record, unreadable, or a different
 * commit. The caller decides whether that is fatal.
 */
function gatesPassedOnHead() {
  const sha = headSha();
  if (!sha) return { ok: false, reason: "could not resolve HEAD" };
  if (!existsSync(FILE)) {
    return {
      ok: false,
      reason:
        "no record that the gates have run on this machine — nothing wrote\n" +
        `   ${FILE}. Run \`npm run release:npm\` first, or drop --skip-checks.`,
    };
  }
  let record;
  try {
    record = JSON.parse(readFileSync(FILE, "utf-8"));
  } catch {
    return { ok: false, reason: `${FILE} is unreadable — drop --skip-checks` };
  }
  if (record.sha !== sha) {
    return {
      ok: false,
      reason:
        `the gates last passed on ${String(record.sha).slice(0, 8)}, but HEAD is ${sha.slice(0, 8)}.\n` +
        "   Something changed since. Re-run without --skip-checks.",
    };
  }
  return { ok: true, record };
}

/**
 * The CI equivalent of `gatesPassedOnHead`.
 *
 * On a runner the local record cannot exist: the gates run in their own job on
 * their own machine, and the build jobs check out a DIFFERENT commit — the
 * version bump `release:npm` creates after the gates have already passed. So
 * "same sha" is the wrong question there, and simply trusting `--ci` would put
 * back exactly the unverified claim this module was written to kill.
 *
 * The right question is whether anything that could change behaviour happened
 * between the tested commit and this one. A release bump touches the version in
 * package.json and package-lock.json, and the lockfile marker inside
 * THIRD-PARTY-NOTICES.md. Nothing else. If the diff is a subset of those three
 * files and the tested commit is an ancestor, the gates' result still holds —
 * and that is checkable, not assertable.
 */
const RELEASE_BUMP_FILES = new Set([
  "package.json",
  "package-lock.json",
  "THIRD-PARTY-NOTICES.md",
]);

function gatesPassedOnAncestor(gatesSha) {
  const sha = headSha();
  if (!sha) return { ok: false, reason: "could not resolve HEAD" };
  if (!gatesSha) {
    return {
      ok: false,
      reason:
        "LIBI_GATES_SHA is empty — the workflow did not pass the commit its\n" +
        "   gates job tested. Without it there is no evidence the suite ran.",
    };
  }
  const known =
    spawnSync("git", ["cat-file", "-e", `${gatesSha}^{commit}`], { cwd: ROOT }).status === 0;
  if (!known) {
    return { ok: false, reason: `${gatesSha.slice(0, 8)} is not a commit in this checkout` };
  }
  const ancestor =
    spawnSync("git", ["merge-base", "--is-ancestor", gatesSha, sha], { cwd: ROOT }).status === 0;
  if (!ancestor) {
    return {
      ok: false,
      reason:
        `the gates ran on ${gatesSha.slice(0, 8)}, which is not an ancestor of HEAD\n` +
        `   (${sha.slice(0, 8)}) — they tested a different line of history.`,
    };
  }
  const diff = spawnSync("git", ["diff", "--name-only", gatesSha, sha], {
    cwd: ROOT,
    encoding: "utf-8",
  });
  if (diff.status !== 0) {
    return { ok: false, reason: `could not diff ${gatesSha.slice(0, 8)}..HEAD` };
  }
  const changed = diff.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const unexpected = changed.filter((f) => !RELEASE_BUMP_FILES.has(f));
  if (unexpected.length > 0) {
    return {
      ok: false,
      reason:
        `code changed between the tested commit and HEAD:\n` +
        unexpected.map((f) => `     ${f}`).join("\n") +
        "\n   Only a version bump may separate them. Re-run the gates.",
    };
  }
  return {
    ok: true,
    record: { sha: gatesSha, gates: ["test", "lint", "check:licenses", "notices:check"], at: "the gates job" },
    bumpOnly: changed,
  };
}

module.exports = {
  recordGatesPassed,
  gatesPassedOnHead,
  gatesPassedOnAncestor,
  RELEASE_BUMP_FILES,
  GATE_RECORD_PATH: FILE,
};
