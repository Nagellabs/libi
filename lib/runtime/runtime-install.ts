// lib/runtime/runtime-install.ts
//
// Fetch a published `@nagellabs/libi` version and lay it down as a runtime
// snapshot the desktop shell can boot next launch:
//
//     <LIBI_HOME>/runtime/<version>/
//       .libi-runtime.json
//       node_modules/@nagellabs/libi/…
//
// The shell's loader (`electron/runtime-loader.ts`) prefers the newest valid
// directory there and falls back to the snapshot bundled inside the .app.
//
// ## Never mutate the running version
//
// Everything happens in a sibling temp directory and is renamed into place
// only once every check has passed. A failed or interrupted install leaves the
// currently-installed runtimes untouched, and the shell keeps booting whatever
// it booted yesterday. The stamp is written LAST, inside the temp dir, so a
// half-installed tree can never look valid to the loader even if the rename
// were somehow interrupted mid-way.
//
// ## The two independent network dependencies
//
// 1. **The npm registry** — the package and its ~775 dependencies.
// 2. **GitHub releases** — `better-sqlite3`'s prebuilt Electron binding, which
//    `prebuild-install` downloads from
//    `github.com/WiseLibs/better-sqlite3/releases`, NOT from npm. A corporate
//    proxy or a region that blocks GitHub fails here while npm works fine.
//
// They are reported separately (`failure.host`) so a user behind a proxy can
// self-diagnose instead of being told "something went wrong".
//
// ## Never fall back to a compile
//
// better-sqlite3's own install script is `prebuild-install || node-gyp rebuild`.
// The fallback half is unusable here: an end-user machine may have no compiler
// at all, and a *successful* compile would produce a binding for the wrong
// runtime anyway (this process is Electron; node-gyp would target the Node
// headers it can find). So the install runs with `--ignore-scripts` and drives
// `prebuild-install` itself, with no fallback. If the prebuild cannot be
// fetched, the install FAILS and the caller keeps the bundled runtime.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { serverLogger as logger } from "@/lib/logger";
import { getLibiHome } from "@/lib/libi-home";
import {
  resolveVendoredNpmCli,
  runNpmViaUtilityProcess,
  selectNpmRunner,
} from "@/lib/install/npm-root";
import { buildSpawnEnv } from "@/mcp/registry/spawn-env";
import { resolveNodeCommand } from "@/lib/runtime/node-runtime";
import { PUBLIC_NPM_REGISTRY } from "@/lib/runtime/registry-url";
import { looksUnreachable } from "@/lib/runtime/network-errors";
import {
  NODE_ABI_SIDECAR_MAJORS,
  betterSqliteModuleDir,
  sidecarDirName,
} from "@/lib/runtime/node-abi-sidecars";
import { ensureNextExternalSymlinks } from "@/lib/install/next-externals";
// Deliberately does NOT import `@/lib/runtime/shell-api`. That module exists to
// be loaded BY THE SHELL out of a runtime snapshot, and its graph reaches
// `next` itself — pulling it into a module a Next route will call (Task 9's
// update-install endpoint) would drag the framework into its own bundle.

const execFileAsync = promisify(execFile);

export const RUNTIME_PACKAGE = "@nagellabs/libi";
export const RUNTIME_STAMP_FILE = ".libi-runtime.json";
export const USER_RUNTIME_DIRNAME = "runtime";
/** Where `prebuild-install` fetches native prebuilds from. Named in errors. */
export const PREBUILD_HOST = "github.com";

const NPM_TIMEOUT_MS = 15 * 60 * 1000;
const PREBUILD_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const LOG_TAG = "runtime-install";

/** Which of the two independent network dependencies failed. */
export type RuntimeInstallFailureKind =
  | "registry-unreachable"
  | "prebuild-unreachable"
  | "verification-failed"
  | "unknown";

export class RuntimeInstallError extends Error {
  readonly kind: RuntimeInstallFailureKind;
  /** The host to NAME in a user-facing message, when one is knowable. */
  readonly host: string | null;

  constructor(kind: RuntimeInstallFailureKind, message: string, host: string | null = null) {
    super(message);
    this.name = "RuntimeInstallError";
    this.kind = kind;
    this.host = host;
  }
}

