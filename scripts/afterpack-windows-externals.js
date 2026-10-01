/**
 * electron-builder `afterPack` step (via scripts/afterpack.js): the Windows
 * payload ships NO Next.js externals farm (EL-4, Windows verification F5).
 *
 * `scripts/build-runtime-bundle.js` materialises `.next/node_modules` — the
 * farm Turbopack resolves `serverExternalPackages` through — at build time and
 * asserts it resolves; on the Windows runner as junctions. electron-builder
 * then copies those junctions into `win-unpacked` as DEREFERENCED real
 * directories (9 packages, 883 files on 0.1.16: better-sqlite3, esbuild,
 * import-in-the-middle, next-logger, node-pty, pino, playwright-core,
 * @napi-rs/canvas, @opentelemetry/instrumentation), NSIS installs them, and the
 * first boot (`ensureNextExternalSymlinks`) `rmSync`s every one to put a
 * junction in its place. The installer carried — and Defender scanned — a tree
 * whose only fate was deletion.
 *
 * So a win32 pack drops the farm here, after the copy and before NSIS packs the
 * tree. It lives in the RUNTIME ROOT, not the bundle's top:
 * `resources/libi-bundle/node_modules/@nagellabs/libi/.next/node_modules`,
 * resolved through `runtimeRootFor` — the same function the bundle build uses,
 * so the two cannot drift. (The first version looked at
 * `libi-bundle/.next/node_modules`, which never exists, reported "nothing to
 * strip" and shipped the copies anyway — review C1.) First boot builds the farm
 * from `.next/externals-manifest.json`, which stays; `lib/install/next-externals.ts`
 * already handles an absent farm (that is what a registry install looks like).
 *
 * A win32 pack with no farm there FAILS the build: the bundle build always
 * materialises one, so its absence means this path has drifted again.
 *
 * WINDOWS ONLY. The dmg keeps its RELATIVE symlinks inside the signed .app,
 * where boot only verifies them and must never write. The platform comes from
 * electron-builder's `context.electronPlatformName`, never `process.platform`.
 */

const fs = require("node:fs");
const path = require("node:path");
const { runtimeRootFor } = require("./build-runtime-bundle");

/** The runtime's externals farm inside a Windows/Linux unpacked app (`extraResources` → `resources/libi-bundle`). */
function bundleExternalsFarmDir(context) {
  return path.join(runtimeRootFor(path.join(context.appOutDir, "resources", "libi-bundle")), ".next", "node_modules");
}

function stripWindowsExternalsFarm(context) {
  if (context.electronPlatformName !== "win32") {
    return { stripped: false, reason: `platform ${context.electronPlatformName}: the farm ships` };
  }
  const dir = bundleExternalsFarmDir(context);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    throw new Error(
      `[afterpack] no externals farm in the Windows payload at ${path.relative(context.appOutDir, dir)}. ` +
        "The runtime bundle always materialises one there, so this path no longer matches the bundle " +
        "layout — fix bundleExternalsFarmDir() in scripts/afterpack-windows-externals.js rather than " +
        "ship the dereferenced copies first boot deletes.",
    );
  }
  // `rmSync` removes a link it meets, never what it points at — a farm entry
  // that survived the copy as a junction goes without touching its target.
  fs.rmSync(dir, { recursive: true, force: true });
  process.stdout.write(
    `[afterpack] stripped the externals farm from the Windows payload: ${entries.length} entr${entries.length === 1 ? "y" : "ies"} ` +
      `under ${path.relative(context.appOutDir, dir)} (first boot builds it from .next/externals-manifest.json)\n`,
  );
  return { stripped: true, entries: entries.length, dir };
}

module.exports = { stripWindowsExternalsFarm, bundleExternalsFarmDir };
