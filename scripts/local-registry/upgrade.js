#!/usr/bin/env node
/**
 * `npm run registry:upgrade` — Step 2 of the harness: the multi-version
 * upgrade rehearsal, and the acceptance harness for plan Task 9.
 *
 *   publish x.y.z → consumer installs it → publish x.y.(z+1)
 *   → the installed client discovers the newer one via
 *     `npm view @nagellabs/libi dist-tags.latest`
 *   → install the upgrade in place and confirm the swap
 *
 * `npm view … dist-tags.latest` is exactly the call Task 9's update checker
 * makes, so this proves the update mechanism is testable before any UI exists.
 *
 * The two published versions carry IDENTICAL content apart from the version
 * field — deliberately. What is being rehearsed is discovery and replacement,
 * not a content diff, and re-packing the ~100MB tree twice would only make the
 * run slower without testing anything more.
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
  installedDir,
  teardown,
  readRepoPkg,
  bumpPatch,
  parseArgs,
  registryUrl,
  run,
  paths,
  step,
  log,
  fail,
} = require("./lib.js");

const fs = require("node:fs");
const path = require("node:path");

function installedVersion() {
  return JSON.parse(
    fs.readFileSync(path.join(installedDir(), "package.json"), "utf8"),
  ).version;
}

async function main() {
  const args = parseArgs();
  const started = Date.now();
  assertRepoPkgUnmutated("at start");

  await startRegistry({ fresh: true });

  const v1 = readRepoPkg().version;
  const v2 = bumpPatch(v1);

  const stage = stagePackage();

  step(`version 1 of 2: ${v1}`);
  publishStaged(stage, v1);

  installConsumer(v1, { ignoreScripts: args.has("--ignore-scripts") });
  assertConsumerInstall(v1);

  const latestBefore = viewDistTagLatest();
  if (latestBefore !== v1) {
    fail(`dist-tags.latest is ${latestBefore} after publishing only ${v1}`);
  }
  log(`dist-tags.latest = ${latestBefore} (as published)`);

  step(`version 2 of 2: ${v2}`);
  publishStaged(stage, v2);

  // ── The assertion the whole rehearsal exists for ──────────────────────────
  const latestAfter = viewDistTagLatest();
  if (latestAfter !== v2) {
    fail(
      `the installed client did not discover the new version.\n` +
        `  npm view ${"@nagellabs/libi"} dist-tags.latest → ${latestAfter}\n` +
        `  expected                                       → ${v2}`,
    );
  }
  log(`UPGRADE DISCOVERED: installed ${installedVersion()}, dist-tags.latest = ${latestAfter}`);
  log(`versions on registry = ${JSON.stringify(viewVersions())}`);

  // ── And that the discovered upgrade actually installs over the old one ────
  step(`installing the discovered upgrade in place`);
  run(
    "npm",
    [
      "install",
      `@nagellabs/libi@${v2}`,
      `--registry=${registryUrl()}`,
      "--no-audit",
      "--no-fund",
      "--loglevel=warn",
      ...(args.has("--ignore-scripts") ? ["--ignore-scripts"] : []),
    ],
    { cwd: paths.consumerDir },
  );
  assertConsumerInstall(v2);
  if (installedVersion() !== v2) {
    fail(`after upgrade the consumer still has ${installedVersion()}`);
  }

  assertRepoPkgUnmutated("before teardown");
  await teardown({ keep: args.has("--keep") });
  assertRepoPkgUnmutated("after teardown");

  const secs = ((Date.now() - started) / 1000).toFixed(0);
  step(`PASS — ${v1} → ${v2} discovered via dist-tags.latest and installed in ${secs}s`);
}

main();
