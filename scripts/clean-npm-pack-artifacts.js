#!/usr/bin/env node
// Runs as `prepack` — fires before both `npm pack` and `npm publish` (but
// NOT before a plain checkout `npm install`) — so every packed tarball is
// deterministic regardless of what build artifacts happen to be sitting on
// disk in the working tree.
//
// Why this exists: npm ALWAYS force-includes whatever `package.json#main`
// points to in a packed tarball — even when it's outside the `files`
// allowlist, and even when an explicit `!` negation targets it. Verified
// empirically (see .superpowers/sdd/task-5-report.md): a `files` array
// containing `"!dist-electron/**"` does NOT stop the `main`-field
// force-include; npm treats the `main` (and `bin`) targets the same tier
// as package.json/README/LICENSE — always shipped, allowlist or not.
//
// `main` is pinned to `dist-electron/electron/main.js` because the
// PACKAGED ELECTRON APP needs it: electron-builder ships this same root
// `package.json` verbatim, and Electron resolves its own boot script via
// `main` when the app launches. That field cannot be removed or repointed
// without breaking the Electron artifact.
//
// `dist-electron/` is gitignored build output (`npm run compile:electron`)
// — absent in a clean checkout, but present after running
// `npm run build:electron` / `compile:electron` locally, which is an
// entirely normal thing to have done before publishing. Left alone, an
// `npm publish` run from such a tree would silently ship ~1MB of Electron
// main-process code inside the npm CLI tarball — the wrong artifact,
// irrelevant to `npx libi`, and (per the check above) not excludable any
// other way.
//
// This ABORTS rather than deleting. The first cut ran an unconditional
// `rm -rf dist-electron/`, which would yank the directory out from under a
// running `npm run electron` (that command's whole process tree — main
// process, preload, lazily-required chunks — is loaded from exactly this
// path). A pack is not worth breaking a running app for, and the fix is one
// command the operator can run when nothing is using it. `dist-electron/`
// is fully regenerable via `npm run compile:electron`, so removing it by
// hand loses nothing either.
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const target = path.join(root, "dist-electron");

if (fs.existsSync(target)) {
  console.error(
    "\n❌ [clean-npm-pack-artifacts] dist-electron/ is present — refusing to pack.\n" +
      "\n" +
      "   npm ALWAYS force-includes whatever package.json#main points to\n" +
      "   (dist-electron/electron/main.js), even against the `files` allowlist and an\n" +
      "   explicit `!` negation — so packing now would ship the Electron main-process\n" +
      "   build inside the npm CLI tarball.\n" +
      "\n" +
      "   This is not deleted automatically: a running `npm run electron` loads its\n" +
      "   whole process tree from that directory, and removing it mid-run breaks the\n" +
      "   app. Stop anything using it, then:\n" +
      "\n" +
      "     rm -rf dist-electron\n" +
      "\n" +
      "   (Regenerate any time with `npm run compile:electron`.)\n",
  );
  process.exit(1);
}

console.log("[clean-npm-pack-artifacts] dist-electron/ absent — safe to pack");