export interface InstallRuntimeOptions {
  /** The published version to install, e.g. `"0.1.1"`. */
  version: string;
  /** Registry to fetch from. Use `resolveRegistryUrl()` — never a raw env read. */
  registryUrl?: string;
  /** Electron version to fetch native prebuilds for, e.g. `"36.9.5"`. */
  electronVersion: string;
  /** `process.versions.modules` of the process that will RUN the runtime. */
  abi: string;
  /** Override for tests. Defaults to `<LIBI_HOME>/runtime`. */
  runtimeRootDir?: string;
  onProgress?: (message: string) => void;
}

export interface InstalledRuntime {
  prefix: string;
  root: string;
  version: string;
  shellApiVersion: number;
  abi: string;
}

/** `<LIBI_HOME>/runtime` — where fetched snapshots live. */
export function userRuntimeDir(): string {
  return path.join(getLibiHome(), USER_RUNTIME_DIRNAME);
}

/** `<prefix>/node_modules/@nagellabs/libi`. Mirrors the loader's helper. */
export function runtimeRootFor(prefix: string): string {
  return path.join(prefix, "node_modules", ...RUNTIME_PACKAGE.split("/"));
}

/** Hostname of a registry URL, for user-facing messages. Falls back to the raw string. */
export function registryHost(registryUrl: string): string {
  try {
    return new URL(registryUrl).host;
  } catch {
    return registryUrl;
  }
}

async function runNpm(
  npmCli: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  const env = buildSpawnEnv();
  if (selectNpmRunner() === "electron-utility-process") {
    return await runNpmViaUtilityProcess(npmCli, args, {
      cwd,
      env,
      timeoutMs: NPM_TIMEOUT_MS,
    });
  }
  return await execFileAsync(process.execPath, [npmCli, ...args], {
    cwd,
    env: { ...env, ELECTRON_RUN_AS_NODE: "1" } as unknown as NodeJS.ProcessEnv,
    timeout: NPM_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: MAX_CAPTURE_BYTES,
  });
}

/**
 * Install `version` into `<LIBI_HOME>/runtime/<version>/`, ABI-resolved and
 * verified. Returns the installed descriptor, or throws `RuntimeInstallError`.
 *
 * Idempotent-ish: an existing directory for the same version is replaced only
 * on success (the temp dir is renamed over it), so a re-run after a failure
 * cannot leave the user worse off than before.
 */
