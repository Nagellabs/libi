#!/usr/bin/env node
/**
 * Shared machinery for the local-registry harness (`docs-local/local-release-testing.md`).
 *
 * The harness publishes libi to a throwaway Verdaccio on loopback and installs
 * it back as a consumer would, so the publish → install → upgrade loop can be
 * exercised without ever touching public npm. It is the acceptance harness for
 * plan Tasks 8 (runtime loader) and 9 (update check).
 *
 * ── Three invariants this file exists to enforce ─────────────────────────────
 *
 * 1. **Nothing is ever published to public npm.** Every npm invocation gets an
 *    explicit `--registry` AND a scoped `npm_config_userconfig` pointing at a
 *    throwaway `.npmrc` in the scratch dir. The user's `~/.npmrc` is never read
 *    and never written, and no global npm config is mutated — a registry
 *    override that outlives the test is the exact footgun that eventually
 *    publishes something to the wrong place. The ONE exception is the
 *    bootstrap install of Verdaccio itself, which must come from public npm and
 *    is a read-only fetch.
 *
 * 2. **The repo's `package.json` is never mutated.** The harness publishes a
 *    STAGED COPY in the scratch dir, so the working tree is never touched and
 *    an interrupted run cannot change what a later real `npm publish` would
 *    ship. `assertRepoPkgUnmutated()` is the canary that proves it, and runs at
 *    both ends of every command. Until 2026-08-14 this was expressed as
 *    "`private: true` must still be set" — a proxy that stopped working the day
 *    that guard was deliberately removed for the first publish; see the
 *    function's own comment.
 *
 * 3. **Scratch stays out of the repo and out of `~/.libi`.** `~/.libi` holds
 *    real user work; the repo must stay clean. `resolveScratchDir()` refuses
 *    any location inside either.
 */
const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const path = require("node:path");
const { spawnSync, spawn } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const PKG_NAME = "@nagellabs/libi";

/** Verdaccio version pinned so the harness behaves the same next month. */
const VERDACCIO_VERSION = "6";

/** Public npm — used ONLY to fetch Verdaccio and to proxy third-party deps. */
const PUBLIC_REGISTRY = "https://registry.npmjs.org/";

/** Conventional Verdaccio port. Overridable; verified free before binding. */
const DEFAULT_PORT = 4873;

/**
 * Bind + address the registry on an explicit IPv4 loopback, never `localhost`.
 *
 * Verdaccio's default `--listen 4873` binds `localhost`, which on macOS
 * resolves to `::1` — so it listened on `[::1]:4873` while every IPv4 probe
 * and every npm request to `127.0.0.1` got ECONNREFUSED. Pinning both ends to
 * `127.0.0.1` removes the resolver from the equation entirely.
 */
const HOST = "127.0.0.1";

// ── Paths ────────────────────────────────────────────────────────────────────

function resolveScratchDir() {
  const raw =
    process.env.LIBI_LOCAL_REGISTRY_DIR ||
    path.join(os.tmpdir(), "libi-local-registry");
  const dir = path.resolve(raw);
  const libiHome = path.resolve(process.env.LIBI_HOME || path.join(os.homedir(), ".libi"));
  // Refuse to scribble into the developer's real libi home or the repo tree.
  if (dir === libiHome || dir.startsWith(libiHome + path.sep)) {
    fail(
      `scratch dir ${dir} is inside LIBI_HOME (${libiHome}).\n` +
        `That directory holds real user work. Set LIBI_LOCAL_REGISTRY_DIR elsewhere.`,
    );
  }
  if (dir === REPO_ROOT || dir.startsWith(REPO_ROOT + path.sep)) {
    fail(
      `scratch dir ${dir} is inside the repo (${REPO_ROOT}).\n` +
        `Harness artifacts must never land in the working tree. Set LIBI_LOCAL_REGISTRY_DIR elsewhere.`,
    );
  }
  return dir;
}

const SCRATCH = resolveScratchDir();

