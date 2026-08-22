#!/usr/bin/env node
/**
 * Build the RUNTIME SNAPSHOT the desktop shell ships and boots.
 *
 * ── The model ─────────────────────────────────────────────────────────────
 * libi's product code is the published npm package `@nagellabs/libi`. A
 * feature release is `npm publish`; every desktop install picks it up on next
 * launch. The Electron shell re-ships only for Chromium CVEs, native ABI
 * bumps, and breaking `shellApiVersion` changes.
 *
 * For that to work offline and on first launch, the .app has to carry a
 * complete, *installed* copy of some version of the package. This script
 * produces it:
 *
 *     build/libi-bundle/
 *       .libi-runtime.json          ← the stamp electron/runtime-loader.ts reads
 *       node_modules/
 *         @nagellabs/libi/          ← the runtime root (.next, dist-cli, lib, mcp…)
 *         better-sqlite3/ next/ …   ← its production dependencies
 *
 * `electron-builder.yml` copies that directory to
 * `Contents/Resources/libi-bundle/` via `extraResources`, which is why the
 * shell's `files` allowlist no longer copies `lib/`, `app/`, `components/`,
 * `hooks/`, `drizzle/`, `mcp/`, `.next/` or `node_modules/` out of the working
 * tree at all.
 *
 * ── Why an npm install and not a file copy ────────────────────────────────
 * Three properties fall out of it that a copy cannot give:
 *
 *   1. **It is the artifact users actually get.** The bundle is built from
 *      `npm pack`'s tarball, so anything missing from `package.json#files`
 *      breaks the packaged app too — the two artifacts can no longer disagree
 *      about what ships.
 *   2. **The licence gate becomes structural.** `--omit=dev` means
 *      `@agentclientprotocol/claude-agent-acp` (and the proprietary
 *      `@anthropic-ai` tree behind it) is excluded by the DEPENDENCY GRAPH
 *      rather than by a glob that only matches at the top level. Asserted
 *      explicitly below anyway — belt and braces, because this one is a
 *      licence position, not a nicety.
 *   3. **`node_modules` matches the runtime's own `package.json`,** so
 *      `require("next")` from inside the runtime resolves to the version that
 *      runtime was built against.
 *
 * ── The native ABI ────────────────────────────────────────────────────────
 * `better-sqlite3` is the one dependency stamped with a `NODE_MODULE_VERSION`
 * (everything else native here is N-API: node-pty via node-addon-api,
 * @napi-rs/canvas, @resvg/resvg-js). A plain `npm install` builds it for the
 * BUILD MACHINE's Node; Electron 36 is a different ABI. So after installing we
 * re-fetch the Electron prebuild with the mechanism the Phase 0 spike verified:
 *
 *     prebuild-install --runtime=electron --target=<electron> \
 *                      --dist-url=https://electronjs.org/headers
 *
 * That FETCHES; it never compiles. If the fetch fails (those prebuilds come
 * from GitHub releases — a different network dependency from npm, with
 * different reachability) this script HARD-FAILS. It must never fall back to
 * `node-gyp rebuild`, and it must never write a stamp for a bundle whose ABI it
 * could not resolve: a wrong-ABI runtime boots halfway and dies at the first DB
 * call, which is worse than not building at all.
 *
 * ── This step MUST NOT be silently skippable ──────────────────────────────
 * Same receipt as `scripts/build-cli.js` and
 * `scripts/write-next-externals-manifest.js`: this repo already shipped a
 * silently-skipped build step (an npm `postbuild` hook that never fired,
 * because the release script is invoked BY PATH and npm only fires hooks for
 * scripts it runs by NAME). So:
 *
 *   * `build:electron` calls this file EXPLICITLY, by path, before
 *     `electron-builder`;
 *   * the output is STAMPED with the package version, the Electron ABI, the
 *     `.next` BUILD_ID and the dist-cli build time;
 *   * `assertRuntimeBundleFresh()` throws on missing/stale output, and
 *     `electron-builder.yml`'s `beforePack` hook runs it — so a packaged app
 *     can never be built around a rotten or absent bundle.
 *
 * Never re-introduce this as a lifecycle hook.
 *
 * ── The stamp describes THE BUNDLE, not the tree that built it ─────────────
 * This was got wrong once, and the way it was wrong is the reason the rule is
 * spelled out here. The stamp's `buildId` / `cliBuiltAt` used to be read from
 * the WORKING TREE, and `verifyRuntimeBundle()` then compared them back
 * against that same working tree. In the default mode that is merely circular;
 * under `--from-registry` — the release path, where the bundle's contents come
 * from npm and have no necessary relationship to the tree — it was actively
 * false: the stamp described one artifact while the bundle contained another,
 * and the guard whose entire job is to catch that compared the tree against
 * itself and reported green. A guard that cannot fail is worse than no guard,
 * because it is read as evidence.
 *
 * So every fact in the stamp is now read from `<outDir>/node_modules/
 * @nagellabs/libi` — the runtime that is actually in the bundle — and
 * `verifyRuntimeBundle()` recomputes those same facts from that same tree.
 * `origin` records which mode produced it, and only a `working-tree` bundle is
 * additionally required to agree with the working tree (there, the tree IS the
 * source, so the comparison means something). A `registry` bundle is checked
 * against what was asked of npm instead.
 *
 * Following `scripts/build-cli.js`, the check runs in BOTH directions where it
 * can: `verifyCliBundle({ root: <bundled runtime> })` re-hashes the bundled
 * runtime's own `lib/` + `mcp/` sources against the `dist-cli/BUILD_INFO.json`
 * shipped beside them, so neither an added nor a deleted file can slip past.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────
 *   node scripts/build-runtime-bundle.js                    # pack the working tree
 *   node scripts/build-runtime-bundle.js --verify           # freshness check only
 *   node scripts/build-runtime-bundle.js --from-registry    # install the published version
 *   node scripts/build-runtime-bundle.js --from-registry=0.1.1 --registry=http://127.0.0.1:4873/
 *
 * The default (pack the working tree) is what dev and CI builds want, and it
 * GUARANTEES the bundled runtime's `shellApiVersion` is the one this shell was
 * compiled against. `--from-registry` is the release path described in
 * docs-local/from-repo/RELEASING.md, where npm publish happens before the shell is built.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const {
  assertCliBundleFresh,
  verifyCliBundle,
  STAMP_NAME: CLI_STAMP_NAME,
} = require("./build-cli.js");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIRNAME = path.join("build", "libi-bundle");
const STAMP_NAME = ".libi-runtime.json";
const PKG_NAME = "@nagellabs/libi";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function repoPkg(root = ROOT) {
  return readJson(path.join(root, "package.json"));
}

function log(msg) {
  process.stdout.write(`[runtime-bundle] ${msg}\n`);
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    ...opts,
  });
  if (res.status !== 0) {
    throw new Error(
      `[runtime-bundle] \`${cmd} ${args.join(" ")}\` failed with exit code ${res.status}`,
    );
  }
  return res;
}

function capture(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: "utf-8",
    shell: process.platform === "win32",
    ...opts,
  });
  if (res.status !== 0) {
    throw new Error(
      `[runtime-bundle] \`${cmd} ${args.join(" ")}\` failed: ${res.stderr || res.stdout}`,
    );
  }
  return (res.stdout || "").trim();
}

/** `<prefix>/node_modules/@nagellabs/libi` — must mirror `runtimeRootFor()`. */
function runtimeRootFor(prefix) {
  return path.join(prefix, "node_modules", ...PKG_NAME.split("/"));
}

