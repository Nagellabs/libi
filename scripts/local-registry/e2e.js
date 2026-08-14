#!/usr/bin/env node
/**
 * `npm run registry:e2e` — Step 1 of the harness, end to end:
 *
 *   fresh registry → pack (prepack: clean + build-cli) → publish staged copy
 *   → consumer install into a clean prefix → assert → tear down
 *
 * Leaves nothing behind: no running server, no scratch dir, no npm config.
 * `--keep` skips the final teardown when you want to poke at the install.
 * `--ignore-scripts` skips the consumer's native-module builds (faster, but
 * stops proving that a consumer install actually completes).
 */
const {
  startRegistry,
  stagePackage,
  publishStaged,
  installConsumer,
  assertConsumerInstall,
  assertRepoPkgUnmutated,
  viewDistTagLatest,
  viewVersions,
  teardown,
  readRepoPkg,
  parseArgs,
  registryUrl,
  paths,
  step,
  log,
} = require("./lib.js");

async function main() {
  const args = parseArgs();
  const started = Date.now();
  assertRepoPkgUnmutated("at start");

  await startRegistry({ fresh: true });
  const version = readRepoPkg().version;

  const stage = stagePackage();
  publishStaged(stage, version);

  installConsumer(version, { ignoreScripts: args.has("--ignore-scripts") });
  assertConsumerInstall(version);

  step("registry queries");
  log(`dist-tags.latest = ${viewDistTagLatest()}`);
  log(`versions         = ${JSON.stringify(viewVersions())}`);

  assertRepoPkgUnmutated("before teardown");
  await teardown({ keep: args.has("--keep") });
  assertRepoPkgUnmutated("after teardown");

  const secs = ((Date.now() - started) / 1000).toFixed(0);
  step(`PASS — published + installed ${version} via ${registryUrl()} in ${secs}s`);
  if (args.has("--keep")) log(`kept: ${paths.scratch}`);
}

main();
