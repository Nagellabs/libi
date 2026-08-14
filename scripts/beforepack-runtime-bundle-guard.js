/**
 * electron-builder `beforePack` hook — runs before the app tree is copied into
 * the platform bundle.
 *
 * Asserts that `build/libi-bundle/` exists and was built from THIS working
 * tree. The packaged shell no longer ships `lib/`, `app/`, `.next/` or
 * `node_modules`; the runtime snapshot in that directory is the entire product.
 * Packaging around a missing or stale one produces an app that opens a splash
 * and can never start — the worst possible failure to discover after signing.
 *
 * Throwing here fails the build, which is the point.
 *
 * ## Why a hook here, when build-cli deliberately refuses to be one
 *
 * `scripts/build-cli.js` bans npm LIFECYCLE hooks, because npm only fires
 * pre/post hooks for scripts it runs by NAME and `build:electron` invokes the
 * release script by PATH — so the hook silently never fires. That trap does not
 * apply to electron-builder's own hooks: they are declared in
 * `electron-builder.yml` and invoked directly by electron-builder on every
 * pack, including `--dir` packs and every platform target. This is a
 * belt-and-braces CHECK, not the build step itself — the build step is called
 * explicitly by path from `build:electron`, exactly as build-cli prescribes.
 */

const { assertRuntimeBundleFresh } = require("./build-runtime-bundle.js");

async function beforePackRuntimeBundleGuard() {
  const { stamp } = assertRuntimeBundleFresh();
  process.stdout.write(
    `[runtime-bundle-guard] OK — bundling ${stamp.package}@${stamp.version} ` +
      `(shellApiVersion ${stamp.shellApiVersion}, abi ${stamp.abi}, .next ${stamp.buildId})\n`,
  );
}

module.exports = beforePackRuntimeBundleGuard;
module.exports.beforePackRuntimeBundleGuard = beforePackRuntimeBundleGuard;
