import { getLibiHome } from "@/lib/libi-home";

/**
 * Secret-free env construction for MCP server entries libi PERSISTS to a config
 * file — the codex `config.toml`.
 *
 * ## The problem
 *
 * Bundled stdio entries are built with `buildSpawnEnv()`, which inlines the
 * ENTIRE process environment so the spawned child inherits everything at once.
 * That's fine for an in-memory spawn, but when the entry is written to a config
 * file it dumps every secret in the process — provider API keys the user
 * exported for their own MCPs, `git_token`, OAuth scopes, npm internals — onto
 * disk, and hands EVERY server EVERY secret. These files are user-readable and
 * sometimes dotfile-tracked.
 *
 * ## The fix
 *
 * Persist only what a server legitimately needs:
 *   - operational vars (so the process + its `npx`/`npm` tooling run),
 *   - the server's OWN required vars — none today, see
 *     `requiredEnvVarsForServer`,
 *   - any var the entry declares that is NOT just an inherited process-env key
 *     (a custom MCP's own DB-configured secret, which lives on the entry but not
 *     in `process.env`),
 *   - a pinned `LIBI_HOME` (libi-family home resolution — codex sanitizes its
 *     env for MCP children, so the libi child must be told its home explicitly).
 * Every other inherited key — other services' secrets — is dropped.
 */

/** Non-secret operational env vars a spawned MCP process legitimately needs. */
const OPERATIONAL_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "USER",
  "SHELL",
  "TERM",
]);

/**
 * The env-var names an MCP server declares it requires, looked up by the
 * ORIGINAL libi server name (before any codex name-sanitizing).
 *
 * Always empty: libi holds no provider key and every bundled def is
 * a libi-owned extension with nothing to configure. The seam stays so a
 * caller that needs a server's declared vars has one place to ask, and so a server's
 * OWN secret never rides through here by accident — a secret a user
 * configured on their own MCP lives on that entry, not in `process.env`,
 * and passes through the not-inherited branch of `buildSafeServerEnv`.
 */
export function requiredEnvVarsForServer(_serverName: string): string[] {
  return [];
}

/**
 * Build the secret-free env to persist for a stdio MCP server. `serverName` is
 * the ORIGINAL libi name (used to look up `requiredEnvVars`). `fullEnv` is the
 * entry's built env (typically the full `buildSpawnEnv()` dump). Returns the
 * filtered env with `LIBI_HOME` pinned.
 */
export function buildSafeServerEnv(
  serverName: string,
  fullEnv: Record<string, string> | undefined,
  opts: { libiHome?: string } = {},
): Record<string, string> {
  const required = new Set(requiredEnvVarsForServer(serverName));
  const inheritedKeys = new Set(Object.keys(process.env));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fullEnv ?? {})) {
    if (OPERATIONAL_ENV_KEYS.has(k) || required.has(k) || !inheritedKeys.has(k)) {
      out[k] = v;
    }
  }
  out.LIBI_HOME = opts.libiHome ?? getLibiHome();
  return out;
}
