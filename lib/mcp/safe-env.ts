import { getLibiHome } from "@/lib/libi-home";
import { BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";

/**
 * Secret-free env construction for MCP server entries libi PERSISTS to a config
 * file — the codex `config.toml` and the BYO `.mcp.json` / `settings.local.json`.
 *
 * ## The problem
 *
 * Bundled stdio entries are built with `buildSpawnEnv()`, which inlines the
 * ENTIRE process environment so the spawned child inherits everything at once.
 * That's fine for an in-memory spawn, but when the entry is written to a config
 * file it dumps every secret in the process — `ELEVENLABS_API_KEY`, `FAL_KEY`,
 * `FAL_API_KEY_ADMIN_SCOPE`, `git_token`, OAuth scopes, npm internals — onto
 * disk, and hands EVERY server EVERY secret (the yt-dlp downloader has no
 * business holding your fal key). These files are user-readable and sometimes
 * dotfile-tracked.
 *
 * ## The fix
 *
 * Persist only what a server legitimately needs:
 *   - operational vars (so the process + its `npx`/`npm` tooling run),
 *   - the server's OWN declared `requiredEnvVars` (the single API key it needs —
 *     e.g. ElevenLabs keeps `ELEVENLABS_API_KEY`, nothing else),
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
 * The env-var names an MCP server declares it requires (its API key etc.),
 * looked up by the ORIGINAL libi server name (before any codex name-sanitizing).
 * Unknown / custom servers declare none here (their secrets ride the
 * not-in-process-env path instead).
 */
export function requiredEnvVarsForServer(serverName: string): string[] {
  return (
    BUNDLED_MCP_SERVERS.find((d) => d.name === serverName)?.requiredEnvVars ?? []
  );
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

/**
 * Reference-form env for a stdio MCP server written to an EXTERNAL
 * `--connect-agent` target dir (the user's own, often git-tracked, project).
 *
 * Same key set as {@link buildSafeServerEnv}, but every declared/custom SECRET
 * value is replaced with a `${KEY}` reference the consuming CLI resolves from
 * its OWN environment — so no plaintext secret ever lands on disk in a dir the
 * user might `git add -A && push`. Non-secret operational vars (PATH, HOME, …)
 * and the pinned `LIBI_HOME` stay literal so the CLI still runs without the
 * user having to re-export them.
 *
 * Claude Code expands `${VAR}` in `.mcp.json` env/args/command values from the
 * process environment; if a given consuming CLI does not, the reference form is
 * still the correct (secret-free) thing to write — the user exports the vars.
 */
export function buildReferenceServerEnv(
  serverName: string,
  fullEnv: Record<string, string> | undefined,
  opts: { libiHome?: string } = {},
): Record<string, string> {
  const safe = buildSafeServerEnv(serverName, fullEnv, opts);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(safe)) {
    if (OPERATIONAL_ENV_KEYS.has(k) || k === "LIBI_HOME") {
      out[k] = v;
    } else {
      out[k] = `\${${k}}`;
    }
  }
  return out;
}
