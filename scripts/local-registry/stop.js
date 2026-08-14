#!/usr/bin/env node
/**
 * `npm run registry:stop` — stop Verdaccio and delete every scratch artifact.
 *
 * `--keep` stops the server but leaves the scratch dir for inspection.
 */
const { teardown, assertRepoPkgUnmutated, parseArgs, log, paths } = require("./lib.js");

async function main() {
  const args = parseArgs();
  assertRepoPkgUnmutated("at start");
  await teardown({ keep: args.has("--keep") });
  assertRepoPkgUnmutated("at end");
  log(`done. scratch root was ${paths.scratch}`);
}

main();
