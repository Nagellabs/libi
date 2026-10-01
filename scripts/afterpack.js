/**
 * electron-builder `afterPack` hook (electron-builder.yml → `afterPack`). Runs
 * after the app tree is copied into the platform bundle and BEFORE it becomes a
 * .dmg/.zip/.nsis/.AppImage. Two steps, in this order:
 *
 *   1. scripts/afterpack-windows-externals.js — a Windows payload drops the
 *      dereferenced copies of the externals farm (first boot rebuilds it).
 *   2. scripts/afterpack-license-guard.js — no proprietary Anthropic code in
 *      what is left. Throwing fails the build.
 *
 * Each is required as a module object and called through it, so a test can
 * observe the order.
 */

const windowsExternals = require("./afterpack-windows-externals");
const licenseGuard = require("./afterpack-license-guard");

module.exports = async function afterPack(context) {
  windowsExternals.stripWindowsExternalsFarm(context);
  await licenseGuard.afterPackLicenseGuard(context);
};
