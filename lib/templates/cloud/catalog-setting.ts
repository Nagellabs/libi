/**
 * Which public templates catalog this process talks to — resolved per call,
 * never frozen at build time, so a switch in Settings takes effect without a
 * restart, in the studio and the MCP child alike (both read the one settings
 * row; there is no second source of truth).
 *
 *  - Packaged and npm builds: `SITE_URL`, the build's own site — production
 *    in every release. Any stored setting is IGNORED: a database copied from a
 *    dev machine cannot point a real install at another catalog.
 *  - Dev builds (a checkout: `npm run dev` / `dev:electron`, any worktree —
 *    `describeCurrentRuntime().source === "dev"` for libi's OWN package root,
 *    the same test the Updates card uses to say "development checkout"; see
 *    `isDevBuild`): Production or Development, as
 *    stored in `settings.templates_catalog` (lib/db/settings.ts). With nothing
 *    stored, Development when NEXT_PUBLIC_LIBI_SITE_URL names a site other than
 *    production (today's behaviour), else Production.
 *  - Test mode: the fixture, whatever else is set.
 *
 * The development site's Vercel protection-bypass token travels only in
 * `x-vercel-protection-bypass`, only over https, only to the stored
 * development origin, and only when that origin is a `*.vercel.app`
 * deployment (`bypassHeadersFor`). Every catalog request refuses redirects
 * (lib/templates/cloud/client.ts#call), so the header can't be carried on.
 */
import fs from "node:fs";
import path from "node:path";
import { getDb } from "@/lib/db/client";
import { getTemplatesCatalogSetting, templatesCatalogSettingGeneration, type TemplatesCatalogChoice, type TemplatesCatalogSetting } from "@/lib/db/settings";
import { serverLogger as logger } from "@/lib/logger";
import { describeCurrentRuntime } from "@/lib/runtime/current-runtime";
import { packageRoot, packageRootFound } from "@/lib/runtime/package-root";
import { PRODUCTION_SITE_URL, SITE_URL } from "@/lib/site-url";
import { VERCEL_BYPASS_HEADER, isVercelPreviewOrigin, parseDevOrigin } from "@/lib/templates/cloud/catalog-origin";
import { TEST_MODE_SOURCE } from "@/lib/templates/cloud/constants";
import { isTestMode } from "@/lib/test-mode";

const TAG = "templates-cloud";

let devBuildMemo: boolean | null = null;

/**
 * Whether libi's own code at `root` is a working tree — not an installed
 * package (npm/npx: under `node_modules`) or the desktop app's runtime
 * (`LIBI_RUNTIME_SOURCE`, a packaged Electron). Pure, for tests.
 */
export function isDevBuildAt(root: string, env: Record<string, string | undefined> = process.env, isPackaged?: boolean): boolean {
  return describeCurrentRuntime({ cwd: root, env, ...(isPackaged === undefined ? {} : { isPackaged }) }).source === "dev";
}

/**
 * A dev build: decided from where libi's OWN code lives (`packageRoot()`),
 * never from the caller's cwd. An npm-installed `libi serve-mcp` (stdio, run
 * by the user's own MCP client) or a hand-run `serve-mcp-http` starts in the
 * user's project folder — a cwd outside `node_modules`, even a git checkout —
 * and must still read as installed: a dev checkout and npx share `~/.libi`,
 * so a Development choice stored by one must never steer the other.
 * Memoized — it cannot change while the process runs.
 */
export function isDevBuild(): boolean {
  devBuildMemo ??= isDevBuildFrom();
  return devBuildMemo;
}

/**
 * `isDevBuild` for code at `dirname` (default: `packageRoot()`'s own), with
 * this env and cwd. A root found from there keeps the answer above. Not found
 * — inside a Turbopack-bundled Next server `__dirname` is the build-time
 * `/ROOT/…`, and `packageRoot()` falls back to the cwd — it is a dev build
 * only when the dev launcher said so (`isMarkedDevCheckout`), never because
 * the cwd looks like a checkout: an entry point that starts Next without
 * chdir-ing would otherwise classify a user's project (often a git repo) as
 * one — the I1 bug, in the studio (review N1). A forgotten marker fails
 * closed: a dev studio reads Production and hides the Settings tab.
 */
