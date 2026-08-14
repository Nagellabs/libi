#!/usr/bin/env node
/**
 * Ensure better-sqlite3 is compiled for the **current** Node ABI.
 *
 * The `postinstall` script (`electron-builder install-app-deps`)
 * rebuilds it for Electron's bundled Node every `npm install`. That
 * makes `npm run build:electron` work but breaks dev / test scripts
 * which run under the system Node (different MODULE_VERSION).
 *
 * Detection: spawn a child Node process that just `require`s the
 * module. If the child exits with non-zero status or a fatal signal
 * (macOS SIGKILLs binaries with an incompatible ABI rather than letting
 * them throw), we rebuild via `npm rebuild better-sqlite3`. Idempotent
 * — when the module already loads cleanly, exits in ~80 ms.
 *
 * Wired into `predev`, `predev:electron`, `pretest`, etc. so devs don't
 * have to remember to rebuild after each `npm install`.
 */

const { execSync, spawnSync } = require("node:child_process");

function moduleLoadsCleanly() {
  // Probe by actually opening a DB — just `require`ing the module is
  // insufficient on macOS, where an ABI-mismatched .node can sometimes
  // be loaded but crashes (SIGKILL) when its native code runs.
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      "const S = require('better-sqlite3'); const db = new S(':memory:'); db.prepare('SELECT 1').get(); db.close();",
    ],
    { stdio: "pipe", encoding: "utf8" },
  );
  return result.status === 0 && result.signal === null;
}

if (!moduleLoadsCleanly()) {
  process.stderr.write(
    "[ensure-native] better-sqlite3 ABI mismatch — rebuilding for Node " +
      process.versions.node +
      " (modules " +
      process.versions.modules +
      ")…\n",
  );
  execSync("npm rebuild better-sqlite3", { stdio: "inherit" });
  process.stderr.write("[ensure-native] rebuild complete\n");
}
