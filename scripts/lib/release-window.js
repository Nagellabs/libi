// scripts/lib/release-window.js
//
// Optional, machine-local release window. If `scripts/release-window.local.json`
// exists it names the weekdays on which the release scripts may perform their
// outward step (npm publish / GitHub Release). The file is gitignored on
// purpose: when a maintainer restricts their own release days, that schedule
// is personal to their machine, not part of the project — a clone without the
// file has no restriction at all.
//
//   { "allowedDays": ["saturday", "sunday"] }
//
// The LOCAL system date decides. A present-but-malformed file fails CLOSED:
// the only machine that has the file is one that wants a window, and a typo
// silently disabling it is the failure mode that matters. There is no
// override flag — to change the window, change the file.
const { readFileSync } = require("node:fs");
const path = require("node:path");

const CONFIG_PATH = path.resolve(__dirname, "..", "release-window.local.json");
const DAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

/** Exit(1) when a configured window exists and today is outside it. */
function assertReleaseWindow(what) {
  let raw;
  try {
    raw = readFileSync(CONFIG_PATH, "utf-8");
  } catch {
    // No file, no window. The line below is deliberate: on a machine that IS
    // supposed to have one, a lost config must not pass silently.
    console.log(
      "ℹ no local release window configured (scripts/release-window.local.json) — proceeding.",
    );
    return;
  }

  let allowed;
  try {
    const cfg = JSON.parse(raw);
    allowed = (Array.isArray(cfg.allowedDays) ? cfg.allowedDays : []).map((d) =>
      String(d).toLowerCase(),
    );
    if (allowed.length === 0 || allowed.some((d) => !DAYS.includes(d))) {
      throw new Error("allowedDays must be a non-empty array of weekday names");
    }
  } catch (err) {
    console.error(
      `❌ scripts/release-window.local.json exists but is malformed (${(err instanceof Error && err.message) || "invalid JSON"}).\n` +
        '   Expected shape: { "allowedDays": ["saturday", "sunday"] }\n' +
        "   Refusing to release rather than silently ignoring the window.",
    );
    process.exit(1);
  }

  const today = DAYS[new Date().getDay()];
  if (allowed.includes(today)) return;
  console.error(
    `❌ Today is ${today} — this machine's release window allows: ${allowed.join(", ")}.\n` +
      `   ${what} is the outward step; building, testing and committing are fine any day.\n` +
      "   Re-run on an allowed day (or adjust scripts/release-window.local.json).",
  );
  process.exit(1);
}

module.exports = { assertReleaseWindow };