export function isDevBuildFrom(dirname?: string, env: Record<string, string | undefined> = process.env, cwd: string = process.cwd()): boolean {
  if (packageRootFound(dirname)) return isDevBuildAt(packageRoot(dirname), env);
  return isMarkedDevCheckout(env, cwd);
}

/**
 * The dev launcher's word (`bin/libi.js`, its `inDevCheckout()` branch, sets
 * `LIBI_DEV_CHECKOUT_ROOT`): the marker names this process's own cwd (real
 * paths, both), that folder is a git checkout, and nothing else says this is
 * an installed or packaged runtime. Consulted only when libi can't find its
 * own code, so an inherited marker can't turn the compiled CLI or a tsx child
 * into a dev build.
 */
function isMarkedDevCheckout(env: Record<string, string | undefined>, cwd: string): boolean {
  const marker = env.LIBI_DEV_CHECKOUT_ROOT;
  if (!marker) return false;
  try {
    if (fs.realpathSync(marker) !== fs.realpathSync(cwd)) return false;
  } catch {
    return false;
  }
  return fs.existsSync(path.join(marker, ".git")) && isDevBuildAt(cwd, env);
}

/** Tests only: forget the memoized answers (after stubbing LIBI_RUNTIME_SOURCE). */
export function __resetDevBuildForTests(): void {
  devBuildMemo = null;
  storedMemo = null;
}

/** The development address a fresh dev install starts with: NEXT_PUBLIC_LIBI_SITE_URL, when it names another site than production. */
export function defaultDevOrigin(): string | null {
  if (SITE_URL === PRODUCTION_SITE_URL) return null;
  const parsed = parseDevOrigin(SITE_URL);
  return parsed.ok ? parsed.origin : null;
}

let readFailed = false;

/**
 * How long a read of the setting is trusted (review M7): `catalogSource()` is
 * asked once per template in a listing, and each read is a SELECT, a JSON
 * parse and a URL parse. A switch made in THIS process is seen at once (the
 * write bumps `templatesCatalogSettingGeneration`); one made by another
 * process on the same settings row — the studio and its MCP child — within
 * this. Not keyed by the row's `updated_at`: it is whole seconds, so a second
 * write in the same second as a read would go unseen for good.
 *
 * That second is for READS only. Whatever writes or queues work on a catalog —
 * a job's enqueue, a job's check at start, the index cache's superseded check —
 * passes `{ fresh: true }` and reads the row itself (review m1/m2), so the MCP
 * child never acts on the catalog the user has just left.
 */
export interface CatalogReadOptions {
  /** Read the setting from the database now, not from the ≤ 1 s memo (it is refreshed too). */
  fresh?: boolean;
}

const STORED_TTL_MS = 1000;
let storedMemo: { value: TemplatesCatalogSetting | null; at: number; generation: number; db: unknown } | null = null;

/** The stored setting; an unreadable database reads as none (logged once, never the value). */
function stored(opts: CatalogReadOptions = {}): TemplatesCatalogSetting | null {
  try {
    const db = getDb();
    const generation = templatesCatalogSettingGeneration();
    const now = Date.now();
    // Keyed by the database handle too: a DB reset (or a test's fresh one) is never answered from the old one.
    if (!opts.fresh && storedMemo && storedMemo.db === db && storedMemo.generation === generation && now >= storedMemo.at && now - storedMemo.at < STORED_TTL_MS) return storedMemo.value;
    const s = getTemplatesCatalogSetting();
    readFailed = false;
    storedMemo = { value: s, at: now, generation, db };
    return s;
  } catch (err) {
    storedMemo = null;
    if (!readFailed) logger.warn({ tag: TAG, op: "catalog_setting_unreadable", err: err instanceof Error ? err.name : "unknown" }, "the templates catalog setting could not be read; using the default");
    readFailed = true;
    return null;
  }
}

