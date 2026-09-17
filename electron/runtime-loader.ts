// electron/runtime-loader.ts
//
// Decide WHICH copy of the libi runtime this shell is going to run, validate it
// before executing any of it, and load its `shell-api` module.
//
// ## The model
//
// The desktop shell is a thin Electron host. The product — `.next`, `lib/`,
// `mcp/`, every dependency — is the published npm package `@nagellabs/libi`,
// shipped as an *installed* snapshot inside the .app at
// `Contents/Resources/libi-bundle/` and, once a newer one has been fetched,
// at `<LIBI_HOME>/runtime/<version>/`.
//
// Resolution order:
//
//   1. `<LIBI_HOME>/runtime/<version>/` — newest valid version first
//   2. the bundled snapshot at `<resourcesPath>/libi-bundle/`
//
// **Offline always works.** Nothing in this file touches the network. A fetched
// runtime is consumed only if it is already on disk and passes every gate; the
// bundled snapshot is the floor, and it is present in every artifact.
//
// ## Layout
//
// A "runtime prefix" is an npm install prefix. The package itself sits at
// `<prefix>/node_modules/@nagellabs/libi` (the "runtime root") with its
// dependencies hoisted to `<prefix>/node_modules/`, exactly as npm produced
// them. A stamp file at `<prefix>/.libi-runtime.json` records what the
// installer verified.
//
//     <prefix>/
//       .libi-runtime.json
//       node_modules/
//         @nagellabs/libi/        ← runtime root: .next, dist-cli, lib, mcp, …
//         better-sqlite3/ next/ … ← its dependencies
//
// ## Why validation happens BEFORE anything is executed
//
// A runtime that boots halfway is worse than one that never loads: the app
// opens, the user starts working, and the first DB call dies with
// `NODE_MODULE_VERSION 137 vs 135`. So every gate below is a static file/JSON
// read, in this order, and the FIRST failure rejects the candidate:
//
//   1. stamp present + parseable, and names `@nagellabs/libi`
//   2. stamp's recorded native ABI == this process's `process.versions.modules`
//   3. stamp's `shellApiVersion` inside this shell's supported range
//   4. runtime root's `package.json` agrees with the stamp (name, version and
//      `libi.shellApiVersion`) — a stamp is a claim, package.json is the
//      artifact; a disagreement means someone edited one of them
//   5. `dist-cli/lib/runtime/shell-api.js` and `.next/BUILD_ID` exist
//   6. at least one `better-sqlite3/build/Release-node-*` sidecar binding —
//      the MCP child is a separate REAL node process, and gate 7 (which runs
//      in-process, under Electron) cannot see whether it has a binding
//   7. the REAL ABI probe: `require()` the runtime's own `better-sqlite3`
//      binding inside a try/catch. Node throws a clean, catchable Error on an
//      ABI mismatch, so this is a true test rather than a promise — the stamp
//      in gate 2 is only the cheap pre-filter for it.
//   8. the runtime is not OLDER than the database on disk — see
//      `lib/runtime/db-schema-version.ts`. Downgrade is a designed path here
//      (runtime-prune keeps the previous version precisely so gate 2 can fall
//      back to it), and since migration 0051 an older runtime meeting a newer
//      database is a fatal boot failure, not a degradation
//   9. load `shell-api.js` and check its `SHELL_API_VERSION` matches the stamp
//
// Only after all nine does the shell hand control to the runtime.
//
// ## Dev
//
// In a dev checkout there is no runtime snapshot and no registry — the working
// tree IS the runtime, Next runs as a separate process (`npm run dev:electron`),
// and this shell is a window host. `resolveRuntime` therefore returns
// `null` for an unpackaged app and the shell degrades explicitly: crash
// reporting falls back to the durable sync log, which is the same posture
// `lib/sentry/native-crash.ts` already documents for a crash that happens
// before the Next runtime boots.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

