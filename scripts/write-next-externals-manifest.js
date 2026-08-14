#!/usr/bin/env node
// Turbopack's production build emits its `serverExternalPackages` (next.config.ts)
// under HASHED request names and makes them resolvable at runtime via a
// SYMLINK FARM at `.next/node_modules/` — see the long comment in
// electron-builder.yml, which documents the exact failure this caused for
// the packaged Electron artifact (boots, binds the port, 500s on every
// route because a hashed module can't be found) before that directory was
// added to its `files` allowlist.
//
// `npm pack` / `npm publish` strip ALL symlinks from the tarball
// unconditionally — verified empirically (a `files` glob, an explicit `!`
// negation, and even a plain nested regular-file test all behave
// differently from a symlink; npm's tar step simply never writes a symlink
// entry, full stop). So the electron-builder fix does not transfer to the
// npm artifact: a consumer's installed `.next/node_modules` arrives empty
// (the parent directories have no non-symlink children either, so even
// they don't survive).
//
// Fix: record the (small — currently ~8-entry) symlink farm as a plain
// JSON manifest at build time. A manifest is ordinary file content, so it
// survives packing untouched. `lib/install/next-externals.ts#ensureNextExternalSymlinks`
// recreates the real symlinks from it at production-boot time, resolved
// FRESH against whatever `node_modules` the CONSUMER's own `npm install`
// produced — so the platform/ABI-correct package always gets linked, never
// a copy baked on the build machine (critical for native deps like
// better-sqlite3 and node-pty, which are platform/ABI-specific).
//
// The manifest records the bare PACKAGE SPECIFIER for each entry (e.g.
// "pino", "@napi-rs/canvas") derived from the symlink's `readlink` target —
// NOT the relative target path itself. A relative target like
// `../../node_modules/pino` is calibrated for `.next` sitting at a project
// root that also directly contains `node_modules` (true here, on the build
// machine) — false once this package is installed AS A DEPENDENCY, where
// `.next` lands one level deeper at `node_modules/libi/.next/` while `pino`
// gets hoisted to the CONSUMER's top-level `node_modules/`. Recording only
// the package name lets the runtime side re-derive the correct path by
// walking up from wherever `.next` actually is, at whatever depth.
//
// ── Every build path MUST call this ───────────────────────────────────────
// A `.next` shipped WITHOUT the manifest produces a server that binds its
// port and 500s every route, so the writer cannot be optional or
// best-effort. It is therefore exposed as a function and invoked from
// BOTH build entry points:
//
//   * `npm run build`                   → chained in package.json's `build`
//   * `scripts/next-build-release.js`   → calls `writeExternalsManifest()`
//                                          directly after `next build`
//
// An npm `postbuild` hook does NOT cover this: `build:electron` (the
// documented publish/package path) invokes `node scripts/next-build-release.js`
// directly rather than `npm run build`, and npm only fires pre/post hooks
// for scripts it runs BY NAME. Hence the explicit call, plus this note so
// nobody "simplifies" it back into a hook that silently doesn't fire.
//
// The manifest is STAMPED with `.next/BUILD_ID`. Turbopack's hashed external
// names change from build to build. Checked empirically (planted a stray
// file at `.next` root before a release build): `next build` DOES clear it,
// so an unstamped manifest normally can't outlive the build it describes —
// the common bad path is a MISSING manifest (a build path that forgot to
// chain this writer), not a stale one. The `buildId` stamp is still kept as
// defense-in-depth for what the deletion doesn't cover — an
// interrupted/partial build, a hand-copied or restored `.next`, or a future
// Next version that stops clearing — and the runtime side refuses any
// manifest whose `buildId` doesn't match.
const fs = require("node:fs");
const path = require("node:path");

/** `../../node_modules/pino` -> `pino`; `../../../node_modules/@napi-rs/canvas`
 *  -> `@napi-rs/canvas`. Splits on the LAST `node_modules/` segment so this
 *  holds even for an unusually deep target. */
function packageSpecifierFromTarget(target) {
  const marker = "node_modules" + path.sep;
  const idx = target.lastIndexOf(marker);
  if (idx === -1) return null;
  return target.slice(idx + marker.length).split(path.sep).join("/");
}

function walk(dir, nodeModulesDir, links) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      const target = fs.readlinkSync(full);
      const pkg = packageSpecifierFromTarget(target);
      if (pkg === null) {
        console.warn(
          `[write-next-externals-manifest] could not derive a package specifier from symlink ${full} -> ${target} — skipping`,
        );
        continue;
      }
      links.push({ link: path.relative(nodeModulesDir, full), package: pkg });
    } else if (entry.isDirectory()) {
      walk(full, nodeModulesDir, links);
    }
  }
}

/**
 * Write `<root>/.next/externals-manifest.json`. Throws when `.next` has no
 * `BUILD_ID` — i.e. this was called without a completed production build,
 * which must fail the build rather than emit an unverifiable manifest.
 *
 * Returns `{ manifestPath, buildId, count }`.
 */
function writeExternalsManifest(root = path.resolve(__dirname, "..")) {
  const nextDir = path.join(root, ".next");
  const nodeModulesDir = path.join(nextDir, "node_modules");
  const manifestPath = path.join(nextDir, "externals-manifest.json");

  let buildId;
  try {
    buildId = fs.readFileSync(path.join(nextDir, "BUILD_ID"), "utf-8").trim();
  } catch {
    buildId = "";
  }
  if (!buildId) {
    throw new Error(
      `[write-next-externals-manifest] ${path.join(nextDir, "BUILD_ID")} is missing or empty — ` +
        "refusing to write an externals manifest that cannot be verified against a build. " +
        "Run a production `next build` first.",
    );
  }

  const links = [];
  if (fs.existsSync(nodeModulesDir)) {
    walk(nodeModulesDir, nodeModulesDir, links);
  }
  // Deterministic order so the file doesn't churn between builds.
  links.sort((a, b) => (a.link < b.link ? -1 : a.link > b.link ? 1 : 0));

  // `next.config.ts#serverExternalPackages` is non-empty and a healthy build
  // has produced 8 entries here throughout this project's history — zero
  // links means `.next/node_modules` was absent/empty at write time, which
  // is either an upstream Turbopack behavior change or this script running
  // against a build that didn't actually externalise anything. Either way
  // it's silent data loss if unremarked: the manifest still writes
  // successfully (an empty manifest is not itself invalid — a build that
  // genuinely externalises nothing would produce one), but nobody should
  // find out via a 500 in production. Warn loudly rather than staying quiet.
  if (links.length === 0) {
    console.warn(
      "[write-next-externals-manifest] WARNING: recorded 0 externals symlinks " +
        `(expected the externals-manifest.json for serverExternalPackages to be non-empty). ` +
        `Checked: ${nodeModulesDir}. If this is unexpected, the build likely did not produce ` +
        "the usual Turbopack externals symlink farm — investigate before shipping.",
    );
  }

  fs.writeFileSync(manifestPath, JSON.stringify({ buildId, links }, null, 2) + "\n");
  return { manifestPath, buildId, count: links.length };
}

module.exports = { writeExternalsManifest };

if (require.main === module) {
  const root = path.resolve(__dirname, "..");
  const { manifestPath, buildId, count } = writeExternalsManifest(root);
  console.log(
    `[write-next-externals-manifest] recorded ${count} symlink(s) for build ${buildId} -> ${path.relative(root, manifestPath)}`,
  );
}