export async function installRuntime(
  opts: InstallRuntimeOptions,
): Promise<InstalledRuntime> {
  const registryUrl = opts.registryUrl ?? PUBLIC_NPM_REGISTRY;
  const baseDir = opts.runtimeRootDir ?? userRuntimeDir();
  const prefix = path.join(baseDir, opts.version);
  const tmp = path.join(baseDir, `.tmp-${opts.version}-${process.pid}-${Date.now()}`);
  const progress = opts.onProgress ?? (() => {});

  fs.mkdirSync(baseDir, { recursive: true });
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });

  try {
    // ── 1. npm ────────────────────────────────────────────────────────────
    fs.writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify(
        {
          name: "libi-runtime",
          version: "0.0.0",
          private: true,
          description:
            "Generated by lib/runtime/runtime-install.ts — a fetched @nagellabs/libi runtime snapshot. Do not edit.",
        },
        null,
        2,
      ) + "\n",
    );

    const npmCli = resolveVendoredNpmCli();
    // `--ignore-scripts` is both the supply-chain posture libi already applies
    // to every managed npm root (RC-E) and what keeps better-sqlite3's
    // `prebuild-install || node-gyp rebuild` from ever reaching its compile
    // fallback. The ABI is resolved explicitly in step 2 instead.
    const args = [
      "install",
      `${RUNTIME_PACKAGE}@${opts.version}`,
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      `--registry=${registryUrl}`,
    ];
    progress(`Downloading libi ${opts.version}…`);
    logger.info(
      { tag: LOG_TAG, op: "npm_install_start", version: opts.version, registryUrl },
      "installing runtime snapshot",
    );
    try {
      await runNpm(npmCli, args, tmp);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (looksUnreachable(message)) {
        throw new RuntimeInstallError(
          "registry-unreachable",
          `Could not reach the npm registry (${registryHost(registryUrl)}): ${message}`,
          registryHost(registryUrl),
        );
      }
      throw new RuntimeInstallError("unknown", `npm install failed: ${message}`);
    }

    const root = runtimeRootFor(tmp);
    if (!fs.existsSync(root)) {
      throw new RuntimeInstallError(
        "verification-failed",
        `npm install produced no runtime root at ${root}`,
      );
    }

    // ── 2. the native ABI, BOTH interpreters ──────────────────────────────
    // Order matters and is the same as `scripts/build-runtime-bundle.js`: the
    // per-Node-major sidecars first, then the Electron prebuild LAST so the
    // default `build/Release` ends up Electron's — the in-process Next server
    // must keep loading it with no lookup at all.
    progress("Preparing the database engine…");
    await fetchNodeAbiSidecars({ prefix: tmp });
    await fetchElectronPrebuild({ prefix: tmp, electronVersion: opts.electronVersion });

    // ── 3. verify what we just built ──────────────────────────────────────
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf-8"),
    ) as { name?: string; version?: string; libi?: { shellApiVersion?: number } };
    const shellApiVersion = manifest.libi?.shellApiVersion;
    if (manifest.name !== RUNTIME_PACKAGE || !Number.isInteger(shellApiVersion)) {
      throw new RuntimeInstallError(
        "verification-failed",
        `installed package is ${String(manifest.name)}@${String(manifest.version)} with shellApiVersion ${String(shellApiVersion)}`,
      );
    }
    for (const rel of ["dist-cli/lib/runtime/shell-api.js", ".next/BUILD_ID"]) {
      if (!fs.existsSync(path.join(root, rel))) {
        throw new RuntimeInstallError(
          "verification-failed",
          `the downloaded runtime is missing ${rel}`,
        );
      }
    }

    // Rebuild the Turbopack externals symlink farm that `npm pack` strips out
    // of every published tarball. Done HERE, while the tree is still `tmp` and
    // an install failure is something the user is watching, rather than at the
    // next boot: a runtime that reaches `startNextServer` without the farm
    // binds its port and then 500s every route, which reads like a libi bug
    // rather than a bad download. (Unlike the bundled snapshot inside the .app,
    // this prefix IS writable — so boot could repair it. It still shouldn't
    // have to, and finding out now means `installRuntime` can fail honestly
    // instead of handing the loader a runtime it will later reject.)
    try {
      ensureNextExternalSymlinks(path.join(root, ".next"));
    } catch (err) {
      throw new RuntimeInstallError(
        "verification-failed",
        `the downloaded runtime's Next.js externals could not be restored: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // ── 4. stamp LAST, then swap ──────────────────────────────────────────
    fs.writeFileSync(
      path.join(tmp, RUNTIME_STAMP_FILE),
      JSON.stringify(
        {
          package: RUNTIME_PACKAGE,
          version: manifest.version,
          shellApiVersion,
          abi: opts.abi,
          electronVersion: opts.electronVersion,
          source: "fetched",
          installedAt: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
    );

    // Replace atomically-ish: move any previous copy aside first so the rename
    // itself cannot fail on a non-empty target, then delete the old one.
    const displaced = fs.existsSync(prefix) ? `${prefix}.old-${Date.now()}` : null;
    if (displaced) fs.renameSync(prefix, displaced);
    fs.renameSync(tmp, prefix);
    if (displaced) fs.rmSync(displaced, { recursive: true, force: true });

    logger.info(
      {
        tag: LOG_TAG,
        op: "install_done",
        version: manifest.version,
        shellApiVersion,
        abi: opts.abi,
        prefix,
      },
      "runtime snapshot installed",
    );
    return {
      prefix,
      root: runtimeRootFor(prefix),
      version: manifest.version!,
      shellApiVersion: shellApiVersion!,
      abi: opts.abi,
    };
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    const wrapped =
      err instanceof RuntimeInstallError
        ? err
        : new RuntimeInstallError(
            "unknown",
            err instanceof Error ? err.message : String(err),
          );
    logger.warn(
      { tag: LOG_TAG, op: "install_failed", kind: wrapped.kind, host: wrapped.host },
      wrapped.message,
    );
    throw wrapped;
  }
}

/**
 * Locate `prebuild-install`'s CLI inside a freshly-installed prefix, and the
 * better-sqlite3 module dir it must run in. Shared by both fetch steps so they
 * can never disagree about where either lives.
 */
function resolvePrebuildTools(prefix: string): { moduleDir: string; bin: string } {
  const moduleDir = betterSqliteModuleDir(prefix);
  if (!fs.existsSync(moduleDir)) {
    throw new RuntimeInstallError(
      "verification-failed",
      `better-sqlite3 is not present in the downloaded runtime (${moduleDir})`,
    );
  }
  const candidates = [
    path.join(prefix, "node_modules", "prebuild-install", "bin.js"),
    path.join(moduleDir, "node_modules", "prebuild-install", "bin.js"),
  ];
  const bin = candidates.find((p) => fs.existsSync(p));
  if (!bin) {
    throw new RuntimeInstallError(
      "verification-failed",
      "prebuild-install is missing from the downloaded runtime, so the native database " +
        "binding cannot be resolved without compiling — which libi will not do.",
    );
  }
  return { moduleDir, bin };
}

/**
 * Fetch a PLAIN-NODE better-sqlite3 binding per supported major and park it at
 * `build/Release-node-<major>/better_sqlite3.node`.
 *
 * ── Why an in-app update needs this at all ────────────────────────────────
 * This step existed only in `scripts/build-runtime-bundle.js`, so the bundled
 * snapshot inside the .app had sidecars and every runtime fetched by the
 * in-app updater had none. Because the install runs `--ignore-scripts` and
 * better-sqlite3's published tarball ships sources only (no `build/`, no
 * `prebuilds/`, and it uses `bindings` rather than `node-gyp-build`, so there
 * is no in-tarball fallback), `build/` did not exist AT ALL until the Electron
 * fetch created it — one binding, for the wrong interpreter.
 *
 * What made that a release blocker rather than a bug: the loader's native
 * probe (gate 6) dlopens the binding INSIDE the Electron process, where the
 * Electron binding is exactly right, so the broken runtime validated cleanly
 * and — being newer than the bundled snapshot — shadowed a working runtime on
 * every subsequent boot. The user saw a healthy app whose every DB-backed
 * `libi.*` tool died at first agent use, with nothing naming the cause.
 *
 * Fail-if-zero mirrors the bundle script: a runtime with no Node binding at
 * all is not one libi will hand to the loader.
 */
export async function fetchNodeAbiSidecars(opts: { prefix: string }): Promise<number[]> {
  const { moduleDir, bin } = resolvePrebuildTools(opts.prefix);
  const buildDir = path.join(moduleDir, "build");
  const defaultBinding = path.join(buildDir, "Release", "better_sqlite3.node");
  const fetched: number[] = [];

  for (const major of NODE_ABI_SIDECAR_MAJORS) {
    try {
      await execFileAsync(
        resolveNodeCommand(),
        [bin, "--runtime=node", `--target=${major}.0.0`],
        {
          cwd: moduleDir,
          windowsHide: true,
          env: buildSpawnEnv() as unknown as NodeJS.ProcessEnv,
          timeout: PREBUILD_TIMEOUT_MS,
          maxBuffer: MAX_CAPTURE_BYTES,
        },
      );
    } catch {
      // Non-fatal per major — better-sqlite3 genuinely publishes no prebuild
      // for some (today: 20). The artifact check below is the real test.
    }
    if (!fs.existsSync(defaultBinding)) {
      logger.warn(
        { tag: LOG_TAG, op: "sidecar_skipped", major },
        "no better-sqlite3 prebuild for this node major",
      );
      continue;
    }
    const destDir = path.join(buildDir, sidecarDirName(major));
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(defaultBinding, path.join(destDir, "better_sqlite3.node"));
    fetched.push(major);
  }

  // The Electron fetch runs next and rewrites build/Release. Clearing it here
  // keeps that ordering honest: if the Electron fetch fails, the install dies
  // with no default binding rather than leaving the LAST NODE one sitting
  // under the Electron name, where the in-process server would load it.
  fs.rmSync(defaultBinding, { force: true });

  if (fetched.length === 0) {
    throw new RuntimeInstallError(
      "prebuild-unreachable",
      `Could not download a Node database binding from ${PREBUILD_HOST} for any ` +
        `supported Node version (${NODE_ABI_SIDECAR_MAJORS.join(", ")}). libi's ` +
        `agent tools run in a separate Node process, so this runtime would boot ` +
        `a working window in which none of them can reach the database.`,
      PREBUILD_HOST,
    );
  }
  logger.info(
    { tag: LOG_TAG, op: "sidecars_fetched", majors: fetched },
    "parked plain-node better-sqlite3 bindings",
  );
  return fetched;
}