export interface ResolvedCatalog {
  devBuild: boolean;
  testMode: boolean;
  /** What the user chose (or the default): only a dev build can have `development`. */
  choice: TemplatesCatalogChoice;
  /** The development site's origin — the stored one, else the default; null when neither exists. */
  devOrigin: string | null;
  /** `devOrigin` is the NEXT_PUBLIC_LIBI_SITE_URL default, nothing stored. */
  devOriginIsDefault: boolean;
  /** A token is stored for `devOrigin`. Never the token itself. */
  hasBypassToken: boolean;
  /** The token is actually sent: `devOrigin` is a `*.vercel.app` deployment. */
  bypassTokenApplies: boolean;
  /** The catalog this process reads now: "test-mode" or a site origin (`catalogSource()` outside a pinned scope). */
  active: string;
}

export function resolveCatalog(opts: CatalogReadOptions = {}): ResolvedCatalog {
  const testMode = isTestMode();
  if (!isDevBuild()) {
    return {
      devBuild: false,
      testMode,
      choice: SITE_URL === PRODUCTION_SITE_URL ? "production" : "development",
      devOrigin: null,
      devOriginIsDefault: false,
      hasBypassToken: false,
      bypassTokenApplies: false,
      active: testMode ? TEST_MODE_SOURCE : SITE_URL,
    };
  }
  const s = stored(opts);
  const fallback = defaultDevOrigin();
  const devOrigin = s?.devOrigin ?? fallback;
  const wanted: TemplatesCatalogChoice = s ? s.choice : fallback ? "development" : "production";
  // Development with no address to go to is Production: never a catalog that doesn't exist.
  const choice: TemplatesCatalogChoice = wanted === "development" && devOrigin ? "development" : "production";
  const hasBypassToken = Boolean(s?.devOrigin && s.bypassToken);
  return {
    devBuild: true,
    testMode,
    choice,
    devOrigin,
    devOriginIsDefault: !s?.devOrigin && devOrigin !== null,
    hasBypassToken,
    bypassTokenApplies: hasBypassToken && isVercelPreviewOrigin(s?.devOrigin),
    active: testMode ? TEST_MODE_SOURCE : choice === "development" && devOrigin ? devOrigin : PRODUCTION_SITE_URL,
  };
}

/** The catalog this process reads now (unpinned). */
export function activeCatalogSource(opts: CatalogReadOptions = {}): string {
  return resolveCatalog(opts).active;
}

/**
 * Every catalog this process may send a use notice to: the one it reads, and
 * — in a dev build — both of its catalogs, so a use of a template installed
 * from Development still reaches Development after a switch to Production
 * (lib/templates/cloud/use-reporter.ts). A packaged build: its own site only.
 */
export function reachableCatalogSources(opts: CatalogReadOptions = {}): string[] {
  const r = resolveCatalog(opts);
  if (r.testMode) return [TEST_MODE_SOURCE];
  if (!r.devBuild) return [r.active];
  return [...new Set([PRODUCTION_SITE_URL, ...(r.devOrigin ? [r.devOrigin] : [])])];
}

/**
 * The bypass header for a request to `url` — `{}` for every request but one
 * over https to exactly the stored development origin, when that is a
 * `*.vercel.app` deployment and a token is stored, in a dev build outside test
 * mode. Never the production site, never another Vercel deployment, never a
 * bucket or a signed upload URL.
 */
export function bypassHeadersFor(url: string): Record<string, string> {
  if (isTestMode() || !isDevBuild()) return {};
  const s = stored();
  if (!s?.devOrigin || !s.bypassToken || !isVercelPreviewOrigin(s.devOrigin)) return {};
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return {};
  }
  if (u.protocol !== "https:" || u.username || u.password || u.origin !== s.devOrigin) return {};
  return { [VERCEL_BYPASS_HEADER]: s.bypassToken };
}

/** The stored token, for scrubbing it out of text a caller hands on. Null when none — or not a dev build. */
export function bypassTokenForScrub(): string | null {
  if (!isDevBuild()) return null;
  return stored()?.bypassToken ?? null;
}
