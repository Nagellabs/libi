// scripts/lib/wait-for-server.js
"use strict";
/**
 * Activity-aware wait for the Next dev server.
 *
 * A fixed timeout can't tell "boot is slow but progressing" (Category A
 * downloading Chromium/ffmpeg on first run — 90s+ even warm) from "boot is
 * dead". Category A logs continuously to $LIBI_HOME/logs/libi.log, so the
 * file's mtime is a liveness signal: past the soft deadline we keep waiting
 * as long as the log was written within `quietMs`. A hard cap bounds the
 * worst case.
 *
 * All I/O (probe, stat, clock) is injectable for tests.
 */
const http = require("node:http");
const fs = require("node:fs");

const DEFAULT_TIMEOUT_MS = 180_000; // soft deadline (was a hardcoded 120s)
const HARD_CAP_MS = 1_200_000; // 20 min absolute ceiling
const ACTIVITY_QUIET_MS = 60_000; // log silence that means "boot is dead"
const EXTEND_NOTIFY_MS = 30_000; // throttle onExtend to at most one notice / 30s

function defaultProbe(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/", timeout: 1000 },
      (res) => {
        res.resume();
        resolve(true);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

function defaultActivityMtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

async function waitForServer({
  port,
  timeoutMs = Number(process.env.LIBI_BOOT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  hardCapMs = HARD_CAP_MS,
  activityFile = null,
  quietMs = ACTIVITY_QUIET_MS,
  probe = defaultProbe,
  activityMtime = defaultActivityMtime,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  onExtend = () => {},
}) {
  const start = now();
  let lastExtendAt = -Infinity;
  for (;;) {
    if (await probe(port)) return;
    const elapsed = now() - start;
    if (elapsed > hardCapMs) {
      throw new Error(
        `Next dev server on port ${port} did not respond within the hard cap (${Math.round(hardCapMs / 1000)}s)`,
      );
    }
    if (elapsed > timeoutMs) {
      const mtime = activityFile ? activityMtime(activityFile) : null;
      const activeRecently = mtime !== null && now() - mtime < quietMs;
      if (!activeRecently) {
        throw new Error(
          `Next dev server on port ${port} did not respond within ${Math.round(elapsed / 1000)}s ` +
            `and no boot activity in ${activityFile ?? "(no activity file)"} for ${quietMs / 1000}s. ` +
            `First boot installing deps? Re-run — installs resume where they left off. ` +
            `Override the soft deadline with LIBI_BOOT_TIMEOUT_MS.`,
        );
      }
      if (now() - lastExtendAt >= EXTEND_NOTIFY_MS) {
        lastExtendAt = now();
        onExtend();
      }
    }
    await sleep(500);
  }
}

module.exports = {
  waitForServer,
  DEFAULT_TIMEOUT_MS,
  HARD_CAP_MS,
  ACTIVITY_QUIET_MS,
};
