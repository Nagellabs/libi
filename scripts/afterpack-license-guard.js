/**
 * electron-builder `afterPack` hook — runs after the app tree is copied into
 * the platform bundle and BEFORE it is turned into a .dmg/.zip/.nsis/.AppImage.
 *
 * Asserts that no proprietary Anthropic code reached the artifact. See
 * scripts/packaged-artifact-guard.js for why the existing globs + licence gate
 * are not sufficient on their own.
 *
 * Throwing here fails the build, which is the point: shipping this code is a
 * licence violation, not a warning.
 */

const fs = require("node:fs");
const path = require("node:path");

const {
  scanForProprietaryCode,
  formatViolations,
} = require("./packaged-artifact-guard");

/**
 * Locate the packed app directory inside a platform bundle.
 *
 * `asar: false` (see electron-builder.yml) means the app tree is a plain
 * directory under Resources rather than an archive.
 */
function resolvePackedAppDir(context) {
  const appOutDir = context.appOutDir;
  const productFilename =
    context.packager?.appInfo?.productFilename ?? "Libi";
  const candidates = [
    // macOS
    path.join(appOutDir, `${productFilename}.app`, "Contents", "Resources", "app"),
    // Windows / Linux
    path.join(appOutDir, "resources", "app"),
  ];
  return candidates.find((dir) => fs.existsSync(dir)) ?? null;
}

/**
 * Every `node_modules` tree inside the artifact that could carry third-party
 * code.
 *
 * Two of them now, and BOTH must be scanned:
 *
 *   - `Resources/app/node_modules` — the shell's own deps. Since the shell was
 *     thinned (see electron/runtime-loader.ts) it usually has none at all: the
 *     compiled `dist-electron/electron/main.js` requires nothing but `electron`
 *     and node builtins.
 *   - `Resources/libi-bundle/node_modules` — the RUNTIME snapshot, an
 *     `npm install --omit=dev` of the published package. This is where ~775
 *     dependencies actually live, so it is where a proprietary package would
 *     land, and scanning only the old path would have turned this guard green
 *     while checking essentially nothing.
 */
function resolveScanRoots(context, appDir) {
  const resourcesDir = path.dirname(appDir);
  const roots = [
    path.join(appDir, "node_modules"),
    path.join(resourcesDir, "libi-bundle", "node_modules"),
  ];
  return roots.filter((dir) => fs.existsSync(dir));
}

async function afterPackLicenseGuard(context) {
  const appDir = resolvePackedAppDir(context);
  if (!appDir) {
    // A guard that silently passes when it cannot find the tree is worse than
    // no guard — it would go green forever after an electron-builder layout
    // change. Fail loudly and make someone look.
    throw new Error(
      `[license-guard] could not locate the packed app directory under ${context.appOutDir}. ` +
        "Update resolvePackedAppDir() in scripts/afterpack-license-guard.js.",
    );
  }

  const scanRoots = resolveScanRoots(context, appDir);
  if (scanRoots.length === 0) {
    throw new Error(
      `[license-guard] no node_modules tree found under ${path.dirname(appDir)} ` +
        "(neither app/node_modules nor libi-bundle/node_modules) — the packed tree " +
        "looks wrong, refusing to bless it.",
    );
  }

  const started = Date.now();
  const violations = scanRoots.flatMap((root) => scanForProprietaryCode(root));
  if (violations.length > 0) {
    process.stderr.write(formatViolations(violations) + "\n");
    throw new Error(
      `[license-guard] ${violations.length} proprietary-code violation(s) in the packaged artifact — first: ${violations[0].path}`,
    );
  }
  process.stdout.write(
    `[license-guard] OK — no proprietary Anthropic code in ${scanRoots.join(", ")} (${Date.now() - started}ms)\n`,
  );
}

// electron-builder invokes the module's default export; the named exports are
// for the unit test (the build itself is 25 min, far too slow to be the only
// thing proving this hook works).
module.exports = afterPackLicenseGuard;
module.exports.afterPackLicenseGuard = afterPackLicenseGuard;
module.exports.resolvePackedAppDir = resolvePackedAppDir;
module.exports.resolveScanRoots = resolveScanRoots;