const paths = {
  repoRoot: REPO_ROOT,
  scratch: SCRATCH,
  storage: path.join(SCRATCH, "storage"),
  config: path.join(SCRATCH, "verdaccio.yaml"),
  npmrc: path.join(SCRATCH, "npmrc"),
  /** Deliberately a path that will never exist: blocks the machine-global npm config too. */
  globalNpmrc: path.join(SCRATCH, "npmrc-global-absent"),
  pidFile: path.join(SCRATCH, "verdaccio.pid"),
  logFile: path.join(SCRATCH, "verdaccio.log"),
  verdaccioPrefix: path.join(SCRATCH, "verdaccio-bin"),
  packDir: path.join(SCRATCH, "pack"),
  stageDir: path.join(SCRATCH, "stage"),
  consumerDir: path.join(SCRATCH, "consumer"),
};

function port() {
  const raw = process.env.LIBI_LOCAL_REGISTRY_PORT;
  const n = raw ? Number(raw) : DEFAULT_PORT;
  if (!Number.isInteger(n) || n < 1024 || n > 65535) {
    fail(`invalid LIBI_LOCAL_REGISTRY_PORT: ${raw}`);
  }
  return n;
}

function registryUrl() {
  return `http://${HOST}:${port()}/`;
}

// ── Output ───────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[local-registry] ${msg}`);
}

function step(msg) {
  console.log(`\n[local-registry] ── ${msg} ${"─".repeat(Math.max(0, 60 - msg.length))}`);
}

function fail(msg) {
  console.error(`\n[local-registry] FAILED: ${msg}\n`);
  process.exit(1);
}

// ── Invariant 2: the harness never mutates the repo's package.json ───────────

function readRepoPkg() {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
}

/** Bytes of the repo's package.json as first seen in THIS process. */
let repoPkgBaseline = null;

/**
 * The canary. Called at the start AND end of every entry point: if any step
 * ever mutates the checked-in package.json, the very next call says so loudly
 * instead of letting the harness quietly edit the file it is supposed to leave
 * alone.
 *
 * This used to assert `private === true` specifically. That worked only while
 * the package was unpublished, and it made the two halves of `release:npm`
 * contradict each other: its publish guard refuses to publish WITH the field,
 * and this check refused to run WITHOUT it, so the script could never complete
 * — discovered at the first real publish, 2026-08-14. `private: true` was
 * removed for that publish and is not coming back, so a check pinned to its
 * value now asserts a state that no longer exists.
 *
 * What actually needed protecting was never that one value: it was that the
 * harness publishes a STAGED COPY and leaves the working tree untouched, so an
 * interrupted run cannot alter what a later `npm publish` would ship. Comparing
 * the whole file against the bytes first seen in this process enforces exactly
 * that, and catches any mutation rather than only this one field.
 */
function assertRepoPkgUnmutated(when) {
  const raw = fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8");
  if (repoPkgBaseline === null) {
    repoPkgBaseline = raw;
    return;
  }
  if (raw !== repoPkgBaseline) {
    fail(
      `the repo's package.json changed while the harness was running (${when}).\n` +
        `This harness must publish a staged copy and leave the working tree\n` +
        `untouched — a mutation here changes what a real \`npm publish\` would ship.\n` +
        `Inspect it: git diff -- package.json`,
    );
  }
}

// ── npm invocation ───────────────────────────────────────────────────────────

/**
 * Write the scratch `.npmrc`. Scoping npm's userconfig here means the user's
 * `~/.npmrc` (and its auth tokens) is neither read nor written, and nothing we
 * set can outlive the process.
 */
function writeNpmrc() {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const host = `//${HOST}:${port()}/`;
  fs.writeFileSync(
    paths.npmrc,
    [
      `registry=${registryUrl()}`,
      // Verdaccio is configured for anonymous publish, but npm sends the token
      // when one is present and some npm versions insist on *a* credential.
      `${host}:_authToken=local-registry-harness`,
      "audit=false",
      "fund=false",
      "update-notifier=false",
      "",
    ].join("\n"),
  );
}

