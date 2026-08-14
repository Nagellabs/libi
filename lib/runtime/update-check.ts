// lib/runtime/update-check.ts
//
// "Is there a newer published `@nagellabs/libi`, and can THIS desktop app
// actually run it?"
//
// ## Two rules this module exists to enforce
//
// 1. **A failed check is invisible.** Offline is the normal state for some
//    users, not an error. Every network path here resolves to
//    `{ state: "unknown" }` — never a throw, never something the UI can turn
//    into an error toast. The one thing worse than not knowing about an update
//    is telling a user on a plane that something is broken.
//
// 2. **Never offer an install that cannot work.** A published version declares
//    `libi.shellApiVersion`; the shell pins a `[MIN, MAX]` range
//    (`electron/runtime-loader.ts`, surfaced here via
//    `lib/runtime/current-runtime.ts`). Outside that range the runtime would
//    be FETCHED, laid down on disk, rejected by the loader at next launch, and
//    the user would be back where they started having "successfully updated".
//    So an out-of-range version is reported as `shell-update-required` and the
//    install button is never shown for it.
//
// ## Why an HTTP GET and not `npm view`
//
// `npm view @nagellabs/libi dist-tags.latest` is what the Verdaccio harness
// asserts (`scripts/local-registry/upgrade.js`) and it is the same registry
// data — but running npm from inside the Electron main process means the
// `utilityProcess` dance (`lib/install/npm-root.ts`) for what is one HTTP GET,
// and npm's own network stack has its own timeouts and cache. A direct fetch
// of the version manifest is a few hundred bytes, cancellable, and gives us
// `libi.shellApiVersion` in the same round trip — which the abbreviated
// packument (`application/vnd.npm.install-v1+json`) would strip.
import { serverLogger as logger } from "@/lib/logger";
import {
  detectIsPackaged,
  describeRegistryUrl,
  type RegistryResolution,
} from "@/lib/runtime/registry-url";
import { RUNTIME_PACKAGE } from "@/lib/runtime/runtime-install";
import {
  describeCurrentRuntime,
  type CurrentRuntime,
  type ShellApiRange,
} from "@/lib/runtime/current-runtime";

const LOG_TAG = "runtime-update";

/** How long a successful check is reused before hitting the registry again. */
export const SUCCESS_TTL_MS = 6 * 60 * 60 * 1000;
/**
 * How long a FAILED check is remembered. Short enough that reconnecting is
 * noticed within a session, long enough that a permanently-offline machine
 * isn't retrying on every Settings mount.
 */
export const FAILURE_TTL_MS = 15 * 60 * 1000;
/** Per-request network timeout. A stalled registry must not stall the UI. */
export const FETCH_TIMEOUT_MS = 8000;

export type UpdateState =
  /** Not a packaged desktop shell — a dev tree or an `npx` install. */
  | "unsupported"
  /** The check could not complete. SILENT: no error surface, ever. */
  | "unknown"
  | "up-to-date"
  /** Newer AND inside the shell's supported API range. Installable. */
  | "update-available"
  /** Newer but outside the shell's range — needs a new desktop app. */
  | "shell-update-required";

export interface UpdateStatus {
  state: UpdateState;
  currentVersion: string | null;
  latestVersion: string | null;
  /** `libi.shellApiVersion` of the latest published version, when readable. */
  latestShellApiVersion: number | null;
  /** When this answer was computed (epoch ms). */
  checkedAt: number;
}

export interface LatestManifest {
  version: string;
  shellApiVersion: number | null;
}

/**
 * Compare two dotted versions. Returns <0, 0, >0 like a comparator.
 *
 * Deliberately minimal — libi publishes plain `x.y.z` — with one rule beyond
 * numeric comparison: a prerelease suffix (`1.2.0-rc.1`) sorts BELOW the
 * release it precedes, matching semver, so an rc can never present itself as
 * an upgrade over the release of the same triple.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { nums: number[]; pre: string | null } => {
    const [core, ...rest] = v.trim().split("-");
    const nums = core.split(".").map((s) => {
      const n = Number.parseInt(s, 10);
      return Number.isFinite(n) ? n : 0;
    });
    while (nums.length < 3) nums.push(0);
    return { nums, pre: rest.length > 0 ? rest.join("-") : null };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i += 1) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1; // release > prerelease
  if (pb.pre === null) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

/** True when `latest` is strictly newer than `current`. */
export function isNewer(latest: string, current: string): boolean {
  return compareVersions(latest, current) > 0;
}

/**
 * The whole decision, as a pure function. Everything above it is plumbing.
 *
 * `null` inputs (an unreadable current version, a manifest with no
 * `shellApiVersion`, an unknown shell range) all resolve to `"unknown"` rather
 * than to a guess: this function gates a button that downloads and installs
 * executable code, and "I could not determine that" is a legitimate answer.
 */
export function classifyUpdate(args: {
  currentVersion: string | null;
  latest: LatestManifest | null;
  shellApi: ShellApiRange | null;
  updatesSupported: boolean;
  now?: number;
}): UpdateStatus {
  const checkedAt = args.now ?? Date.now();
  const base = {
    currentVersion: args.currentVersion,
    latestVersion: args.latest?.version ?? null,
    latestShellApiVersion: args.latest?.shellApiVersion ?? null,
    checkedAt,
  };
  if (!args.updatesSupported) return { ...base, state: "unsupported" };
  if (!args.currentVersion || !args.latest) return { ...base, state: "unknown" };
  if (!isNewer(args.latest.version, args.currentVersion)) {
    return { ...base, state: "up-to-date" };
  }
  // Newer — but is it runnable HERE?
  if (args.latest.shellApiVersion === null || args.shellApi === null) {
    // A published version with no declared contract version, or a shell whose
    // range we could not learn. Both are malformed states rather than user
    // problems; stay silent instead of offering an unverifiable install.
    logger.warn(
      {
        tag: LOG_TAG,
        op: "classify_indeterminate",
        latest: args.latest.version,
        latestShellApiVersion: args.latest.shellApiVersion,
        shellApi: args.shellApi,
      },
      "newer version found but its shell-API compatibility could not be determined",
    );
    return { ...base, state: "unknown" };
  }
  const api = args.latest.shellApiVersion;
  if (api < args.shellApi.min || api > args.shellApi.max) {
    return { ...base, state: "shell-update-required" };
  }
  return { ...base, state: "update-available" };
}