// TYPE-ONLY. Erased at build time — importing the real module here would drag
// the entire runtime graph (and its `next` / `pino` / `@sentry/node` requires)
// back into the shell bundle, which is the exact coupling this file removes.
import type * as ShellApiModule from "../lib/runtime/shell-api";
// VALUE import, and safe: `network-errors.ts` is dependency-free (no imports at
// all), so esbuild inlines that single file and the shell gains no runtime
// dependency. Sharing it is what keeps the support contact from drifting
// between the splash's fatal screen and Category A's install hints.
import { SUPPORT_LINE } from "../lib/runtime/network-errors";
// VALUE import, and safe for the same reason: `node-abi-sidecars.ts` imports
// nothing but `node:fs` / `node:path`, so esbuild inlines it without pulling
// any runtime dependency into the shell.
import { sidecarMajorsInPrefix } from "../lib/runtime/node-abi-sidecars";
// VALUE import, same contract again: `db-schema-version.ts` imports only
// `node:fs` / `node:path`. It reads SQLite's `user_version` header field with
// plain `fs`, which is the whole reason gate 8 can exist — the shell has no
// better-sqlite3 binding until it has picked a runtime, and picking one is the
// question.
import {
  isDbSchemaTooNew,
  migrationsFolderIn,
  readDbSchemaVersion,
  readRuntimeSchemaVersion,
} from "../lib/runtime/db-schema-version";

/** The published package the shell knows how to run. */
export const RUNTIME_PACKAGE = "@nagellabs/libi";

/**
 * The `SHELL_API_VERSION` range this shell can drive. See
 * `lib/runtime/shell-api.ts` for the bump rules.
 *
 * A runtime below MIN is older than this shell's expectations; a runtime above
 * MAX needs a newer desktop app. Both are rejected in favour of the bundled
 * snapshot rather than loaded and hoped for.
 */
export const MIN_SHELL_API_VERSION = 1;
export const MAX_SHELL_API_VERSION = 1;

/** Stamp written by the installer at the prefix root. */
export const RUNTIME_STAMP_FILE = ".libi-runtime.json";
/** The single module the shell loads out of a runtime, relative to its root. */
export const SHELL_API_ENTRY = "dist-cli/lib/runtime/shell-api.js";
/** Directory under LIBI_HOME holding fetched runtimes, one dir per version. */
export const USER_RUNTIME_DIRNAME = "runtime";
/** Directory name of the bundled snapshot under `resourcesPath`. */
export const BUNDLED_RUNTIME_DIRNAME = "libi-bundle";
/**
 * The database file under LIBI_HOME, for gate 8.
 *
 * Duplicates `getLibiDbPath()` (lib/libi-home.ts) by necessity: the gate runs
 * before a runtime has been chosen, so the module that owns this name cannot
 * be loaded yet. `__tests__/unit/electron/runtime-loader.test.ts` pins the two
 * together.
 */
export const LIBI_DB_FILENAME = "libi.sqlite";

/** What the installer recorded about a runtime prefix. */
export interface RuntimeStamp {
  /** Always `@nagellabs/libi`. Guards against pointing at some other tree. */
  package: string;
  version: string;
  shellApiVersion: number;
  /** `process.versions.modules` the native deps were resolved for. */
  abi: string;
  /** Electron version the prebuilds were fetched for. Informational. */
  electronVersion?: string;
  installedAt?: string;
  /** `"bundled"` (built into the .app) or `"fetched"` (npm at runtime). */
  source?: string;
}

export type RuntimeRejectReason =
  | "prefix-missing"
  | "stamp-missing"
  | "stamp-unparseable"
  | "stamp-wrong-package"
  | "abi-mismatch"
  | "api-too-old"
  | "api-too-new"
  | "api-not-an-integer"
  | "root-missing"
  | "root-manifest-unreadable"
  | "root-disagrees-with-stamp"
  | "shell-api-missing"
  | "next-build-missing"
  | "node-sidecars-missing"
  | "native-probe-failed"
  | "db-schema-too-new"
  | "shell-api-load-failed"
  | "shell-api-version-disagrees";

export interface RuntimeInspection {
  prefix: string;
  root: string;
  ok: boolean;
  reason?: RuntimeRejectReason;
  /** Human-readable amplification of `reason`, safe to log. */
  detail?: string;
  version?: string;
  shellApiVersion?: number;
}

