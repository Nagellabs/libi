#!/usr/bin/env node
/**
 * `npm run registry:start` — bring up the throwaway Verdaccio.
 *
 * Idempotent: a second run against a live registry is a no-op. `--fresh` wipes
 * the stored packages first (use it when re-publishing a version you already
 * published, which npm otherwise rejects with EPUBLISHCONFLICT).
 */
const { startRegistry, assertRepoPkgUnmutated, parseArgs, registryUrl, paths, log } =
  require("./lib.js");

async function main() {
  const args = parseArgs();
  assertRepoPkgUnmutated("at start");
  await startRegistry({ fresh: args.has("--fresh") });
  assertRepoPkgUnmutated("at end");
  log(`registry:   ${registryUrl()}`);
  log(`scratch:    ${paths.scratch}`);
  log(`stop with:  npm run registry:stop`);
}

main();