/**
 * Env for every npm child. `npm_config_userconfig` / `npm_config_globalconfig`
 * are process-scoped: nothing here can leak to the machine.
 */
function npmEnv(extra = {}) {
  const env = {
    ...process.env,
    npm_config_userconfig: paths.npmrc,
    npm_config_globalconfig: paths.globalNpmrc,
    npm_config_registry: registryUrl(),
    npm_config_update_notifier: "false",
    npm_config_audit: "false",
    npm_config_fund: "false",
    ...extra,
  };
  if (process.env.LIBI_LOCAL_REGISTRY_ISOLATED_CACHE === "1") {
    env.npm_config_cache = path.join(SCRATCH, "npm-cache");
  }
  return env;
}

/** Run a command, inheriting stdio. Fails the process on non-zero exit. */
function run(cmd, args, opts = {}) {
  const shown = [cmd, ...args].join(" ");
  log(`$ ${shown}`);
  const res = spawnSync(cmd, args, {
    stdio: "inherit",
    env: npmEnv(opts.env),
    cwd: opts.cwd || REPO_ROOT,
    shell: false,
  });
  if (res.error) fail(`${shown}: ${res.error.message}`);
  if (res.status !== 0) {
    if (opts.allowFailure) return res.status;
    fail(`${shown} exited ${res.status}`);
  }
  return 0;
}

/** Run a command and capture stdout. */
function capture(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    env: npmEnv(opts.env),
    cwd: opts.cwd || REPO_ROOT,
    shell: false,
  });
  if (res.error) fail(`${[cmd, ...args].join(" ")}: ${res.error.message}`);
  if (res.status !== 0 && !opts.allowFailure) {
    fail(
      `${[cmd, ...args].join(" ")} exited ${res.status}\n${res.stdout}\n${res.stderr}`,
    );
  }
  return { stdout: res.stdout || "", stderr: res.stderr || "", status: res.status };
}

// ── Port + liveness ──────────────────────────────────────────────────────────

