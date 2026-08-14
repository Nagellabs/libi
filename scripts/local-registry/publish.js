#!/usr/bin/env node
/**
 * `npm run registry:publish [-- --version=x.y.z]` — pack the working tree and
 * publish it to the local registry.
 *
 * Starts the registry if it isn't already up. Publishes a STAGED COPY with
 * `private` stripped — the repo's `package.json` is never touched (see
 * `lib.js`, invariant 2).
 */
const {
  startRegistry,
  stagePackage,
  publishStaged,
  assertRepoPkgUnmutated,
  readRepoPkg,
  parseArgs,
  viewVersions,
  log,
  fail,
} = require("./lib.js");

async function main() {
  const args = parseArgs();
  assertRepoPkgUnmutated("at start");

  const versionArg = args.positional
    .concat([...args.flags])
    .map((a) => /^--version=(.+)$/.exec(a)?.[1])
    .find(Boolean);
  const version = versionArg || readRepoPkg().version;
  if (!/^\d+\.\d+\.\d+/.test(version)) fail(`invalid version: ${version}`);

  await startRegistry();
  const stage = stagePackage();
  publishStaged(stage, version);

  log(`published versions now on the local registry: ${viewVersions().join(", ")}`);
  assertRepoPkgUnmutated("at end");
}

main();
