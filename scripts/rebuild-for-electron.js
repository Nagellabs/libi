#!/usr/bin/env node
/**
 * Force-rebuild native modules against the installed Electron version's
 * Node ABI before `electron-builder` packages the app.
 *
 * ## Why this exists
 *
 * `better-sqlite3` (the SQLite driver libi uses) is a Node native module:
 * it ships as a compiled `.node` shared library that's stamped with the
 * `NODE_MODULE_VERSION` of the Node it was built against. dlopen() refuses
 * to load a `.node` whose stamp doesn't match the runtime's ABI.
 *
 * libi needs better-sqlite3 in TWO different Node runtimes:
 *   - Electron's bundled Node (Node 22.19 patched by Electron 36 →
 *     MODULE_VERSION 135). Used by the packaged production app.
 *   - The user's system Node (currently Node 23 → MODULE_VERSION 131).
 *     Used by `npm run dev`, `npm test`, `npm run dev:electron` (the
 *     Next.js dev server runs as a child process under system Node).
 *
 * Only ONE `.node` file lives on disk at a time —
 * `node_modules/better-sqlite3/build/Release/better_sqlite3.node`. Whatever
 * ABI it has is the ABI that gets shipped or loaded.
 *
 * The state of that file ping-pongs based on which command ran last:
 *   - `npm install` → postinstall runs `electron-builder install-app-deps`
 *     → ABI flipped to Electron (135)
 *   - `npm run dev` / `pretest` → the `ensure-native-modules.js` hook
 *     detects an ABI mismatch in current Node and runs
 *     `npm rebuild better-sqlite3` → ABI flipped to system Node (131)
 *
 * So at the moment `electron-builder` packages the app, the `.node` file
 * could be either ABI depending on what the developer ran most recently.
 * `electron-builder` does run `@electron/rebuild` internally as a defence,
 * but with `buildFromSource=false` it can skip the rebuild when it
 * believes the existing binding is "valid" (some prebuilds heuristic).
 * The result: a `.app` shipped with a system-Node `.node` that crashes
 * with `NODE_MODULE_VERSION 131 vs 135` (or a silent SIGKILL on macOS)
 * the first time it tries to open the DB.
 *
 * ## What this script does
 *
 * Before `electron-builder` packages the app, force a clean rebuild
 * against the actually-installed Electron version:
 *
 *   - Reads the version from `node_modules/electron/package.json` (NOT the
 *     `^36.x.y` range in `package.json`, so semver drift can't surprise us)
 *   - Calls `@electron/rebuild --force` so any "looks valid, skip rebuild"
 *     fast-path is bypassed
 *   - Targets only `better-sqlite3` (other native modules use NAPI and
 *     don't need re-stamping per Node version)
 *
 * Pairs with `scripts/ensure-native-modules.js`:
 *
 *   dev/test commands  → predev hook flips ABI to system Node    → dev works
 *   prod build command → this script flips ABI to Electron       → .app works
 *
 * Both gates are explicit, deterministic, and idempotent. The `.node` file
 * on disk is whatever the last script needed; the next script flips it
 * back if necessary.
 *
 * ## Long-term cure
 *
 * The honest architectural fix is to swap to `better-sqlite3-with-prebuilds`
 * (a fork that ships prebuilt binaries for BOTH Electron and Node ABIs in
 * one package, with `prebuild-install` picking the right one at require
 * time). That eliminates this script, the `ensure-native-modules.js` hook,
 * and the `electron-builder install-app-deps` postinstall entirely. See
 * docs-local/superpowers/plans/futures/2026-05-25-electron-shipping-and-update-strategy.md
 * for the follow-up.
 */

const { execSync } = require("node:child_process");

const electronVersion = require("electron/package.json").version;

process.stderr.write(
  `[rebuild-for-electron] forcing better-sqlite3 ABI to Electron ${electronVersion}\n`,
);

execSync(
  `npx @electron/rebuild --force --version ${electronVersion} --module-dir node_modules/better-sqlite3 --types prod,dev`,
  { stdio: "inherit" },
);

process.stderr.write("[rebuild-for-electron] rebuild complete\n");
