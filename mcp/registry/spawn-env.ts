import { getLibiBinDir } from "@/lib/libi-home";
import { sqliteBuildDirForChildren } from "@/lib/db/native-binding";
import { uvEnvVars } from "@/lib/uv-env/spawn-env";

/**
 * All MCP child spawns must build env via this function — both probe
 * (`server-prober.ts`) and live (`lib/mcp-config.ts:buildMcpServers`).
 *
 * Build the spawn env for an MCP child process.
 *
 * Why we inherit `process.env` instead of starting from `{}`:
 *   - `npx` reads `~/.npm/_npx` for cached packages. Without `HOME` it
 *     does a cold install path that can take 12s+ — blowing past the
 *     10s probe timeout and leaving servers marked `down`.
 *   - `uvx`, `pip`, and most node/python tooling expect HOME, USER,
 *     LANG, TMPDIR, etc.
 * We override `PATH` to include `~/.libi/bin` (where bundled binaries
 * like ffmpeg/yt-dlp/uv live), then layer per-server `envVars` on top.
 */
export function buildSpawnEnv(
  userEnv: Record<string, string> = {},
): Record<string, string> {
  const libiBinDir = getLibiBinDir();
  const pathSep = process.platform === "win32" ? ";" : ":";
  const augmentedPath = `${libiBinDir}${pathSep}${process.env.PATH ?? ""}`;

  const inherited: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") inherited[k] = v;
  }

  // Name the better-sqlite3 build directory for children.
  //
  // libi's OWN MCP children (core + tracking, and the probe spawns of both)
  // open the database, and in the packaged Electron app they run under a real
  // node while the snapshot's default binding is Electron's. The child cannot
  // find that directory itself — the ACP adapter spawns it with the agent
  // workspace as cwd — so the server, which does know where its runtime lives,
  // passes the path down. See `lib/db/native-binding.ts`.
  //
  // Set on the shared env rather than per-entry because the probe path
  // (`mcp/registry/server-prober.ts`) spawns the same servers through here.
  // Third-party MCP children simply ignore a variable they've never heard of.
  const sqliteBuildDir = sqliteBuildDirForChildren();

  return {
    ...inherited,
    PATH: augmentedPath,
    // Some bundled MCPs are spawned through `uvx` (elevenlabs-mcp), and the
    // prewarm step deliberately runs them once just to populate caches. Pin
    // uv's locations here too, or those children write gigabytes to
    // `~/.cache/uv` and escape the isolation `lib/uv-env/spawn-env.ts`
    // establishes for libi's own uv spawns. A child that has never heard of
    // these variables simply ignores them.
    ...uvEnvVars(),
    ...(sqliteBuildDir ? { LIBI_SQLITE_BINDING_DIR: sqliteBuildDir } : {}),
    ...userEnv,
  };
}