/**
 * Fetch `better-sqlite3`'s prebuilt binding for Electron's ABI. Never compiles.
 *
 * The mechanism is the one Phase 0's spike verified end-to-end:
 * `prebuild-install --runtime=electron --target=<v> --dist-url=https://electronjs.org/headers`,
 * which for Electron 36.9.5 (ABI 135) has published prebuilds for all seven
 * platform/arch combinations libi targets.
 */
export async function fetchElectronPrebuild(opts: {
  prefix: string;
  electronVersion: string;
}): Promise<void> {
  const { moduleDir, bin } = resolvePrebuildTools(opts.prefix);

  const nodeArgs = [
    bin,
    "--runtime=electron",
    `--target=${opts.electronVersion}`,
    "--dist-url=https://electronjs.org/headers",
  ];
  const binding = path.join(moduleDir, "build", "Release", "better_sqlite3.node");
  try {
    // ── Why a REAL node binary, and NOT `utilityProcess` like npm ──────────
    //
    // This ran under plain Node when it was written and hung for the full
    // 300s timeout the first time it executed inside the packaged app.
    // Measured cause (reproduced with a two-child Electron harness): an
    // Electron `utilityProcess` child's event loop is held open by the
    // parent↔child MessagePort, so a CLI that simply falls off the end of its
    // script NEVER EXITS. A child calling `process.exit(0)` exited in 61ms;
    // an otherwise identical child that did not was still alive when the
    // harness killed it. `process.parentPort.close()` is not a function in
    // this Electron, so the child cannot release the handle itself either.
    //
    // npm survives that because npm's CLI exits explicitly. `prebuild-install`
    // does not — so under `utilityProcess` it downloaded the binding
    // correctly and then sat there until libi killed it and reported a
    // github.com failure that had not happened.
    //
    // `resolveNodeCommand()` is libi's existing answer for exactly this
    // shape of problem (see `lib/runtime/node-runtime.ts`): a Node program
    // that must be spawned from a process whose `execPath` is the Electron
    // binary with `runAsNode` fused off. It returns `<LIBI_HOME>/bin/node`
    // when Category A provisioned one, else bare `node` from PATH — and under
    // plain Node it is equally correct, so this is now ONE path for both
    // runtimes instead of a branch where only half was ever exercised.
    await execFileAsync(resolveNodeCommand(), nodeArgs, {
      cwd: moduleDir,
      windowsHide: true,
      env: buildSpawnEnv() as unknown as NodeJS.ProcessEnv,
      timeout: PREBUILD_TIMEOUT_MS,
      maxBuffer: MAX_CAPTURE_BYTES,
    });
  } catch (err) {
    // The artifact is the truth, not the exit status. A prebuild that landed
    // on disk before the child misbehaved is a usable prebuild, and failing
    // the whole ~1GB install over a spawn quirk would be the wrong call.
    if (fs.existsSync(binding)) {
      logger.warn(
        {
          tag: LOG_TAG,
          op: "prebuild_command_failed_artifact_ok",
          err: err instanceof Error ? err.message : String(err),
        },
        "prebuild-install did not exit cleanly but the binding is present",
      );
    } else {
      const message = err instanceof Error ? err.message : String(err);
      throw new RuntimeInstallError(
        "prebuild-unreachable",
        `Could not download the native database binding from ${PREBUILD_HOST}: ${message}`,
        PREBUILD_HOST,
      );
    }
  }

  if (!fs.existsSync(binding)) {
    throw new RuntimeInstallError(
      "prebuild-unreachable",
      `prebuild-install reported success but ${binding} is missing`,
      PREBUILD_HOST,
    );
  }
}

/**
 * The user-facing sentence for a failed runtime install.
 *
 * **This is only ever shown when the install was REQUIRED.** A background
 * update check that cannot reach the network while a working runtime is
 * already on disk must stay silent (or say "couldn't check for updates") —
 * telling that user libi "cannot be installed" would be false, and the plan's
 * three-outcome table exists precisely to stop the three cases collapsing into
 * one message.
 */
export function describeRuntimeInstallFailure(err: RuntimeInstallError): string {
  if (err.host) {
    return `Libi can't finish installing — ${err.host} is unreachable. Check your connection or proxy.`;
  }
  return `Libi can't finish installing — ${err.message}`;
}