export interface InspectOptions {
  /** `process.versions.modules` of the process that will run the runtime. */
  abi: string;
  minApiVersion?: number;
  maxApiVersion?: number;
  /**
   * Run gate 6 (dlopen the runtime's `better-sqlite3`). Default true. Tests
   * that build synthetic prefixes turn it off; production never should.
   */
  probeNative?: boolean;
  /**
   * The database gate 8 compares against, normally `<LIBI_HOME>/libi.sqlite`.
   * Omitted (or pointing at no file yet) skips the gate — a first run has no
   * database and therefore no opinion about which runtime may read it.
   */
  dbPath?: string;
}

export type ShellApi = typeof ShellApiModule;

export interface LoadedRuntime {
  /** The npm install prefix. */
  prefix: string;
  /** `<prefix>/node_modules/@nagellabs/libi` — Next's `dir`, and the cwd. */
  root: string;
  version: string;
  shellApiVersion: number;
  source: "bundled" | "user";
  api: ShellApi;
}

/** `<prefix>/node_modules/@nagellabs/libi`. */
export function runtimeRootFor(prefix: string): string {
  return path.join(prefix, "node_modules", ...RUNTIME_PACKAGE.split("/"));
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function exists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Gates 1–7. Static reads plus the native ABI probe; never loads runtime JS.
 *
 * Returns `ok: false` with a machine-readable `reason` rather than throwing —
 * every candidate is expected to be rejectable, and the caller logs the reason
 * and moves on to the next one.
 */
export function inspectRuntimePrefix(
  prefix: string,
  opts: InspectOptions,
): RuntimeInspection {
  const root = runtimeRootFor(prefix);
  const min = opts.minApiVersion ?? MIN_SHELL_API_VERSION;
  const max = opts.maxApiVersion ?? MAX_SHELL_API_VERSION;
  const base: RuntimeInspection = { prefix, root, ok: false };

  if (!isDir(prefix)) {
    return { ...base, reason: "prefix-missing", detail: prefix };
  }

  // ── 1. stamp ────────────────────────────────────────────────────────────
  const stampPath = path.join(prefix, RUNTIME_STAMP_FILE);
  if (!exists(stampPath)) {
    return { ...base, reason: "stamp-missing", detail: stampPath };
  }
  let stamp: RuntimeStamp;
  try {
    stamp = readJson(stampPath) as RuntimeStamp;
  } catch (err) {
    return {
      ...base,
      reason: "stamp-unparseable",
      detail: `${stampPath}: ${(err as Error).message}`,
    };
  }
  if (!stamp || stamp.package !== RUNTIME_PACKAGE) {
    return {
      ...base,
      reason: "stamp-wrong-package",
      detail: `expected ${RUNTIME_PACKAGE}, stamp says ${String(stamp?.package)}`,
    };
  }

  // ── 2. native ABI (cheap pre-filter for gate 6) ─────────────────────────
  if (String(stamp.abi) !== String(opts.abi)) {
    return {
      ...base,
      version: stamp.version,
      reason: "abi-mismatch",
      detail: `runtime built for NODE_MODULE_VERSION ${stamp.abi}, this process is ${opts.abi}`,
    };
  }

  // ── 3. shell API version ────────────────────────────────────────────────
  const api = stamp.shellApiVersion;
  if (typeof api !== "number" || !Number.isInteger(api)) {
    return {
      ...base,
      version: stamp.version,
      reason: "api-not-an-integer",
      detail: `stamp shellApiVersion=${String(api)}`,
    };
  }
  if (api < min) {
    return {
      ...base,
      version: stamp.version,
      shellApiVersion: api,
      reason: "api-too-old",
      detail: `runtime shellApiVersion ${api} < shell minimum ${min}`,
    };
  }
  if (api > max) {
    return {
      ...base,
      version: stamp.version,
      shellApiVersion: api,
      reason: "api-too-new",
      detail: `runtime shellApiVersion ${api} > shell maximum ${max} — update the desktop app`,
    };
  }

  // ── 4. the artifact must agree with the stamp ───────────────────────────
  if (!isDir(root)) {
    return { ...base, version: stamp.version, reason: "root-missing", detail: root };
  }
  let manifest: { name?: string; version?: string; libi?: { shellApiVersion?: number } };
  try {
    manifest = readJson(path.join(root, "package.json")) as typeof manifest;
  } catch (err) {
    return {
      ...base,
      version: stamp.version,
      reason: "root-manifest-unreadable",
      detail: (err as Error).message,
    };
  }
  if (
    manifest.name !== RUNTIME_PACKAGE ||
    manifest.version !== stamp.version ||
    manifest.libi?.shellApiVersion !== api
  ) {
    return {
      ...base,
      version: stamp.version,
      shellApiVersion: api,
      reason: "root-disagrees-with-stamp",
      detail:
        `stamp={name:${RUNTIME_PACKAGE},version:${stamp.version},api:${api}} ` +
        `package.json={name:${String(manifest.name)},version:${String(manifest.version)},api:${String(manifest.libi?.shellApiVersion)}}`,
    };
  }

  // ── 5. the two files the shell cannot start without ─────────────────────
  if (!exists(path.join(root, SHELL_API_ENTRY))) {
    return {
      ...base,
      version: stamp.version,
      shellApiVersion: api,
      reason: "shell-api-missing",
      detail: path.join(root, SHELL_API_ENTRY),
    };
  }
  if (!exists(path.join(root, ".next", "BUILD_ID"))) {
    return {
      ...base,
      version: stamp.version,
      shellApiVersion: api,
      reason: "next-build-missing",
      detail: path.join(root, ".next", "BUILD_ID"),
    };
  }

  // ── 6. a Node binding exists for the OTHER interpreter ──────────────────
  // Gate 7 below dlopens better-sqlite3 inside THIS process, which is Electron
  // — so it proves nothing about the plain-node MCP child, and a runtime with
  // no `Release-node-*` sidecars sails through it. That is exactly how the
  // in-app updater shipped runtimes whose every DB-backed `libi.*` tool was
  // dead while the app looked entirely healthy, and — being newer than the
  // bundled snapshot — kept shadowing a working runtime on every boot.
  //
  // Static existence check only: no dlopen, no network, nothing executed. It
  // asks for AT LEAST ONE sidecar rather than the full set, matching the
  // producers' own fail-if-zero policy (better-sqlite3 genuinely publishes no
  // prebuild for some majors).
  //
  // This is also the rollback for runtimes ALREADY on disk from the buggy
  // installer: they are rejected here at next boot and the shell falls back to
  // the bundled snapshot on its own, with no UI and no user action.
  const sidecars = sidecarMajorsInPrefix(prefix);
  if (sidecars.length === 0) {
    return {
      ...base,
      version: stamp.version,
      shellApiVersion: api,
      reason: "node-sidecars-missing",
      detail:
        `no better-sqlite3 Release-node-* binding in ${prefix} — libi's agent ` +
        `tools run in a separate Node process and could not reach the database`,
    };
  }

  // ── 7. the REAL ABI test ────────────────────────────────────────────────
  // The stamp is a claim by whoever wrote it. This actually dlopen()s the
  // binding the app will use, in a try/catch. Node raises a clean Error
  // ("was compiled against a different Node.js version") rather than
  // aborting, so a wrong-ABI runtime is rejected here instead of at the
  // first DB call.
  if (opts.probeNative !== false) {
    const probe = probeNativeBinding(root);
    if (!probe.ok) {
      return {
        ...base,
        version: stamp.version,
        shellApiVersion: api,
        reason: "native-probe-failed",
        detail: probe.detail,
      };
    }
  }

  // ── 8. this runtime is not OLDER than the database on disk ──────────────
  // The one gate about the USER'S DATA rather than the artifact, and the only
  // one that can reject a runtime which is in every other way perfect.
  //
  // Every other gate is about a runtime being broken. This one fires when a
  // runtime is merely old — which is a *designed* state here: `runtime-prune`
  // keeps the previous version precisely so gate 2 can fall back to it, and a
  // shell update that bumps Electron's ABI rejects every staged runtime at
  // once, demoting the user to the snapshot inside the .app. Before migration
  // 0051 that demotion was harmless. Now the older runtime's `seedDatabase`
  // writes a column 0051 dropped, SQLite throws in the first fixed boot step,
  // and the user meets a fatal banner. So the rollback path must know about
  // the database, and it has to know here — the shell is the newer of the two
  // components in this scenario, so a check living only in the runtime cannot
  // protect against runtimes that predate the check.
  //
  // Fails OPEN on anything unknown (no database yet, an unstamped database
  // from before this existed, a prefix with no `drizzle/`): a safety net that
  // can itself refuse to boot on a missing file is a worse bug than the one it
  // prevents.
  if (opts.dbPath) {
    const dbSchema = readDbSchemaVersion(opts.dbPath);
    const runtimeSchema = readRuntimeSchemaVersion(migrationsFolderIn(root));
    if (isDbSchemaTooNew(dbSchema, runtimeSchema)) {
      return {
        ...base,
        version: stamp.version,
        shellApiVersion: api,
        reason: "db-schema-too-new",
        detail:
          `libi ${stamp.version} understands database schema ${runtimeSchema}, ` +
          `but ${opts.dbPath} was written at schema ${dbSchema} by a newer libi`,
      };
    }
  }

  return {
    prefix,
    root,
    ok: true,
    version: stamp.version,
    shellApiVersion: api,
  };
}

/**
 * dlopen the runtime's own `better-sqlite3`. Never throws.
 *
 * The return type is a flat `{ ok, detail? }` rather than a discriminated
 * union on purpose: `electron/tsconfig.json` does not narrow boolean-literal
 * unions (the same pre-existing quirk that produces the `CompileResult` /
 * `ParseScriptResult` errors elsewhere in the tree), so a union here would be a
 * type error at every call site.
 */
export function probeNativeBinding(root: string): { ok: boolean; detail?: string } {
  try {
    const req = createRequire(path.join(root, "package.json"));
    const mod = req("better-sqlite3") as unknown;
    if (typeof mod !== "function") {
      return { ok: false, detail: `better-sqlite3 loaded but is ${typeof mod}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

/**
 * Fetched runtimes, newest first.
 *
 * Ordering is numeric-segment-wise on the directory name so `0.10.0` sorts
 * above `0.9.0`. A directory whose name isn't a plain dotted version still
 * gets listed (it is validated like any other candidate) but sorts last —
 * `inspectRuntimePrefix` is the authority on whether it may run, not the name.
 */
export function listUserRuntimePrefixes(libiHome: string): string[] {
  const dir = path.join(libiHome, USER_RUNTIME_DIRNAME);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name);
  names.sort(compareVersionDesc);
  return names.map((n) => path.join(dir, n));
}

function compareVersionDesc(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa && pb) {
    for (let i = 0; i < 3; i += 1) {
      if (pa[i] !== pb[i]) return pb[i] - pa[i];
    }
    return a < b ? 1 : a > b ? -1 : 0;
  }
  if (pa) return -1;
  if (pb) return 1;
  return a < b ? 1 : a > b ? -1 : 0;
}

function parseVersion(name: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(name);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export interface ResolveRuntimeOptions {
  /** `app.isPackaged`. Unpackaged always resolves to `null` (see header). */
  isPackaged: boolean;
  /** `process.resourcesPath` — where the bundled snapshot lives. */
  resourcesPath: string;
  /** `process.env.LIBI_HOME` for this app. */
  libiHome: string;
  /** Defaults to `process.versions.modules`. */
  abi?: string;
  log?: (message: string) => void;
  minApiVersion?: number;
  maxApiVersion?: number;
  probeNative?: boolean;
  /**
   * Database gate 8 compares candidates against. Defaults to
   * `<libiHome>/libi.sqlite` — the same path `getLibiDbPath()` derives inside
   * the runtime, restated here because the runtime is not loaded yet.
   */
  dbPath?: string;
}

export interface ResolveRuntimeResult {
  runtime: LoadedRuntime | null;
  /** Every candidate that was tried and refused, in order. For the splash. */
  rejections: RuntimeInspection[];
  /**
   * Version of the snapshot inside this `.app`, whether or not it won.
   *
   * The runtime cannot see this: it knows what it is, not what it was chosen
   * over. Two things need it — pruning staged runtimes that can never be
   * selected again (they are ~1.3 GB each and bundled outranks them), and
   * telling the user which runtime is actually live when a staged one has
   * been superseded. Null when the bundled snapshot could not be inspected
   * at all, which is a broken install, not a normal state.
   */
  bundledVersion: string | null;
}

/**
 * Resolve + load: the highest version among every valid candidate — each
 * staged runtime and the bundled snapshot alike — with bundled winning an
 * exact tie. Source is the tiebreak, never the primary key.
 *
 * Returns `runtime: null` only when NOTHING is usable — a broken install, not a
 * network problem. Callers must surface that distinction honestly (see
 * `electron/main.ts`): an unreachable registry with a working bundled snapshot
 * is not an error the user needs to see.
 */
export function resolveRuntime(opts: ResolveRuntimeOptions): ResolveRuntimeResult {
  const log = opts.log ?? (() => {});
  const rejections: RuntimeInspection[] = [];

  if (!opts.isPackaged) {
    log("runtime-loader: unpackaged — the working tree is the runtime, not loading a snapshot");
    return { runtime: null, rejections, bundledVersion: null };
  }

  const abi = opts.abi ?? process.versions.modules;
  const inspectOpts: InspectOptions = {
    abi,
    minApiVersion: opts.minApiVersion,
    maxApiVersion: opts.maxApiVersion,
    probeNative: opts.probeNative,
    dbPath: opts.dbPath ?? path.join(opts.libiHome, LIBI_DB_FILENAME),
  };

  const candidates: Array<{ prefix: string; source: "bundled" | "user" }> = [
    ...listUserRuntimePrefixes(opts.libiHome).map(
      (prefix) => ({ prefix, source: "user" as const }),
    ),
    {
      prefix: path.join(opts.resourcesPath, BUNDLED_RUNTIME_DIRNAME),
      source: "bundled" as const,
    },
  ];

  // Selection is by VERSION, not by source. libi versions two things
  // independently — the shell (this `.app`, which carries the bundled snapshot)
  // and the runtime (`runtime/<v>/`, staged from npm) — and either can advance
  // without the other. The old rule, "prefer anything the user staged, fall
  // back to bundled", held only while the bundled snapshot could never be the
  // newer of the two. A shell update makes it the newer one, so that rule
  // pinned a user who staged 0.1.1 and then updated the shell to 0.1.5 onto
  // 0.1.1 — while the UI told them they were current.
  //
  // Source survives only as the tiebreak on an exact version match: the bundled
  // snapshot costs no extra disk and was integrity-checked at build time.
  //
  // Candidates that fail inspection are rejections (a damaged or incompatible
  // runtime, which the splash reports). A valid candidate that merely loses the
  // comparison is NOT a rejection — nothing is wrong with it.
  const inspected = candidates.map((candidate) => ({
    ...candidate,
    inspection: inspectRuntimePrefix(candidate.prefix, inspectOpts),
  }));
  // Recorded whether or not it wins — see `ResolveRuntimeResult.bundledVersion`.
  const bundledVersion =
    inspected.find((c) => c.source === "bundled")?.inspection.version ?? null;

  const usable = inspected
    .filter(({ inspection, source, prefix }) => {
      if (inspection.ok) return true;
      log(
        `runtime-loader: rejected ${source} runtime at ${prefix} — ` +
          `${inspection.reason}: ${inspection.detail ?? ""}`,
      );
      rejections.push(inspection);
      return false;
    })
    .sort((a, b) => {
      const byVersion = compareVersionDesc(
        a.inspection.version ?? "",
        b.inspection.version ?? "",
      );
      if (byVersion !== 0) return byVersion;
      // Exact tie: bundled first.
      return a.source === b.source ? 0 : a.source === "bundled" ? -1 : 1;
    });

  for (const candidate of usable) {
    const { inspection } = candidate;

    // ── 8. load, and re-check the version against the loaded module ───────
    let api: ShellApi;
    try {
      const req = createRequire(path.join(inspection.root, "package.json"));
      api = req(`./${SHELL_API_ENTRY}`) as ShellApi;
    } catch (err) {
      const failure: RuntimeInspection = {
        ...inspection,
        ok: false,
        reason: "shell-api-load-failed",
        detail: (err as Error).message,
      };
      log(
        `runtime-loader: rejected ${candidate.source} runtime at ${candidate.prefix} — ` +
          `shell-api-load-failed: ${failure.detail}`,
      );
      rejections.push(failure);
      continue;
    }
    if (api?.SHELL_API_VERSION !== inspection.shellApiVersion) {
      const failure: RuntimeInspection = {
        ...inspection,
        ok: false,
        reason: "shell-api-version-disagrees",
        detail: `module says ${String(api?.SHELL_API_VERSION)}, stamp says ${String(inspection.shellApiVersion)}`,
      };
      log(
        `runtime-loader: rejected ${candidate.source} runtime at ${candidate.prefix} — ` +
          `shell-api-version-disagrees: ${failure.detail}`,
      );
      rejections.push(failure);
      continue;
    }

    log(
      `runtime-loader: using ${candidate.source} runtime ${inspection.version} ` +
        `(shellApiVersion ${inspection.shellApiVersion}) at ${inspection.root}`,
    );
    return {
      runtime: {
        prefix: inspection.prefix,
        root: inspection.root,
        version: inspection.version!,
        shellApiVersion: inspection.shellApiVersion!,
        source: candidate.source,
        api,
      },
      rejections,
      bundledVersion,
    };
  }

  return { runtime: null, rejections, bundledVersion };
}

/**
 * The message shown on the splash when NO runtime could be loaded.
 *
 * This is the genuinely-fatal case from the plan's three-outcome table: the app
 * cannot run at all. It is deliberately NOT phrased as a network problem —
 * the bundled snapshot ships inside the .app, so its absence means a damaged
 * install, and blaming the user's connection would send them chasing the wrong
 * thing. When a candidate was rejected for a reason we DO understand (an
 * api-too-new fetched runtime, say), that reason is included verbatim.
 */
export function describeNoRuntimeFailure(rejections: RuntimeInspection[]): {
  error: string;
  hint: string;
} {
  const tooNew = rejections.find((r) => r.reason === "api-too-new");
  if (tooNew) {
    return {
      error: `The installed libi runtime (${tooNew.version ?? "unknown"}) needs a newer version of the desktop app.`,
      hint: [
        "Update Libi to the latest desktop release, then reopen it.",
        "",
        `Detail: ${tooNew.detail ?? ""}`,
        SUPPORT_LINE,
      ].join("\n"),
    };
  }
  // Every candidate was refused for being older than the user's data. This is
  // NOT a damaged install and must not be described as one: the app is fine,
  // the database is fine, and the two are one version apart. Above all it must
  // not send the user anywhere near their database — the whole point of gate 8
  // is that libi stopped instead of writing to it.
  const tooOld = rejections.filter((r) => r.reason === "db-schema-too-new");
  if (tooOld.length > 0 && tooOld.length === rejections.length) {
    return {
      error: "This version of Libi is older than your libi data.",
      hint: [
        "Your pieces, chats and settings were last opened by a newer version of Libi,",
        "and this one stopped rather than write to them. Nothing has been changed, and",
        "there is nothing to delete or repair.",
        "",
        "Install the latest Libi release and open it again.",
        "",
        // Every candidate was rejected against the SAME database, so their
        // details differ only by prefix path — printing one per candidate just
        // repeats the same sentence at the user.
        ...[...new Set(tooOld.map((r) => r.detail ?? ""))].map((d) => `Detail: ${d}`),
        SUPPORT_LINE,
      ].join("\n"),
    };
  }
  const lines = rejections.map(
    (r) => `  • ${r.prefix}: ${r.reason}${r.detail ? ` (${r.detail})` : ""}`,
  );
  return {
    error: "Libi could not load its runtime.",
    hint: [
      "The copy of libi bundled inside this app is missing or damaged, so there is",
      "nothing to fall back to. Reinstalling the app is the fix — this is not a",
      "network problem.",
      "",
      lines.length > 0 ? "Candidates tried:" : "No runtime candidates were found.",
      ...lines,
      "",
      SUPPORT_LINE,
    ].join("\n"),
  };
}