function portInUse(p) {
  return new Promise((resolve) => {
    const socket = net.connect({ port: p, host: HOST });
    socket.setTimeout(700);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

async function registryResponds() {
  return new Promise((resolve) => {
    const http = require("node:http");
    const req = http.get(
      { host: HOST, port: port(), path: "/-/ping", timeout: 1500 },
      (res) => {
        res.resume();
        resolve((res.statusCode ?? 0) < 500);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Verdaccio ────────────────────────────────────────────────────────────────

/**
 * Verdaccio config.
 *
 * `max_body_size: 200mb` is NOT optional — libi's tarball ships a prebuilt
 * `.next` and the default limit rejects the publish with `413 Payload Too
 * Large` (Phase 0 spike, and reproduced here).
 *
 * The `@nagellabs/*` block has NO `proxy`: our own scope must never fall
 * through to public npm, so a typo cannot turn a local test into a public
 * fetch. Everything else proxies npmjs so a consumer install can resolve
 * libi's ~700 real dependencies.
 */
function verdaccioConfig() {
  return `# Generated by scripts/local-registry/lib.js — throwaway, safe to delete.
storage: ${JSON.stringify(paths.storage)}
uplinks:
  npmjs:
    url: ${PUBLIC_REGISTRY}
    maxage: 60m
    timeout: 60s
packages:
  '@nagellabs/*':
    access: $all
    publish: $all
    unpublish: $all
  '@*/*':
    access: $all
    publish: $all
    proxy: npmjs
  '**':
    access: $all
    publish: $all
    proxy: npmjs
publish:
  allow_offline: true
log:
  type: stdout
  format: pretty
  level: warn
# REQUIRED: libi's tarball is ~100MB+ (it ships a prebuilt .next).
# The Verdaccio default rejects it with 413 Payload Too Large.
max_body_size: 200mb
`;
}

function verdaccioBin() {
  return path.join(paths.verdaccioPrefix, "node_modules", ".bin", "verdaccio");
}

/**
 * Install Verdaccio into the scratch prefix (idempotent).
 *
 * This is the one command that talks to PUBLIC npm — a read-only fetch of the
 * registry server itself, which obviously cannot come from the registry it is
 * about to start. It bypasses the scratch `.npmrc` for that reason, and only
 * for that reason.
 */
function ensureVerdaccio() {
  if (fs.existsSync(verdaccioBin())) {
    log(`verdaccio already installed at ${paths.verdaccioPrefix}`);
    return;
  }
  step(`installing verdaccio@${VERDACCIO_VERSION} (from public npm — read-only)`);
  fs.mkdirSync(paths.verdaccioPrefix, { recursive: true });
  fs.writeFileSync(
    path.join(paths.verdaccioPrefix, "package.json"),
    JSON.stringify({ name: "libi-local-registry-host", private: true }, null, 2),
  );
  const res = spawnSync(
    "npm",
    [
      "install",
      `verdaccio@${VERDACCIO_VERSION}`,
      `--registry=${PUBLIC_REGISTRY}`,
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
    ],
    {
      stdio: "inherit",
      cwd: paths.verdaccioPrefix,
      // Fresh env: the scratch .npmrc points at a registry that isn't up yet.
      env: { ...process.env, npm_config_registry: PUBLIC_REGISTRY },
    },
  );
  if (res.status !== 0) fail("verdaccio install failed");
  if (!fs.existsSync(verdaccioBin())) fail(`verdaccio binary missing at ${verdaccioBin()}`);
}

function readPid() {
  try {
    const pid = Number(fs.readFileSync(paths.pidFile, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function startRegistry({ fresh = false } = {}) {
  fs.mkdirSync(SCRATCH, { recursive: true });

  if (await registryResponds()) {
    const pid = readPid();
    if (pid && pidAlive(pid)) {
      if (!fresh) {
        // Re-assert the scratch .npmrc: the registry can outlive its scratch
        // dir (a `registry:stop --keep`, a manual rm), and every npm child
        // below resolves its userconfig from that file.
        writeNpmrc();
        log(`registry already up on ${registryUrl()} (pid ${pid})`);
        return;
      }
      // Idempotence: a `--fresh` run must not depend on whether a previous run
      // left the server up. Recycle OUR server (we own this pid file), then
      // fall through to the storage wipe + restart below.
      log(`--fresh: recycling the running registry (pid ${pid})`);
      await stopRegistry();
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && (await portInUse(port()))) await sleep(200);
    } else {
      fail(
        `port ${port()} is already serving something that is not this harness.\n` +
          `Pick another with LIBI_LOCAL_REGISTRY_PORT=<n>.`,
      );
    }
  }
  if (await portInUse(port())) {
    fail(
      `port ${port()} is in use by another process.\n` +
        `Pick another with LIBI_LOCAL_REGISTRY_PORT=<n>.`,
    );
  }

  if (fresh && fs.existsSync(paths.storage)) {
    log(`wiping storage ${paths.storage}`);
    fs.rmSync(paths.storage, { recursive: true, force: true });
  }

  ensureVerdaccio();
  writeNpmrc();
  fs.mkdirSync(paths.storage, { recursive: true });
  fs.writeFileSync(paths.config, verdaccioConfig());

  step(`starting verdaccio on ${registryUrl()}`);
  const out = fs.openSync(paths.logFile, "a");
  const child = spawn(
    process.execPath,
    [verdaccioBin(), "--config", paths.config, "--listen", `${HOST}:${port()}`],
    {
      detached: true,
      stdio: ["ignore", out, out],
      cwd: SCRATCH,
      // Deliberately NOT npmEnv(): verdaccio is a server, not an npm client.
      env: { ...process.env },
    },
  );
  child.unref();
  fs.writeFileSync(paths.pidFile, String(child.pid));

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await registryResponds()) {
      log(`registry up: ${registryUrl()} (pid ${child.pid}, log ${paths.logFile})`);
      return;
    }
    if (!pidAlive(child.pid)) {
      fail(`verdaccio exited during startup. Log:\n${tailLog()}`);
    }
    await sleep(400);
  }
  fail(`verdaccio did not answer /-/ping within 60s. Log:\n${tailLog()}`);
}

function tailLog(lines = 40) {
  try {
    return fs.readFileSync(paths.logFile, "utf8").split("\n").slice(-lines).join("\n");
  } catch {
    return "(no log)";
  }
}

async function stopRegistry() {
  const pid = readPid();
  if (pid && pidAlive(pid)) {
    step(`stopping verdaccio (pid ${pid})`);
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && pidAlive(pid)) await sleep(200);
    if (pidAlive(pid)) {
      log("SIGTERM ignored, sending SIGKILL");
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* ignore */
      }
    }
  } else {
    log("no running verdaccio recorded");
  }
  try {
    fs.rmSync(paths.pidFile, { force: true });
  } catch {
    /* ignore */
  }
}

/** Full teardown: stop the server and delete every scratch artifact. */
async function teardown({ keep = false } = {}) {
  await stopRegistry();
  if (keep) {
    log(`--keep: leaving scratch at ${SCRATCH}`);
    return;
  }
  step(`removing scratch ${SCRATCH}`);
  fs.rmSync(SCRATCH, { recursive: true, force: true });
}

// ── Staging: pack the repo, strip `private`, publish the copy ────────────────

/**
 * `npm pack` the working tree and extract it to a staging dir.
 *
 * `npm pack` (NOT a hand-rolled copy) is the point: it runs `prepack`, which is
 * `clean-npm-pack-artifacts.js && build-cli.js`. A staged tree assembled any
 * other way could be missing `dist-cli/`, and the harness would then be
 * "verifying" an install that could never launch.
 */
function stagePackage() {
  assertRepoPkgUnmutated("before pack");
  step("npm pack (runs prepack → clean-artifacts + build-cli)");
  fs.rmSync(paths.packDir, { recursive: true, force: true });
  fs.mkdirSync(paths.packDir, { recursive: true });

  // Deliberately NOT `npm pack --json`: prepack's own console output (e.g.
  // "[build-cli] …") is interleaved on stdout, so no substring-from-the-first-
  // bracket parse is safe, and --json also dumps an entry for all ~3000 files.
  // The pack destination is emptied above, so reading the directory back is
  // both simpler and unambiguous.
  run("npm", ["pack", `--pack-destination=${paths.packDir}`, "--loglevel=warn"]);
  assertRepoPkgUnmutated("after pack");

  const produced = fs.readdirSync(paths.packDir).filter((f) => f.endsWith(".tgz"));
  if (produced.length !== 1) {
    fail(`expected exactly one tarball in ${paths.packDir}, found ${produced.length}`);
  }
  const tarball = path.join(paths.packDir, produced[0]);
  const sizeMb = (fs.statSync(tarball).size / 1e6).toFixed(1);
  log(`packed ${path.basename(tarball)} (${sizeMb} MB)`);

  step("extracting to staging copy");
  fs.rmSync(paths.stageDir, { recursive: true, force: true });
  fs.mkdirSync(paths.stageDir, { recursive: true });
  run("tar", ["-xzf", tarball, "-C", paths.stageDir, "--strip-components=1"]);

  // The whole reason a staged copy exists: strip the accidental-publish guard
  // HERE, never in the repo. An interrupted run leaves the repo untouched.
  const stagedPkgPath = path.join(paths.stageDir, "package.json");
  const stagedPkg = JSON.parse(fs.readFileSync(stagedPkgPath, "utf8"));
  delete stagedPkg.private;
  // The staged tree has no scripts/ — every lifecycle script would fail.
  // The tarball has already been through prepack, so this loses nothing.
  delete stagedPkg.scripts;
  fs.writeFileSync(stagedPkgPath, JSON.stringify(stagedPkg, null, 2) + "\n");

  assertStagedTreeIsReal(paths.stageDir);
  return paths.stageDir;
}

/**
 * Refuse to publish a tarball that would make the harness test a fiction.
 *
 * `dist-cli/` — without it an installed copy cannot launch at all (tsx refuses
 * tsconfig `paths` under node_modules; see `scripts/build-cli.js`).
 * `.next/BUILD_ID` — without it the consumer has no production server to boot.
 */
function assertStagedTreeIsReal(dir) {
  const required = [
    ["dist-cli/mcp/index.js", "the compiled MCP entry (prepack → build-cli.js did not run)"],
    ["dist-cli/lib/cli/studio.js", "the compiled CLI entry"],
    ["bin/libi.js", "the CLI bin"],
    [".next/BUILD_ID", "a production Next build (run `npm run build` first)"],
    [".next/server", "the Next server output"],
  ];
  const missing = required.filter(([rel]) => !fs.existsSync(path.join(dir, rel)));
  if (missing.length) {
    fail(
      "staged package is incomplete — publishing it would test a fiction:\n" +
        missing.map(([rel, why]) => `  - ${rel} — ${why}`).join("\n"),
    );
  }
  log("staged tree contains dist-cli/ + a production .next ✓");
}

/** Point the staged copy at a version, then publish it to the local registry. */
function publishStaged(stageDir, version) {
  const pkgPath = path.join(stageDir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  pkg.version = version;
  if (pkg.private) fail("staged package.json still marked private — refusing to publish");
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

  step(`publishing ${PKG_NAME}@${version} → ${registryUrl()}`);
  run(
    "npm",
    [
      "publish",
      // The tarball already went through prepack in the repo; the staged tree
      // has no scripts/ to run.
      "--ignore-scripts",
      `--registry=${registryUrl()}`,
      "--tag=latest",
      "--loglevel=warn",
    ],
    { cwd: stageDir },
  );
  assertRepoPkgUnmutated(`after publishing ${version}`);
  return version;
}

// ── Consumer install ─────────────────────────────────────────────────────────

function prepareConsumer() {
  fs.rmSync(paths.consumerDir, { recursive: true, force: true });
  fs.mkdirSync(paths.consumerDir, { recursive: true });
  fs.writeFileSync(
    path.join(paths.consumerDir, "package.json"),
    JSON.stringify({ name: "libi-registry-consumer", version: "1.0.0", private: true }, null, 2),
  );
  // A consumer-local .npmrc as well as the env, so a manual `npm` run inside
  // the staging prefix also points at the local registry.
  fs.writeFileSync(
    path.join(paths.consumerDir, ".npmrc"),
    `registry=${registryUrl()}\n`,
  );
  return paths.consumerDir;
}

function installConsumer(version, { ignoreScripts = false } = {}) {
  const dir = prepareConsumer();
  step(`consumer install ${PKG_NAME}@${version}`);
  const args = [
    "install",
    `${PKG_NAME}@${version}`,
    `--registry=${registryUrl()}`,
    "--no-audit",
    "--no-fund",
    "--loglevel=warn",
  ];
  if (ignoreScripts) args.push("--ignore-scripts");
  run("npm", args, { cwd: dir });
  return dir;
}

const installedDir = () =>
  path.join(paths.consumerDir, "node_modules", "@nagellabs", "libi");

/** Post-install assertions a consumer actually depends on. */
function assertConsumerInstall(version) {
  const dir = installedDir();
  if (!fs.existsSync(dir)) fail(`${PKG_NAME} not present in the consumer's node_modules`);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  if (pkg.version !== version) {
    fail(`consumer installed ${pkg.version}, expected ${version}`);
  }
  const mustExist = ["bin/libi.js", "dist-cli/mcp/index.js", ".next/BUILD_ID"];
  for (const rel of mustExist) {
    if (!fs.existsSync(path.join(dir, rel))) fail(`installed copy is missing ${rel}`);
  }
  // Shipping bin/libi.js is not the same as REGISTERING the `libi` command, and
  // only the second one makes `npx @nagellabs/libi` work — the primary way
  // users run libi. npm re-validates `bin` at publish time and drops entries it
  // rejects, so a package.json that reads fine here can still install with no
  // command at all: `"./bin/libi.js"` was silently dropped for its `./` prefix
  // until 2026-08-14, and this function passed anyway because the FILE was
  // present. Assert the field survived the round trip and that npm actually
  // linked it.
  if (pkg.bin?.libi !== "bin/libi.js") {
    fail(
      `the installed package.json#bin.libi is ${JSON.stringify(pkg.bin?.libi)}, expected "bin/libi.js".\n` +
        `npm rejects some spellings (a leading "./" among them) and drops the entry\n` +
        `at publish time, which leaves \`npx ${PKG_NAME}\` with nothing to run.`,
    );
  }
  const binLink = path.join(paths.consumerDir, "node_modules", ".bin", "libi");
  if (!fs.existsSync(binLink)) {
    fail(
      `npm did not link ${binLink} — the \`libi\` command is not installed,\n` +
        `so \`npx ${PKG_NAME}\` would fail even though bin/libi.js shipped.`,
    );
  }
  // The licence invariant, checked on a real registry install rather than on a
  // pack dry-run: the proprietary Claude adapter must never ship (see CLAUDE.md).
  const forbidden = [
    path.join(paths.consumerDir, "node_modules", "@anthropic-ai"),
    path.join(
      paths.consumerDir,
      "node_modules",
      "@agentclientprotocol",
      "claude-agent-acp",
    ),
  ];
  for (const p of forbidden) {
    if (fs.existsSync(p)) fail(`licence invariant broken: ${p} was installed`);
  }
  log(`consumer install verified: ${PKG_NAME}@${version} ✓  (no @anthropic-ai, no claude-agent-acp)`);
}

// ── Registry queries (what Task 9's update checker will call) ────────────────

/** A cwd that is guaranteed to exist — spawnSync reports a missing cwd as a
 *  misleading `spawnSync npm ENOENT`, which reads like "npm is not installed".
 *  Query from the consumer prefix when it exists (that is the client Task 9
 *  will run as), else from the scratch root. */
function queryCwd() {
  return fs.existsSync(paths.consumerDir) ? paths.consumerDir : SCRATCH;
}

function viewDistTagLatest() {
  const res = capture(
    "npm",
    ["view", PKG_NAME, "dist-tags.latest", `--registry=${registryUrl()}`],
    { cwd: queryCwd() },
  );
  return res.stdout.trim();
}

function viewVersions() {
  const res = capture(
    "npm",
    ["view", PKG_NAME, "versions", "--json", `--registry=${registryUrl()}`],
    { cwd: queryCwd() },
  );
  try {
    const parsed = JSON.parse(res.stdout);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

// ── Versioning for the rehearsal ─────────────────────────────────────────────

/** Repo version with the patch bumped `n` times: 0.1.0 → 0.1.1 → 0.1.2 … */
function bumpPatch(version, n = 1) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) fail(`cannot parse version ${version}`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + n}`;
}

function parseArgs(argv = process.argv.slice(2)) {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const positional = argv.filter((a) => !a.startsWith("--"));
  return { flags, positional, has: (f) => flags.has(f) };
}

module.exports = {
  PKG_NAME,
  PUBLIC_REGISTRY,
  paths,
  port,
  registryUrl,
  log,
  step,
  fail,
  run,
  capture,
  npmEnv,
  writeNpmrc,
  readRepoPkg,
  assertRepoPkgUnmutated,
  startRegistry,
  stopRegistry,
  teardown,
  tailLog,
  stagePackage,
  publishStaged,
  installConsumer,
  installedDir,
  assertConsumerInstall,
  viewDistTagLatest,
  viewVersions,
  bumpPatch,
  parseArgs,
  registryResponds,
};
