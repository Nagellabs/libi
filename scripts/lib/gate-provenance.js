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

module.exports = { recordGatesPassed, gatesPassedOnHead, GATE_RECORD_PATH: FILE };