/** `<registry>/@nagellabs%2Flibi/latest` — the version manifest endpoint. */
export function latestManifestUrl(registryUrl: string, pkg = RUNTIME_PACKAGE): string {
  const base = registryUrl.endsWith("/") ? registryUrl : `${registryUrl}/`;
  return `${base}${pkg.replace("/", "%2F")}/latest`;
}

/** `<registry>/@nagellabs%2Flibi` — the full packument (fallback). */
export function packumentUrl(registryUrl: string, pkg = RUNTIME_PACKAGE): string {
  const base = registryUrl.endsWith("/") ? registryUrl : `${registryUrl}/`;
  return `${base}${pkg.replace("/", "%2F")}`;
}

function manifestFrom(doc: unknown): LatestManifest | null {
  if (!doc || typeof doc !== "object") return null;
  const d = doc as { version?: unknown; libi?: { shellApiVersion?: unknown } };
  if (typeof d.version !== "string" || d.version.length === 0) return null;
  const api = d.libi?.shellApiVersion;
  return {
    version: d.version,
    shellApiVersion: Number.isInteger(api) ? (api as number) : null,
  };
}

/**
 * Fetch the latest published manifest. Returns null on ANY failure — offline,
 * DNS, 404, malformed JSON, timeout. Never throws.
 *
 * Two endpoints because they fail differently: `/latest` is one small document
 * but is a dist-tag lookup some registry proxies do not implement, while the
 * full packument always exists and always carries the custom `libi` field.
 */
export async function fetchLatestManifest(opts: {
  registryUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<LatestManifest | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;

  const get = async (url: string): Promise<unknown | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      if (!res.ok) return null;
      return (await res.json()) as unknown;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const direct = manifestFrom(await get(latestManifestUrl(opts.registryUrl)));
  if (direct) return direct;

  const packument = await get(packumentUrl(opts.registryUrl));
  if (!packument || typeof packument !== "object") return null;
  const p = packument as {
    "dist-tags"?: Record<string, string>;
    versions?: Record<string, unknown>;
  };
  const latest = p["dist-tags"]?.latest;
  if (typeof latest !== "string") return null;
  const doc = p.versions?.[latest];
  return manifestFrom(doc) ?? { version: latest, shellApiVersion: null };
}

// ── The cached entry point ──────────────────────────────────────────────────

interface CacheEntry {
  status: UpdateStatus;
  expiresAt: number;
}

let cache: CacheEntry | null = null;

/** Test seam + the "Check again" button's path. */
export function clearUpdateCheckCache(): void {
  cache = null;
}

export interface CheckOptions {
  /** Ignore the cache and hit the registry now. */
  force?: boolean;
  fetchImpl?: typeof fetch;
  now?: number;
  /** Injectable so tests don't depend on cwd/env. */
  current?: CurrentRuntime;
  registry?: RegistryResolution;
}

/**
 * The cached, offline-safe update check. NEVER throws and NEVER rejects.
 *
 * Not a JobManager job on purpose: this is a sub-second HTTP GET whose failure
 * mode is "say nothing", with no progress to report, nothing to resume and
 * nothing to cancel. The INSTALL that follows it is the long-running half, and
 * that one does go through JobManager (`lib/jobs/runners/runtime-update.ts`).
 */
export async function checkForRuntimeUpdate(
  opts: CheckOptions = {},
): Promise<UpdateStatus> {
  const now = opts.now ?? Date.now();
  if (!opts.force && cache && cache.expiresAt > now) return cache.status;

  const current = opts.current ?? describeCurrentRuntime();
  if (!current.updatesSupported) {
    // No network call at all in dev / npx. Not cached: it is a constant.
    return classifyUpdate({
      currentVersion: current.version,
      latest: null,
      shellApi: current.shellApi,
      updatesSupported: false,
      now,
    });
  }

  const registry =
    opts.registry ?? describeRegistryUrl({ isPackaged: detectIsPackaged() });
  if (registry.rejected) {
    // A silently-ignored override is the failure mode that wastes an
    // afternoon. See `lib/runtime/registry-url.ts`.
    logger.warn(
      { tag: LOG_TAG, op: "registry_override_ignored", reason: registry.rejected },
      "LIBI_REGISTRY_URL was set but not applied",
    );
  }

  const latest = await fetchLatestManifest({
    registryUrl: registry.url,
    fetchImpl: opts.fetchImpl,
  });
  const status = classifyUpdate({
    currentVersion: current.version,
    latest,
    shellApi: current.shellApi,
    updatesSupported: true,
    now,
  });

  if (latest === null) {
    logger.info(
      { tag: LOG_TAG, op: "check_failed", registry: registry.url },
      "update check could not reach the registry — staying silent",
    );
  } else {
    logger.info(
      {
        tag: LOG_TAG,
        op: "check_done",
        state: status.state,
        current: status.currentVersion,
        latest: status.latestVersion,
      },
      "update check complete",
    );
  }

  cache = {
    status,
    expiresAt: now + (status.state === "unknown" ? FAILURE_TTL_MS : SUCCESS_TTL_MS),
  };
  return status;
}
