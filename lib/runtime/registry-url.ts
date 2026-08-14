/**
 * Which npm registry does libi talk to at runtime?
 *
 * Tasks 8 (runtime loader) and 9 (update check) both need to reach a registry:
 * the public one in production, and a throwaway local Verdaccio while they are
 * being developed and verified (`scripts/local-registry/`, documented in
 * `docs-local/local-release-testing.md`). This module is the ONE place that decides,
 * so those two features import a shared answer instead of each growing their
 * own env-var read — which is how a debug override survives into production.
 *
 * ## The gate, and why it is shaped this way
 *
 * The override is honoured ONLY when both hold:
 *
 * 1. **The app is packaged.** A dev checkout must never consult a registry at
 *    all — the working tree IS the runtime there — so an override would have
 *    nothing to act on and only risks confusing a future code path into
 *    fetching.
 * 2. **It is not a worktree run.** `LIBI_WORKTREE_NAME` is set by
 *    `bin/libi.js` and `scripts/dev-electron.js` for every worktree boot
 *    (`lib/dev/worktree-bootstrap.ts`). Worktrees are development.
 *
 * > **Correction to the plan.** The plan
 * > (`docs-local/superpowers/plans/2026-07-28-packaging-fixes-and-licensing-closeout.md`)
 * > says to gate on `app.isPackaged && !LIBI_WORKTREE_DIR`. There is no
 * > `LIBI_WORKTREE_DIR` anywhere in this repo — the variable the worktree
 * > bootstrap actually publishes is `LIBI_WORKTREE_NAME`. Gating on the
 * > non-existent name would have been a permanently-true `!undefined`, i.e. no
 * > worktree gate at all.
 *
 * ## Why the override is env-only
 *
 * It is read from `process.env` and nowhere else. Not from settings, not from
 * a file under `~/.libi` — those are user-writable at runtime, and a registry
 * URL decides where executable code is fetched from. An env var is fixed at
 * launch by whoever launched the process.
 *
 * `http://` is additionally restricted to loopback: a plaintext registry on
 * some remote host is either a typo or a downgrade, and neither should decide
 * where a runtime comes from. `https://` anywhere is allowed, so a private
 * corporate registry still works.
 */

/** npm's public registry. The default in every mode. */
export const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org/";

/** Env var carrying the override. Read only; never written by libi. */
export const REGISTRY_URL_ENV = "LIBI_REGISTRY_URL";

/**
 * Env var the worktree bootstrap sets for every worktree boot. Its presence
 * means "this is development", and disables the override.
 */
export const WORKTREE_ENV = "LIBI_WORKTREE_NAME";

export interface RegistryContext {
  /**
   * Electron's `app.isPackaged`. The Electron main process should pass it
   * explicitly; other processes can use {@link detectIsPackaged}.
   */
  isPackaged: boolean;
  /**
   * Defaults to `process.env`. Injectable so this stays pure for tests.
   *
   * Deliberately NOT `NodeJS.ProcessEnv`: Next's ambient types make `NODE_ENV`
   * a required member of it, so every synthetic `{ LIBI_REGISTRY_URL: … }` a
   * test builds would be a type error for a reason that has nothing to do with
   * this module.
   */
  env?: Record<string, string | undefined>;
}

export type RegistrySource =
  /** No override in play — npm's public registry. */
  | "public"
  /** `LIBI_REGISTRY_URL` was set, allowed, and valid. */
  | "override";

export interface RegistryResolution {
  url: string;
  source: RegistrySource;
  /**
   * Why an override that WAS present did not take effect. Absent when there
   * was no override, or when it was applied. Callers should log this — a
   * silently-ignored override is the failure mode that wastes an afternoon.
   */
  rejected?:
    | "not-packaged"
    | "worktree"
    | "invalid-url"
    | "unsupported-protocol"
    | "insecure-remote"
    | "embedded-credentials";
}

/** Loopback hosts that may be addressed over plaintext `http://`. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Validate + canonicalise a registry URL.
 *
 * Returns the normalised URL (always with a trailing slash, the form npm's own
 * config uses) or a rejection reason. Never throws.
 */
export function normalizeRegistryUrl(
  raw: string | undefined | null,
): { url: string } | { rejected: NonNullable<RegistryResolution["rejected"]> } {
  const trimmed = raw?.trim();
  if (!trimmed) return { rejected: "invalid-url" };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { rejected: "invalid-url" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { rejected: "unsupported-protocol" };
  }
  // A registry URL is a code-distribution endpoint. Credentials belong in an
  // .npmrc auth token, never inline where they land in logs and error strings.
  if (parsed.username || parsed.password) {
    return { rejected: "embedded-credentials" };
  }
  if (parsed.protocol === "http:" && !LOOPBACK_HOSTS.has(parsed.hostname)) {
    return { rejected: "insecure-remote" };
  }

  // Drop query/hash — npm registry roots carry neither, and keeping them would
  // corrupt every path joined onto this base.
  parsed.search = "";
  parsed.hash = "";
  if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
  return { url: parsed.toString() };
}

/**
 * Is the `LIBI_REGISTRY_URL` override even eligible to be read?
 *
 * Packaged, and not a worktree. See the module header.
 */
export function registryOverrideAllowed(ctx: RegistryContext): boolean {
  const env = ctx.env ?? process.env;
  if (!ctx.isPackaged) return false;
  if (env[WORKTREE_ENV]?.trim()) return false;
  return true;
}

/**
 * Full resolution with the reason attached. Prefer this at call sites that
 * log; {@link resolveRegistryUrl} is the convenience wrapper.
 */
export function describeRegistryUrl(ctx: RegistryContext): RegistryResolution {
  const env = ctx.env ?? process.env;
  const raw = env[REGISTRY_URL_ENV]?.trim();
  if (!raw) return { url: PUBLIC_NPM_REGISTRY, source: "public" };

  if (!ctx.isPackaged) {
    return { url: PUBLIC_NPM_REGISTRY, source: "public", rejected: "not-packaged" };
  }
  if (env[WORKTREE_ENV]?.trim()) {
    return { url: PUBLIC_NPM_REGISTRY, source: "public", rejected: "worktree" };
  }

  const normalized = normalizeRegistryUrl(raw);
  if ("rejected" in normalized) {
    return {
      url: PUBLIC_NPM_REGISTRY,
      source: "public",
      rejected: normalized.rejected,
    };
  }
  return { url: normalized.url, source: "override" };
}

/** The registry URL to use. Always a usable absolute URL. */
export function resolveRegistryUrl(ctx: RegistryContext): string {
  return describeRegistryUrl(ctx).url;
}

/**
 * Best-effort "am I a packaged Electron app?" for processes that cannot import
 * `electron` (the Next.js server code, which is bundled by Turbopack).
 *
 * In the packaged app the Next server runs IN the Electron main process
 * (`electron/main.ts#startNextServer`), so `process.defaultApp` — public
 * Electron API, set only when the binary was launched as `electron <path>`,
 * i.e. dev — is readable there.
 *
 * Deliberately fails toward `false`: an unrecognised environment gets the
 * public registry, which is inert rather than wrong. The Electron main process
 * should still pass `app.isPackaged` explicitly.
 */
export function detectIsPackaged(): boolean {
  if (!process.versions.electron) return false;
  const defaultApp = (process as NodeJS.Process & { defaultApp?: boolean })
    .defaultApp;
  return !defaultApp;
}
