#!/usr/bin/env node
/**
 * `npm run registry:install [-- --version=x.y.z] [--ignore-scripts]` — install
 * the published package into a clean staging prefix, exactly as a consumer
 * would, and assert the things a consumer depends on.
 *
 * By default install scripts RUN. That is deliberate: a broken `postinstall`
 * is what made this package uninstallable before (Phase 0 spike, Blocker 1),
 * and `--ignore-scripts` would hide a regression of it. Pass `--ignore-scripts`
 * only when you are deliberately testing something else and want the ~minutes
 * of native-module builds back.
 */
const {
  startRegistry,
  installConsumer,
  assertConsumerInstall,
  assertRepoPkgUnmutated,
  viewDistTagLatest,
  parseArgs,
  paths,
  log,
} = require("./lib.js");

async function main() {
  const args = parseArgs();
  assertRepoPkgUnmutated("at start");
  await startRegistry();

  const versionArg = [...args.flags]
    .map((a) => /^--version=(.+)$/.exec(a)?.[1])
    .find(Boolean);
  const version = versionArg || viewDistTagLatest();
  log(`installing ${version} (dist-tags.latest = ${viewDistTagLatest()})`);

  installConsumer(version, { ignoreScripts: args.has("--ignore-scripts") });
  assertConsumerInstall(version);
  log(`consumer prefix: ${paths.consumerDir}`);
  assertRepoPkgUnmutated("at end");
}

main();