// ---------------------------------------------------------------------------
// Electron facts
// ---------------------------------------------------------------------------

function electronVersion() {
  return require("electron/package.json").version;
}

/**
 * The `NODE_MODULE_VERSION` the packaged app will run under.
 *
 * Asked of the actual Electron binary rather than kept in a table, because a
 * table is exactly the thing that silently rots across an Electron major bump —
 * and a wrong number here would stamp a bundle the loader then accepts and the
 * app then dies on.
 */
function electronAbi() {
  const electronBin = require("electron");
  if (typeof electronBin !== "string") {
    throw new Error(
      "[runtime-bundle] `require('electron')` did not return a binary path — " +
        "is the electron devDependency installed?",
    );
  }
  const out = capture(electronBin, ["-e", "process.stdout.write(process.versions.modules)"], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  if (!/^\d+$/.test(out)) {
    throw new Error(`[runtime-bundle] could not read Electron's ABI (got: ${out})`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Preconditions
// ---------------------------------------------------------------------------

/**
 * Everything the WORKING TREE must already contain before it can be packed.
 * `npm pack` does NOT build these — `npm run build` / `next-build-release.js`
 * does — and publishing or bundling without them produces an install that can
 * never launch.
 *
 * Only meaningful in the default (pack-the-working-tree) mode. Under
 * `--from-registry` the bundle's contents come from npm, so the state of the
 * tree neither helps nor hinders; the equivalent assertions run against the
 * INSTALLED runtime instead (`readRuntimeFacts`, called in both modes).
 */
function assertWorkingTreeArtifacts() {
  const buildIdPath = path.join(ROOT, ".next", "BUILD_ID");
  if (!fs.existsSync(buildIdPath)) {
    throw new Error(
      "[runtime-bundle] no production `.next` build (missing .next/BUILD_ID).\n" +
        "   Run `npm run build` (or build:electron's next-build-release step) first.",
    );
  }
  const externals = path.join(ROOT, ".next", "externals-manifest.json");
  if (!fs.existsSync(externals)) {
    throw new Error(
      "[runtime-bundle] .next/externals-manifest.json is missing.\n" +
        "   npm strips symlinks from every tarball, so without this manifest the\n" +
        "   installed runtime's `.next/node_modules` farm cannot be rebuilt and the\n" +
        "   server 500s every route. Rebuild via `npm run build`.",
    );
  }
  // Throws with its own actionable message when dist-cli/ is missing or stale.
  assertCliBundleFresh({ root: ROOT });
}

/**
 * Every fact the stamp records, read out of ONE runtime tree.
 *
 * Deliberately root-agnostic: the same function reads the bundled runtime
 * (`<outDir>/node_modules/@nagellabs/libi`) and — when the bundle claims to
 * have come from here — the working tree, so the two can be compared field for
 * field instead of one standing in for the other.
 *
 * `cliBuiltAt` / `cliFileCount` / `cliInputsDigest` all come from
 * `dist-cli/BUILD_INFO.json`, because `.next/BUILD_ID` and the package version
 * can both be unchanged while `dist-cli/` — which contains `shell-api.js`, the
 * ONE module the shell loads out of a runtime — was recompiled from different
 * sources. `cliInputsDigest` folds that stamp's whole per-source sha256 map
 * into one value, so a bundle whose compiled CLI was built from a different
 * source tree is caught even if the clock happened to agree.
 *
 * Throws (with the offending path named) rather than returning nulls: a fact
 * that cannot be read must not be quietly stamped as absent and then quietly
 * compared equal to the next absence.
 */
function readRuntimeFacts(root) {
  const manifestPath = path.join(root, "package.json");
  let manifest;
  try {
    manifest = readJson(manifestPath);
  } catch {
    throw new Error(`${manifestPath} is missing or unreadable`);
  }
  const buildIdPath = path.join(root, ".next", "BUILD_ID");
  let buildId;
  try {
    buildId = fs.readFileSync(buildIdPath, "utf-8").trim();
  } catch {
    throw new Error(`${buildIdPath} is missing or unreadable`);
  }
  const cliStampPath = path.join(root, "dist-cli", CLI_STAMP_NAME);
  let cliStamp;
  try {
    cliStamp = readJson(cliStampPath);
  } catch {
    throw new Error(`${cliStampPath} is missing or unreadable`);
  }
  if (!cliStamp || typeof cliStamp.inputs !== "object" || cliStamp.inputs === null) {
    throw new Error(`${cliStampPath} has no \`inputs\` map`);
  }
  return {
    name: manifest.name,
    version: manifest.version ?? null,
    shellApiVersion: (manifest.libi && manifest.libi.shellApiVersion) ?? null,
    buildId,
    cliBuiltAt: cliStamp.builtAt ?? null,
    cliFileCount: cliStamp.fileCount ?? null,
    cliInputsDigest: digestCliInputs(cliStamp.inputs),
  };
}

/** Order-independent sha256 over a `dist-cli` stamp's per-source hash map. */
function digestCliInputs(inputs) {
  const lines = Object.keys(inputs)
    .sort()
    .map((rel) => `${rel} ${inputs[rel]}`);
  return crypto.createHash("sha256").update(lines.join("\n")).digest("hex");
}

/** The stamp fields that must equal a tree's facts, in report order. */
const STAMPED_FACTS = [
  ["version", "package version"],
  ["shellApiVersion", "shellApiVersion"],
  ["buildId", ".next build"],
  ["cliBuiltAt", "dist-cli build time"],
  ["cliFileCount", "dist-cli file count"],
  ["cliInputsDigest", "dist-cli source digest"],
];

/**
 * First field on which `stamp` and `facts` disagree, as a reason string, or
 * null when they agree on all of them. `what` names the tree the facts came
 * from so the message says which side is wrong.
 */
function factMismatch(stamp, facts, what) {
  for (const [key, label] of STAMPED_FACTS) {
    const stamped = stamp[key] ?? null;
    const actual = facts[key] ?? null;
    if (String(stamped) !== String(actual)) {
      return (
        `stamp claims ${label} ${stamped ?? "(none)"}, ${what} has ${actual ?? "(none)"}`
      );
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function packWorkingTree(scratchDir) {
  fs.rmSync(scratchDir, { recursive: true, force: true });
  fs.mkdirSync(scratchDir, { recursive: true });
  // `--ignore-scripts` skips `prepack` (clean-artifacts + build-cli) and
  // `prepare` (electron-builder install-app-deps). Both have ALREADY run by the
  // time build:electron reaches this script, and re-running install-app-deps
  // here would flip the working tree's better-sqlite3 ABI mid-build for no
  // reason. `assertWorkingTreeArtifacts()`, called just before this, enforces
  // what prepack would have.
  run("npm", ["pack", "--ignore-scripts", "--pack-destination", scratchDir], {
    cwd: ROOT,
  });
  const tarballs = fs.readdirSync(scratchDir).filter((f) => f.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    throw new Error(
      `[runtime-bundle] expected exactly one tarball in ${scratchDir}, found ${tarballs.length}`,
    );
  }
  return path.join(scratchDir, tarballs[0]);
}

function installBundle({ outDir, spec, registry }) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  // A synthetic project root so npm treats `outDir` as an install prefix with
  // its own hoisted `node_modules`, rather than walking up into the repo.
  fs.writeFileSync(
    path.join(outDir, "package.json"),
    JSON.stringify(
      {
        name: "libi-runtime-bundle",
        version: "0.0.0",
        private: true,
        description:
          "Generated by scripts/build-runtime-bundle.js — an installed @nagellabs/libi runtime snapshot. Do not edit.",
      },
      null,
      2,
    ) + "\n",
  );

  const args = [
    "install",
    spec,
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    "--loglevel=warn",
  ];
  if (registry) args.push(`--registry=${registry}`);
  run("npm", args, { cwd: outDir });
  restorePrebuiltExecutables(outDir);
}

/**
 * Prebuilt helper binaries that npm unpacks WITHOUT the execute bit, and that
 * nothing later puts back inside a packaged app.
 *
 * `lib/terminal/pty.ts` already carries a runtime `chmod +x` for node-pty's
 * `spawn-helper`, and in a dev tree or an `npx` install that works — those
 * live somewhere writable. **It cannot work in the desktop app.** The bundle
 * ends up inside a signed, notarized `.app`, where chmod is refused outright:
 *
 *   EPERM: operation not permitted, chmod
 *     '/Applications/Libi.app/Contents/Resources/libi-bundle/node_modules/
 *      node-pty/prebuilds/darwin-arm64/spawn-helper'
 *
 * node-pty posix_spawn()s that helper on EVERY pty launch, so a non-executable
 * one means the built-in Terminal cannot start at all — the user gets a bare
 * "posix_spawn failed." and, if they are signed out of Codex, no way to sign
 * in, because that remedy opens a terminal.
 *
 * Found in the v0.1.3 FULL verification against the shipped dmg, where the
 * helper was mode 644 in both the installed app and the pristine image.
 *
 * Fixing it HERE is the only place that works: this runs before
 * electron-builder packages and signs, so the bit is part of what gets signed
 * rather than something we try to change afterwards.
 */
function restorePrebuiltExecutables(outDir) {
  // Not a glob over "anything without an extension" — that would flip bits on
  // arbitrary files a dependency happens to ship. Name what we mean.
  const relative = [
    ["node-pty", "prebuilds", "darwin-arm64", "spawn-helper"],
    ["node-pty", "prebuilds", "darwin-x64", "spawn-helper"],
    ["node-pty", "prebuilds", "linux-x64", "spawn-helper"],
    ["node-pty", "prebuilds", "linux-arm64", "spawn-helper"],
    ["node-pty", "build", "Release", "spawn-helper"],
  ];
  const fixed = [];
  for (const parts of relative) {
    const helper = path.join(outDir, "node_modules", ...parts);
    let stat;
    try {
      stat = fs.statSync(helper);
    } catch {
      continue; // a platform this bundle doesn't carry
    }
    if ((stat.mode & 0o111) !== 0) continue;
    fs.chmodSync(helper, stat.mode | 0o755);
    fixed.push(path.join(...parts));
  }
  if (fixed.length > 0) {
    log(`restored the execute bit on ${fixed.length} prebuilt helper(s): ${fixed.join(", ")}`);
  }
}

/**
 * Node majors to fetch a SIDECAR better-sqlite3 binding for.
 *
 * See `fetchNodeAbiSidecars` for why the Electron binding alone is not enough.
 * The range is `MIN_NODE_MAJOR` (lib/runtime/node-runtime.ts) through the major
 * of `PINNED_NODE_VERSION`.
 *
 * It is NOT the full set of interpreters that can reach the binding, and an
 * earlier version of this comment claimed it was while refuting itself in the
 * next clause. `ensureNodeRuntime()` LINKS any system node at or above the
 * minimum with no upper bound, so a machine whose `node` is newer than this
 * list (Homebrew's current is 25.x) ends up at `<LIBI_HOME>/bin/node` with no
 * sidecar to match. That case is handled by `resolveNativeBinding` refusing
 * loudly, and by `ensureNodeRuntime` preferring a covered major — not by
 * pretending this list is exhaustive.
 *
 * Majors better-sqlite3 publishes no prebuild for (today: 20) are skipped with
 * a warning rather than failing the build — a node that old cannot run the MCP
 * child under ANY packaging, so refusing to build for everyone else would be
 * the wrong trade.
 *
 * KEEP IN SYNC with `NODE_ABI_SIDECAR_MAJORS` in
 * `lib/runtime/node-abi-sidecars.ts` — this file is plain CJS run by node at
 * build time and cannot import TypeScript, so the list is duplicated on
 * purpose. `__tests__/unit/runtime/node-abi-sidecars.test.ts` fails on drift.
 */
const NODE_ABI_SIDECAR_MAJORS = [20, 21, 22, 23, 24];

/**
 * Fetch a plain-Node binding for each supported Node major, parked next to the
 * Electron one as `build/Release-node-<major>/better_sqlite3.node`.
 *
 * ── Why the Electron binding alone is not enough ──────────────────────────
 * The packaged app runs product code under TWO different interpreters:
 *
 *   * the Next server, INSIDE the Electron main process → Electron's ABI;
 *   * the libi MCP stdio child, spawned as a REAL node by `buildLibiEntry()`
 *     via `resolveNodeCommand()` → that node's ABI.
 *
 * The second one is not optional and cannot be made to match: the
 * `runAsNode: false` fuse (electron-builder.yml) deliberately forbids
 * re-using the app binary as a Node runtime, and no plain Node release shares
 * Electron's NODE_MODULE_VERSION anyway (Electron 36 is 135; Node 22 is 127,
 * Node 24 is 137). A bundle carrying only the Electron binding therefore boots
 * a perfectly healthy UI in which EVERY DB-backed `libi.*` tool fails with
 * "compiled against a different Node.js version" — the agent can list its
 * tools and do nothing with them.
 *
 * `lib/db/native-binding.ts` picks the right file at connect time; this step is
 * what puts one there. Non-fatal per major: a missing sidecar degrades to
 * exactly the pre-existing (broken-for-that-major) behaviour, and the summary
 * line names what was fetched so a release build cannot quietly ship none.
 */
function fetchNodeAbiSidecars({ moduleDir, bin }) {
  const releaseDir = path.join(moduleDir, "build", "Release");
  const bindingPath = path.join(releaseDir, "better_sqlite3.node");
  const fetched = [];

  for (const major of NODE_ABI_SIDECAR_MAJORS) {
    const res = spawnSync(
      process.execPath,
      [bin, "--runtime=node", `--target=${major}.0.0`],
      { cwd: moduleDir, stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" },
    );
    if (res.status !== 0 || !fs.existsSync(bindingPath)) {
      process.stdout.write(
        `[runtime-bundle] no better-sqlite3 prebuild for node ${major} — skipping sidecar\n`,
      );
      continue;
    }
    const destDir = path.join(moduleDir, "build", `Release-node-${major}`);
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(bindingPath, path.join(destDir, "better_sqlite3.node"));
    fetched.push(major);
  }

  // The Electron fetch below overwrites build/Release, which is what makes the
  // DEFAULT binding Electron's — the in-process Next server must keep loading
  // it without any lookup. Removing it here keeps that ordering honest: if the
  // Electron fetch fails, the build dies with no binding rather than shipping
  // the last node one under the Electron name.
  fs.rmSync(bindingPath, { force: true });

  if (fetched.length === 0) {
    throw new Error(
      "[runtime-bundle] could not fetch a plain-Node better-sqlite3 binding for ANY\n" +
        `   supported major (${NODE_ABI_SIDECAR_MAJORS.join(", ")}). The packaged app's MCP\n` +
        "   child runs under a real node, so a bundle without one boots a UI whose every\n" +
        "   database-backed libi.* tool fails. Refusing to build.",
    );
  }
  return fetched;
}

/**
 * Re-fetch better-sqlite3's prebuilt bindings — Electron's (the default, for
 * the in-process Next server) plus one per supported Node major (for the MCP
 * stdio child, which is a separate real-node process).
 *
 * Hard-fails rather than compiling. See the header.
 */
function resolveNativeAbi({ outDir, electron }) {
  const moduleDir = path.join(outDir, "node_modules", "better-sqlite3");
  if (!fs.existsSync(moduleDir)) {
    throw new Error(`[runtime-bundle] better-sqlite3 not found at ${moduleDir}`);
  }
  const candidates = [
    path.join(outDir, "node_modules", "prebuild-install", "bin.js"),
    path.join(moduleDir, "node_modules", "prebuild-install", "bin.js"),
  ];
  const bin = candidates.find((p) => fs.existsSync(p));
  if (!bin) {
    throw new Error(
      "[runtime-bundle] prebuild-install is not present in the bundle — cannot resolve\n" +
        "   better-sqlite3's Electron ABI without compiling, which this step must never do.\n" +
        `   Looked in:\n     ${candidates.join("\n     ")}`,
    );
  }

  const sidecars = fetchNodeAbiSidecars({ moduleDir, bin });
  process.stdout.write(
    `[runtime-bundle] better-sqlite3 node-ABI sidecars: ${sidecars.join(", ")}\n`,
  );

  const res = spawnSync(
    process.execPath,
    [
      bin,
      "--runtime=electron",
      `--target=${electron}`,
      "--dist-url=https://electronjs.org/headers",
    ],
    { cwd: moduleDir, stdio: "inherit" },
  );
  if (res.status !== 0) {
    throw new Error(
      "[runtime-bundle] could not fetch better-sqlite3's Electron prebuild.\n" +
        "   These prebuilds come from GitHub releases, NOT npm — a proxy or region that\n" +
        "   blocks github.com fails here while npm itself works fine.\n" +
        "   This build is stopping rather than falling back to `node-gyp rebuild`: a\n" +
        "   compiled-on-this-machine binding, or a build-machine-ABI one, produces an app\n" +
        "   that opens and then dies at the first database call.",
    );
  }

  const binding = path.join(moduleDir, "build", "Release", "better_sqlite3.node");
  if (!fs.existsSync(binding)) {
    throw new Error(
      `[runtime-bundle] prebuild-install reported success but ${binding} is missing`,
    );
  }
  return binding;
}

/**
 * Delete the Electron shell build that npm force-includes into the tarball.
 *
 * npm ALWAYS packs whatever `package.json#main` points at — here
 * `dist-electron/electron/main.js` — regardless of the `files` allowlist or an
 * explicit `!` negation. `scripts/clean-npm-pack-artifacts.js` (run from
 * `prepack`) exists precisely to stop that reaching a PUBLISHED tarball, by
 * refusing to pack while `dist-electron/` is on disk.
 *
 * That guard cannot apply here: this script runs inside `build:electron`,
 * immediately after `compile:electron` produced `dist-electron/`, so the
 * directory MUST exist. Packing with `--ignore-scripts` therefore skips the
 * guard and the shell build rides along inside the snapshot.
 *
 * Rather than leave the two paths asymmetric — a registry-installed runtime
 * would not contain it, a locally-packed one would — the directory is removed
 * from the installed tree. The bundled snapshot then has the same contents as
 * one installed from the registry, which is the entire point of building it
 * this way. (Harmless if absent: `--from-registry` installs never have it.)
 */
function stripForcedMainArtifact(root) {
  const dir = path.join(root, "dist-electron");
  if (!fs.existsSync(dir)) return;
  fs.rmSync(dir, { recursive: true, force: true });
  log("removed dist-electron/ from the snapshot (npm force-includes package.json#main)");
}

/**
 * The licence invariant, asserted on the artifact rather than assumed from the
 * `--omit=dev` flag. libi is GPL-3.0 and holds no licence to redistribute
 * Anthropic's proprietary code; `@agentclientprotocol/claude-agent-acp` pulls
 * it in transitively and is installed into `~/.libi/agents/node_modules` at
 * first run instead (lib/agents/runtime-install.ts).
 */
function findProprietaryDeps(outDir) {
  const forbidden = [
    path.join(outDir, "node_modules", "@anthropic-ai"),
    path.join(outDir, "node_modules", "@agentclientprotocol", "claude-agent-acp"),
  ];
  return [
    ...forbidden.filter((p) => fs.existsSync(p)),
    // Nested copies the top-level check above cannot see.
    ...findNested(path.join(outDir, "node_modules"), "@anthropic-ai", 6),
  ];
}

function assertNoProprietaryDeps(outDir) {
  const present = findProprietaryDeps(outDir);
  if (present.length > 0) {
    throw new Error(
      "[runtime-bundle] LICENCE VIOLATION — the bundle contains code libi may not redistribute:\n" +
        present.map((p) => `     ${p}`).join("\n") +
        "\n   `@agentclientprotocol/claude-agent-acp` MUST stay a devDependency.",
    );
  }
}

function findNested(dir, needle, depth) {
  if (depth <= 0) return [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const hits = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    if (entry.name === needle) {
      hits.push(full);
      continue;
    }
    hits.push(...findNested(full, needle, depth - 1));
  }
  return hits;
}

/** Every symlink under `dir`, recursively, as absolute paths. */
function farmSymlinks(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) found.push(full);
    // Scoped packages (`@napi-rs/canvas-<hash>`) nest one level.
    else if (entry.isDirectory()) found.push(...farmSymlinks(full));
  }
  return found;
}

/**
 * Materialise `.next/node_modules`'s externals symlink farm INSIDE the bundle,
 * at BUILD time.
 *
 * Turbopack resolves `serverExternalPackages` through a symlink farm that
 * `npm pack` strips unconditionally, so the freshly-installed bundle has an
 * `externals-manifest.json` and no farm. Something has to recreate it, and the
 * only two candidates are here or at first boot.
 *
 * It cannot be first boot. This bundle is copied verbatim into
 * `Libi.app/Contents/Resources/libi-bundle/`, and `.app` contents are
 * code-signed and may be mounted read-only — so a boot-time write is a
 * signature break in the good case and an EROFS crash in the bad one. Doing it
 * here means the shipped `.app` already contains the farm and every packaged
 * boot takes `ensureNextExternalSymlinks`' pure-verify path.
 *
 * That only works because the links are RELATIVE (see the long note in
 * `lib/install/next-externals.ts`): this bundle is written at
 * `build/libi-bundle/` and read from `Contents/Resources/`, so an absolute
 * link baked here would point into the build machine's checkout and dangle on
 * every user's disk. Both properties are ASSERTED below rather than trusted —
 * a dangling farm reproduces the exact failure this whole mechanism exists to
 * prevent (server binds its port, then 500s every route), and it would ship
 * silently.
 *
 * Deliberately requires the module out of the BUNDLE (`dist-cli/`), not this
 * repo: the farm must be built by the same code that will later verify it at
 * boot, even when the bundle came from a published tarball built elsewhere.
 */
function materializeNextExternals(root) {
  const modPath = path.join(root, "dist-cli", "lib", "install", "next-externals.js");
  if (!fs.existsSync(modPath)) {
    throw new Error(
      `[runtime-bundle] the installed runtime is missing ${path.relative(root, modPath)} — ` +
        "cannot materialise the Next.js externals symlink farm.",
    );
  }
  const { ensureNextExternalSymlinks } = require(modPath);
  const nextDir = path.join(root, ".next");
  const farmDir = path.join(nextDir, "node_modules");

  let result;
  try {
    result = ensureNextExternalSymlinks(nextDir);
  } catch (err) {
    throw new Error(
      "[runtime-bundle] could not materialise the Next.js externals symlink farm: " +
        `${err && err.message ? err.message : String(err)}\n` +
        "   Turbopack externalises packages under hashed names that resolve ONLY through\n" +
        "   that farm, so bundling this would ship an app that 500s on every route.",
    );
  }

  if (result.skipped === "no-externals") {
    console.warn(
      "[runtime-bundle] WARNING: the bundled runtime's externals manifest records 0 entries, " +
        "so no symlink farm was materialised. A healthy build has produced 8 throughout this " +
        "project's history — investigate before shipping.",
    );
    return;
  }

  const links = farmSymlinks(farmDir);
  if (links.length === 0) {
    throw new Error(
      `[runtime-bundle] materialising the externals farm reported ` +
        `${result.created.length} created / ${result.verified.length} verified, but ` +
        `${path.relative(root, farmDir)} contains no symlinks. Refusing to ship a bundle ` +
        "whose farm does not exist on disk.",
    );
  }

  const absolute = [];
  const dangling = [];
  for (const link of links) {
    if (path.isAbsolute(fs.readlinkSync(link))) absolute.push(path.relative(root, link));
    try {
      fs.realpathSync(link);
    } catch {
      dangling.push(path.relative(root, link));
    }
  }
  if (absolute.length > 0) {
    throw new Error(
      `[runtime-bundle] ${absolute.length} externals symlink(s) have ABSOLUTE targets: ` +
        `${absolute.join(", ")}.\n` +
        "   This bundle is copied into Libi.app/Contents/Resources/, so an absolute target\n" +
        "   points at this build machine and would dangle on every user's disk.",
    );
  }
  if (dangling.length > 0) {
    throw new Error(
      `[runtime-bundle] ${dangling.length} externals symlink(s) do not resolve: ` +
        `${dangling.join(", ")}.`,
    );
  }

  log(
    `externals farm: ${links.length} relative symlink(s) materialised ` +
      `(${result.created.length} created, ${result.verified.length} already correct)`,
  );
}

/**
 * Write the stamp from `facts` — which MUST have been read out of the bundled
 * runtime, never out of the working tree. See the header.
 */
function writeStamp({ outDir, facts, abi, electron, origin, requestedVersion, versionPinned }) {
  const stamp = {
    package: PKG_NAME,
    version: facts.version,
    shellApiVersion: facts.shellApiVersion,
    abi,
    electronVersion: electron,
    buildId: facts.buildId,
    cliBuiltAt: facts.cliBuiltAt,
    cliFileCount: facts.cliFileCount,
    cliInputsDigest: facts.cliInputsDigest,
    /** Which mode produced this bundle — decides what it can be verified against. */
    origin,
    /** The version asked of npm (`registry` origin only; null when packed locally). */
    requestedVersion,
    /** Was that version given explicitly as `--from-registry=<v>`? */
    versionPinned,
    source: "bundled",
    installedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(outDir, STAMP_NAME),
    JSON.stringify(stamp, null, 2) + "\n",
  );
  return stamp;
}

async function buildRuntimeBundle({ fromRegistry = null, registry = null, outDir } = {}) {
  const target = outDir ?? path.join(ROOT, OUT_DIRNAME);
  const pkg = repoPkg();
  const shellApiVersion = pkg.libi && pkg.libi.shellApiVersion;
  if (!Number.isInteger(shellApiVersion)) {
    throw new Error(
      "[runtime-bundle] package.json#libi.shellApiVersion is missing or not an integer.\n" +
        "   It is the shell↔runtime contract the loader gates on — see lib/runtime/shell-api.ts.",
    );
  }

  const electron = electronVersion();
  const abi = electronAbi();
  log(`electron ${electron} → NODE_MODULE_VERSION ${abi}`);

  const origin = fromRegistry ? "registry" : "working-tree";
  const versionPinned = typeof fromRegistry === "string";
  const requestedVersion = fromRegistry ? (versionPinned ? fromRegistry : pkg.version) : null;

  let spec;
  let scratch = null;
  if (fromRegistry) {
    spec = `${PKG_NAME}@${requestedVersion}`;
    log(`installing published ${spec}${registry ? ` from ${registry}` : ""}`);
  } else {
    // Only the pack path consumes the working tree, so only it can demand a
    // built one. Under --from-registry the bundle's contents come from npm.
    assertWorkingTreeArtifacts();
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "libi-runtime-pack-"));
    spec = packWorkingTree(scratch);
    log(`packed working tree → ${path.basename(spec)}`);
  }

  try {
    installBundle({ outDir: target, spec, registry });
  } finally {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  }

  const root = runtimeRootFor(target);
  if (!fs.existsSync(root)) {
    throw new Error(`[runtime-bundle] install produced no runtime root at ${root}`);
  }
  const installed = readJson(path.join(root, "package.json"));
  if (installed.name !== PKG_NAME) {
    throw new Error(
      `[runtime-bundle] runtime root is ${installed.name}, expected ${PKG_NAME}`,
    );
  }
  if ((installed.libi && installed.libi.shellApiVersion) !== shellApiVersion) {
    throw new Error(
      `[runtime-bundle] the installed runtime declares shellApiVersion ` +
        `${String(installed.libi && installed.libi.shellApiVersion)} but this shell is built ` +
        `for ${shellApiVersion}. Bundling it would ship an app that rejects its own snapshot.`,
    );
  }

  stripForcedMainArtifact(root);
  resolveNativeAbi({ outDir: target, electron });
  assertNoProprietaryDeps(target);

  // The two files electron/runtime-loader.ts checks for. Asserted here so a
  // packaging mistake fails the BUILD rather than the user's first launch.
  for (const rel of ["dist-cli/lib/runtime/shell-api.js", ".next/BUILD_ID"]) {
    if (!fs.existsSync(path.join(root, rel))) {
      throw new Error(`[runtime-bundle] the installed runtime is missing ${rel}`);
    }
  }

  // Rebuild the symlink farm `npm pack` stripped, HERE rather than at the
  // user's first boot — a boot-time write would land inside the signed .app.
  materializeNextExternals(root);

  // The bundled runtime's compiled CLI must match the sources shipped beside
  // it. Neither mode can take this on trust: a published tarball can carry a
  // stale `dist-cli/` just as a locally-packed one can.
  const bundledCli = verifyCliBundle({ root });
  if (!bundledCli.ok) {
    throw new Error(
      "[runtime-bundle] the installed runtime's dist-cli does not match its own sources — " +
        `${bundledCli.reason}.\n` +
        "   dist-cli/lib/runtime/shell-api.js is the ONE module the shell loads out of a\n" +
        "   runtime; bundling this would ship a snapshot whose entry point is not the code\n" +
        "   its sources describe.",
    );
  }

  // Read from the BUNDLE, never from the working tree — see the header.
  const facts = readRuntimeFacts(root);
  const stamp = writeStamp({
    outDir: target,
    facts,
    abi,
    electron,
    origin,
    requestedVersion,
    versionPinned,
  });
  log(
    `bundle ready: ${PKG_NAME}@${stamp.version} (shellApiVersion ${shellApiVersion}, abi ${abi}) -> ${path.relative(ROOT, target) || target}`,
  );
  return { outDir: target, root, stamp };
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/**
 * Does `build/libi-bundle` contain a runtime the stamp honestly describes, and
 * one this shell may package?
 *
 * The checks, in order, and what each one can catch:
 *
 *  1. the stamp exists, names libi, and is in the honest-stamp format;
 *  2. the runtime root holds the files the loader will look for;
 *  3. **every stamped fact matches the BUNDLED runtime** — version,
 *     shellApiVersion, `.next` build, dist-cli build time, dist-cli file count,
 *     dist-cli source digest. This is the check that used to be impossible to
 *     fail (see the header);
 *  4. the bundled runtime's `dist-cli/` matches the bundled runtime's own
 *     sources, hashed in both directions by `verifyCliBundle`;
 *  5. the bundle's shellApiVersion is the one THIS shell is compiled for;
 *  6. origin-specific: a `working-tree` bundle must additionally agree with the
 *     working tree (there, and only there, the tree is the source of truth); a
 *     `registry` bundle must be the version that was asked of npm;
 *  7. the Electron ABI still matches;
 *  8. the licence invariant still holds on the artifact;
 *  9. the Next.js externals symlink farm exists, is RELATIVE, and resolves —
 *     the property that lets a packaged boot verify instead of writing into
 *     the signed .app. Last, so it can never mask (5)-(8).
 *
 * `treeRoot` is the tree checks (5) and (6) measure against; it defaults to this
 * repo, which is what every caller wants. It exists so the tests can supply a
 * fixture tree instead: reading the real repo made them pass or fail on whether
 * the machine running them happened to have built, and an unbuilt tree stops
 * verification at "working tree is not built" before the drift check it was
 * meant to exercise ever runs.
 *
 * `abi` is check (7)'s expected NODE_MODULE_VERSION. It defaults to asking the
 * real Electron binary, which is what every production caller wants and what
 * `main()` uses. It exists for the same reason `treeRoot` does: `electronAbi()`
 * EXECUTES `node_modules/electron`, so on any checkout where Electron was never
 * downloaded — notably CI, which installs with `--ignore-scripts` — it throws
 * and check (7) fails first, taking the licence (8) and symlink-farm (9) gates
 * down with it. Seven tests covering those two gates skipped on exactly that.
 * Injecting the ABI lets them run everywhere, and lets the MISMATCH branch be
 * exercised deterministically instead of only the accidental-mismatch case.
 *
 * Returns `{ ok, stamp }` / `{ ok: false, reason }`.
 */
function verifyRuntimeBundle({ outDir, treeRoot = ROOT, abi: expectedAbi } = {}) {
  const target = outDir ?? path.join(ROOT, OUT_DIRNAME);
  const stampPath = path.join(target, STAMP_NAME);
  let stamp;
  try {
    stamp = readJson(stampPath);
  } catch {
    return { ok: false, reason: `no runtime bundle: ${stampPath} is missing or unreadable` };
  }
  const pkg = repoPkg(treeRoot);
  if (stamp.package !== PKG_NAME) {
    return { ok: false, reason: `stamp names ${stamp.package}, expected ${PKG_NAME}` };
  }
  if (stamp.origin !== "working-tree" && stamp.origin !== "registry") {
    return {
      ok: false,
      reason:
        `stamp has no \`origin\` (found ${JSON.stringify(stamp.origin ?? null)}) — it predates the ` +
        "honest-stamp format, in which the stamp described the working tree rather than the " +
        "bundle and this check could not fail. Rebuild it",
    };
  }

  // (2) The runtime root, before anything tries to read facts out of it.
  const root = runtimeRootFor(target);
  for (const rel of ["dist-cli/lib/runtime/shell-api.js", ".next/BUILD_ID", "package.json"]) {
    if (!fs.existsSync(path.join(root, rel))) {
      return { ok: false, reason: `bundle runtime root is missing ${rel}` };
    }
  }

  // (3) The stamp must describe the runtime that is actually in the bundle.
  let bundled;
  try {
    bundled = readRuntimeFacts(root);
  } catch (err) {
    return { ok: false, reason: `bundled runtime is unreadable: ${err.message}` };
  }
  if (bundled.name !== PKG_NAME) {
    return { ok: false, reason: `bundle runtime root is ${bundled.name}, expected ${PKG_NAME}` };
  }
  const bundleDrift = factMismatch(stamp, bundled, "the bundled runtime");
  if (bundleDrift) {
    return { ok: false, reason: `the stamp does not describe the bundle — ${bundleDrift}` };
  }

  // (4) …and that runtime's compiled CLI must match its own sources. Hashed in
  // both directions, so neither an added nor a deleted file slips through.
  const bundledCli = verifyCliBundle({ root });
  if (!bundledCli.ok) {
    return {
      ok: false,
      reason: `the bundled runtime's dist-cli does not match its own sources: ${bundledCli.reason}`,
    };
  }

  // (5) The shell↔runtime contract. Unlike everything above, this one is a
  // fact about the tree being packaged, not about the bundle.
  if (stamp.shellApiVersion !== (pkg.libi && pkg.libi.shellApiVersion)) {
    return {
      ok: false,
      reason: `bundle shellApiVersion ${stamp.shellApiVersion}, package.json says ${String(pkg.libi && pkg.libi.shellApiVersion)}`,
    };
  }

  // (6) What "fresh" means depends on where the bundle came from.
  if (stamp.origin === "working-tree") {
    if (stamp.version !== pkg.version) {
      return {
        ok: false,
        reason: `bundle is ${PKG_NAME}@${stamp.version}, package.json says ${pkg.version}`,
      };
    }
    const treeCli = verifyCliBundle({ root: treeRoot });
    if (!treeCli.ok) {
      return { ok: false, reason: `dist-cli is stale: ${treeCli.reason}` };
    }
    let tree;
    try {
      tree = readRuntimeFacts(treeRoot);
    } catch (err) {
      return { ok: false, reason: `working tree is not built: ${err.message}` };
    }
    const treeDrift = factMismatch(stamp, tree, "the working tree");
    if (treeDrift) {
      return {
        ok: false,
        reason: `the bundle was packed from a different tree state — ${treeDrift}`,
      };
    }
  } else {
    // A registry bundle has no relationship to the working tree, so demanding
    // one would make the release path unusable. What IS knowable: npm handed
    // back the version that was asked for.
    if (typeof stamp.requestedVersion !== "string" || stamp.requestedVersion.length === 0) {
      return { ok: false, reason: "registry-origin stamp records no requestedVersion" };
    }
    if (stamp.version !== stamp.requestedVersion) {
      return {
        ok: false,
        reason: `bundle asked npm for ${PKG_NAME}@${stamp.requestedVersion} but installed ${stamp.version}`,
      };
    }
    // An explicit `--from-registry=<v>` is a deliberate pin, recorded in the
    // artifact; an implicit one must track package.json, or a version bump
    // would silently ship the previous runtime inside the new shell.
    if (!stamp.versionPinned && stamp.version !== pkg.version) {
      return {
        ok: false,
        reason: `bundle is the published ${PKG_NAME}@${stamp.version}, package.json says ${pkg.version} (re-run --from-registry, or pin explicitly with --from-registry=${stamp.version})`,
      };
    }
  }

  // (7) The ABI the native deps were resolved for.
  let abi;
  if (expectedAbi !== undefined) {
    abi = expectedAbi;
  } else {
    try {
      abi = electronAbi();
    } catch (err) {
      return { ok: false, reason: `could not read Electron's ABI: ${err.message}` };
    }
  }
  if (String(stamp.abi) !== String(abi)) {
    return {
      ok: false,
      reason: `bundle was built for NODE_MODULE_VERSION ${stamp.abi}, Electron is now ${abi}`,
    };
  }

  // (8) The licence position, re-checked on the artifact rather than trusted
  // from build time — this runs as electron-builder's `beforePack`, the last
  // gate before the bundle is copied into a signable app.
  const proprietary = findProprietaryDeps(target);
  if (proprietary.length > 0) {
    return {
      ok: false,
      reason:
        "LICENCE VIOLATION — the bundle contains code libi may not redistribute: " +
        proprietary.join(", "),
    };
  }

  // (9) The externals symlink farm must ALREADY exist, be relative, and
  // resolve. It is materialised at bundle-build time precisely so first boot
  // never writes into the signed .app; if it went missing (or was rebuilt with
  // absolute targets by something that bypassed `materializeNextExternals`),
  // the shipped app either dangles on the user's disk or tries to repair
  // itself inside its own read-only bundle. Both ship silently, so this is
  // checked on the artifact rather than assumed from the build having run.
  //
  // Ordered LAST deliberately. It is a "would this app work" check, while
  // (5)-(8) are "may we ship this at all" checks — an artifact that violates
  // the licence or targets the wrong ABI must report THAT, not a symlink
  // detail. Placing this earlier masked the licence gate outright.
  const farmDir = path.join(root, ".next", "node_modules");
  const farmLinks = farmSymlinks(farmDir);
  if (farmLinks.length === 0) {
    return {
      ok: false,
      reason:
        `bundle runtime has no Next.js externals symlink farm at ${path.relative(target, farmDir)} — ` +
        "every route that touches an externalised package would 500. Rebuild the bundle",
    };
  }
  for (const link of farmLinks) {
    const rel = path.relative(root, link);
    if (path.isAbsolute(fs.readlinkSync(link))) {
      return {
        ok: false,
        reason:
          `externals symlink ${rel} has an ABSOLUTE target — it points at this build machine ` +
          "and would dangle once the bundle is copied into Libi.app/Contents/Resources/",
      };
    }
    try {
      fs.realpathSync(link);
    } catch {
      return { ok: false, reason: `externals symlink ${rel} does not resolve` };
    }
  }

  return { ok: true, stamp };
}

/** `verifyRuntimeBundle`, but throws with an actionable message. */
function assertRuntimeBundleFresh(opts = {}) {
  const result = verifyRuntimeBundle(opts);
  if (!result.ok) {
    throw new Error(
      `[runtime-bundle] the bundled runtime snapshot is missing, stale, or not what its\n` +
        `   stamp claims — ${result.reason}.\n` +
        "   The packaged app has NOTHING to boot without it: the shell no longer ships\n" +
        "   lib/, app/, .next/ or node_modules.\n" +
        "   Rebuild with: npm run build:runtime-bundle\n" +
        "   …or, for a shell RELEASE, rebuild from the\n" +
        "   published runtime: node scripts/build-runtime-bundle.js --from-registry",
    );
  }
  return result;
}

/**
 * Fail the build if a prebuilt helper the product SPAWNS is not executable.
 *
 * `restorePrebuiltExecutables` sets these at install time; this is the check
 * that says so out loud. It exists because the failure it guards against is
 * invisible until a user clicks something: the app packages, signs, notarizes
 * and boots perfectly, and only the built-in Terminal is dead — with a bare
 * "posix_spawn failed." and no way to fix it, because the bundle is signed.
 *
 * That shipped. It was found in the v0.1.3 FULL verification, not by any gate.
 */
function assertPrebuiltExecutablesRunnable(outDir = path.join(ROOT, OUT_DIRNAME)) {
  const helperDir = path.join(outDir, "node_modules", "node-pty", "prebuilds");
  let entries;
  try {
    entries = fs.readdirSync(helperDir, { withFileTypes: true });
  } catch {
    return; // no node-pty prebuilds in this bundle — nothing to assert
  }
  const broken = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const helper = path.join(helperDir, e.name, "spawn-helper");
    try {
      if ((fs.statSync(helper).mode & 0o111) === 0) broken.push(helper);
    } catch {
      /* that platform's helper isn't present */
    }
  }
  if (broken.length > 0) {
    throw new Error(
      "[runtime-bundle] node-pty's spawn-helper is NOT executable in the bundle:\n" +
        broken.map((b) => `     ${b}`).join("\n") +
        "\n   node-pty posix_spawn()s it on every pty launch, so the built-in Terminal\n" +
        "   would be dead in the packaged app — and unfixable at runtime, because the\n" +
        "   .app is signed and chmod inside it is refused (EPERM).\n" +
        "   `restorePrebuiltExecutables` in this file is what sets the bit; if this\n" +
        "   fires, that ran too early, or npm added a prebuild it does not name yet.",
    );
  }
}

module.exports = {
  OUT_DIRNAME,
  STAMP_NAME,
  runtimeRootFor,
  readRuntimeFacts,
  factMismatch,
  buildRuntimeBundle,
  verifyRuntimeBundle,
  assertRuntimeBundleFresh,
  assertPrebuiltExecutablesRunnable,
  restorePrebuiltExecutables,
  electronAbi,
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  const verifyOnly = argv.includes("--verify");
  const fromRegistryArg = argv.find((a) => a === "--from-registry" || a.startsWith("--from-registry="));
  const registryArg = argv.find((a) => a.startsWith("--registry="));
  const fromRegistry = fromRegistryArg
    ? fromRegistryArg.includes("=")
      ? fromRegistryArg.split("=").slice(1).join("=")
      : true
    : null;
  const registry = registryArg ? registryArg.split("=").slice(1).join("=") : null;

  (async () => {
    try {
      if (!verifyOnly) await buildRuntimeBundle({ fromRegistry, registry });
      assertRuntimeBundleFresh();
      log("OK");
    } catch (err) {
      process.stderr.write(`\n❌ ${err && err.message ? err.message : err}\n\n`);
      process.exit(1);
    }
  })();
}
