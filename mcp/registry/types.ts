export type InstallStatus =
  | "pending"
  | "checking"
  | "installed"
  | "failed"
  | "not_required"
  | "needs_config";

export type NodeArch = "x64" | "arm64";

/** Per-platform value, optionally further keyed by arch. */
export type PlatformValue<T> = {
  darwin: T | Partial<Record<NodeArch, T>>;
  linux: T | Partial<Record<NodeArch, T>>;
  win32: T | Partial<Record<NodeArch, T>>;
};

/**
 * A custom-installer dependency runs an arbitrary shell command instead of
 * the standard "download URL → maybe extract archive → drop in ~/.libi/bin"
 * flow. Used for tools that have their own version-managed cache and binary
 * registry (e.g. Playwright's Chromium, which lives in
 * `~/Library/Caches/ms-playwright/chromium-<revision>/` and matches a
 * specific `playwright-core` version).
 *
 * The `verify` function decides "is it installed?" — typically by calling
 * the upstream package's own path-resolver and stat'ing the result.
 * The `install` command is invoked when verify returns null.
 */
export interface CustomInstaller {
  /** Returns the absolute path to the installed binary, or null when not installed. Pure check, no side effects. */
  verify: () => Promise<string | null>;
  /** Shell command + args run when verify returns null. Spawned via execFile. */
  install: {
    command: string;
    args: string[];
    timeoutMs?: number;
  };
}

export interface FileEntry {
  /** Absolute URL to fetch. */
  url: string;
  /** Path relative to the destination directory. */
  relPath: string;
  /** Hex sha256 checksum (case-insensitive comparison); verified after download. Strongly recommended for models. */
  sha256?: string;
}

/**
 * Describes a single binary dependency.
 *
 * Two shapes:
 *   - Standard: `downloadUrl` + optional `archive` → download to ~/.libi/bin.
 *     `binary` is the file name on PATH or in ~/.libi/bin.
 *   - Custom: `customInstallerId` → look up an installer (verify + install
 *     command) from `installers.ts` at runtime. Server-only side-effects
 *     live there to keep them out of any client bundle that reaches
 *     `bundled.ts`. Standard download fields can be omitted in this mode.
 */
export interface BundledDependency {
  /** Binary name (standard mode: looked up on PATH / ~/.libi/bin; custom mode: identifier only). */
  binary: string;
  /** Where to install: ~/.libi/bin/ (default) or ~/.libi/models/. */
  destination?: "bin" | "models";
  /** Standard mode: platform-specific download URLs (optionally arch-keyed). Omit when `customInstallerId` is set. */
  downloadUrl?: PlatformValue<string>;
  /** Standard mode: if set, download is an archive that needs extraction. */
  archive?: {
    /** Archive format. Controls which `tar` flags we use to extract. */
    format: "zip" | "tar.xz" | "tar.gz";
    /** Per-platform path to the binary inside the extracted tree (optionally arch-keyed). */
    binaryPathInArchive: PlatformValue<string>;
  };
  /**
   * Custom mode: key into `mcp/registry/installers.ts`. Takes precedence over
   * `downloadUrl`. The implementation is resolved server-side at run time so
   * the client bundle never sees `fs`/`playwright-core` imports.
   */
  customInstallerId?: string;
  /** Multi-file mode — used by model bundles. Mutually exclusive with archive/downloadUrl. */
  files?: FileEntry[];
  /**
   * Optional hex sha256 of the downloaded artifact (raw-binary deps only;
   * for archives it is the sha of the extracted binary). When set, the
   * binary download path content-verifies against it and HARD-FAILS the
   * install on mismatch (RC-E).
   *
   * DELIBERATELY UNSET for every current binary — their `downloadUrl`s are
   * moving "latest" aliases (evermeet `getrelease`, johnvansickle
   * `ffmpeg-release-…`, GitHub `releases/latest`), so a static hash would
   * brick first boot the instant upstream publishes a new build. Populate
   * this ONLY once the artifact is re-hosted as a libi-controlled,
   * version-pinned release asset. Until then the download path logs a
   * one-time "binary_unverified" warning instead of verifying.
   */
  sha256?: string;
  /**
   * Free-form string libi writes to a marker file (`<install-path>.install-token`)
   * at install time and compares against the declared value on every boot.
   * Mismatch (or missing marker on a token-declared dep) triggers re-install.
   * Lets a manifest bump force a re-download even when the underlying
   * `downloadUrl` points to a "latest" alias.
   *
   * Two conventions for the value:
   *   1. **Real version** when the download URL is version-pinned —
   *      e.g. mediapipe-vision's `tasks-vision@0.10.35/...` URLs use
   *      `pinnedInstallToken: "0.10.35"`. The token is honest.
   *   2. **Date string** (`YYYY-MM-DD`) when the URL is a "latest" alias
   *      (yt-dlp, ffmpeg, uv, etc.). The token starts at the date the
   *      manifest entry was added/last-touched. To force every user to
   *      re-fetch the upstream "latest" — e.g. after a CVE drops in
   *      yt-dlp — bump the token to today's date in a new commit. On the
   *      next boot, the marker mismatch triggers a fresh download.
   *
   * Trust-on-first-install: adding this field to a dep that's already on
   * disk without a marker forces a one-shot re-install (no way to know
   * the version of pre-existing bytes).
   */
  pinnedInstallToken?: string;
  /**
   * "tier-1": libi installs this dep at boot via Category A, even if the
   * parent MCP is `installFlow: "tier-2"` and otherwise agent-managed.
   * Use for shared auxiliary deps that need to be fast / pre-warmed
   * (e.g. yt-dlp's Python binary — used by yt-dlp-mcp, but a slow
   * cold-start would race the SDK's MCP_TIMEOUT under parallel-spawn).
   *
   * "tier-2" (default): the agent owns this dep. Libi never installs
   * it automatically; the dep is described in the parent MCP's recovery
   * guide for the agent to act on if needed.
   */
  installFlow?: "tier-1" | "tier-2";
  /**
   * When `true`, the resolver IGNORES a copy of the binary found on the
   * system PATH and always installs our bundled build into `~/.libi/bin/`.
   *
   * Why this exists: some binaries (e.g. ffmpeg) require specific build-time
   * features (libfreetype → drawtext filter, libopus, libvpx-vp9, …) that
   * the typical OS-package build skips. The default `brew install ffmpeg`
   * on macOS for example ships WITHOUT `--enable-libfreetype`, so a
   * PATH-found ffmpeg silently fails text-overlay exports. Setting
   * `requireBundled: true` forces libi to use the known-good static build
   * declared in `downloadUrl` instead of trusting whatever the user has.
   *
   * Has no effect on `customInstallerId` deps (those never use the PATH
   * fallback) or `files`-mode model bundles.
   */
  requireBundled?: boolean;
  /**
   * Optional runnability probe: CLI args used to actually EXECUTE the
   * installed binary and confirm it runs on this machine (e.g. `["-version"]`).
   * When set, `resolveStatusAsync` runs `<binPath> <args>` and treats a
   * non-zero exit / spawn failure (ENOEXEC, "bad CPU type in executable" —
   * i.e. a wrong-architecture download) as NOT installed, so the install loop
   * re-fetches instead of reporting a green ✔ on a binary that cannot execute.
   *
   * Closes the "exists-on-disk ≠ runnable" verify hole: without this, a
   * `fs.existsSync` + install-token match marks a binary installed even when
   * it is the wrong CPU architecture. Set on ffmpeg/ffprobe, whose macOS
   * download source (evermeet.cx) is x86_64-only — fatal on Apple Silicon
   * without Rosetta.
   */
  runCheck?: string[];

  /**
   * Assert the binary can actually DO what libi needs, not merely that it runs.
   *
   * `runCheck` proves execution; it cannot prove capability, and the two came
   * apart badly. The Linux ffmpeg build shipped until 2026-08-16 executed
   * perfectly, passed `-version`, and had no `drawtext` filter — so every text
   * overlay on the ffmpeg export path failed with "No such filter: 'drawtext'".
   * Worse, its `-version` output ADVERTISED `--enable-libfreetype`, so even
   * parsing the configuration string would have reported it healthy.
   *
   * `resolveStatusAsync` runs `<binPath> <args>` and requires every string in
   * `mustContain` to appear in the combined stdout+stderr. A miss is treated
   * exactly like a failed `runCheck` — the dep drops to "pending" so the
   * install loop re-fetches — because a binary that cannot do the job is not
   * usefully "installed". If the upstream source itself is wrong, the install
   * loop's own retry ceiling ends at `failed`, which surfaces in the UI rather
   * than looping forever.
   *
   * Keep the probe cheap and offline: it runs on every status resolution.
   */
  capabilityCheck?: {
    /** Args that make the binary print its capabilities (e.g. `["-filters"]`). */
    args: string[];
    /** Every one of these must appear in the output, or the dep is unusable. */
    mustContain: string[];
  };
}

export type DepRuntimeStatus = "pending" | "installing" | "installed" | "failed";

/** Live-computed status of a single dependency (returned from the API). */
export interface DependencyStatus {
  binary: string;
  installed: boolean;
  /** Absolute path when installed, null otherwise. */
  path: string | null;
  /** "system" = found on PATH, "bundled" = in ~/.libi/bin/ or ~/.libi/models/, null if not installed. */
  source: "system" | "bundled" | null;
  /** Lifecycle state for surfacing to UI + agent. Optional because
   *  binary-dep rows produced by older code paths may not populate it
   *  (the chip falls back to `installed ? "installed" : "pending"`). */
  runtimeStatus?: DepRuntimeStatus;
  /** Human-readable error when runtimeStatus === "failed". */
  error?: string | null;
  /** Optional progress for installs in progress. */
  bytesDownloaded?: number;
  bytesTotal?: number;
}

export interface BundledMcpDef {
  /** Stable ID used for DB upsert (e.g., "youtube-downloader", "libi") */
  id: string;
  name: string;
  description: string;
  /** Null when `core === true` (libi itself is not an npm package). */
  npmUrl: string | null;
  /** Optional PyPI URL when the package is Python (e.g., elevenlabs-mcp). */
  pypiUrl?: string | null;
  type: "stdio" | "http";
  /**
   * Core entries (`core: true`) are not spawned as external MCPs — they
   * represent the libi server itself. Their command/args may be empty.
   */
  command: string;
  args: string[];
  /** HTTP-only: endpoint URL. Required when `type === "http"`. */
  url?: string;
  /**
   * HTTP-only: request headers. Values may reference `${VAR}` placeholders
   * which are substituted from the row's `envVars` at config-emit time.
   */
  headers?: Record<string, string>;
  requireApproval: boolean;
  /** True for the libi server row — hides disable/approval/delete controls in UI. */
  core?: boolean;
  /**
   * When true the row is seeded + surfaced (Settings, list_bundled_mcps,
   * install plan, update_dep_status) but NEVER spawned as an MCP server.
   * Used for capability rows whose work runs inside libi's own MCP/tools
   * (e.g. `whisper`, whose transcription runs through analysis_transcribe_audio).
   * Filtered out of the spawn list at the same point the libi-core row is.
   */
  noServer?: boolean;
  dependencies: BundledDependency[];
  /**
   * Env vars that MUST be present in the row's `envVars` JSON for the MCP
   * to register. If any are missing, installStatus becomes "needs_config".
   * Empty/undefined = no config required.
   */
  requiredEnvVars?: string[];
  /** Extra instructions injected into agent context. Ignored for core entries. */
  agentInstructions?: string;
  /** Marks an MCP whose tools spend money or produce paid generations.
   *  Tools from generation: true MCPs require user approval in the `auto` mode
   *  but auto-resolve in `auto-with-generations`. No effect in `ask` mode. */
  generation?: boolean;
  /**
   * When set, libi treats this MCP as "owned": instead of spawning via
   * `npx -y <pkg>@latest` (registry roundtrip + npm-lock contention), the
   * package is installed once into `~/.libi/node_modules/` at the pinned
   * version and spawned from its local bin shim. Drift between the pinned
   * version and what's on disk triggers a re-install during Category B.
   *
   * Both fields must be set together. `binName` is the executable name
   * under `<install-root>/node_modules/.bin/` — usually the package's bin
   * entry. Falls back to the package's tail segment when unset.
   */
  npmPackage?: string;
  /** Exact version to install (no ranges, no `latest`). */
  pinnedVersion?: string;
  /**
   * In-repo MCP marker. Set to the entry file's path *relative to the libi
   * repo root* (e.g. `mcp/tracking-mcp/index.ts`) for MCPs that ship inside
   * the libi package itself (same `npx libi` binary, spawned by the CLI)
   * rather than as a separately-installed npm package.
   *
   * When set AND the source tree + `node_modules/tsx/dist/cli.mjs` are
   * present, `resolveBundledSpawn()` returns a tsx-direct command (run via
   * `node`, not the `node_modules/.bin/tsx` shim electron-builder never
   * copies) pointed at this file — so the prober, diagnose, and session
   * paths ALL spawn it the same way. The def's `command`/`args` (typically
   * `npx libi serve-mcp-*`) are kept only as Settings-UI metadata —
   * `resolveBundledSpawn()` deliberately never falls back to them (this repo
   * is unpublished and the public `libi` npm name belongs to an unrelated
   * third party); a missing entry point/tsx CLI throws a loud diagnostic
   * instead, mirroring how `core: true` makes the core libi server resolve
   * to its tsx entry (or throw) everywhere via `buildLibiEntry()`.
   *
   * Mutually exclusive in practice with `npmPackage` — an in-repo MCP is not
   * a separate npm package.
   */
  inRepoEntry?: string;
  /** Bin shim name under node_modules/.bin/. Defaults to last segment of npmPackage. */
  binName?: string;
  /**
   * "tier-1" (default): installed by libi's Category A core-install phase
   * (CLI blocks on it). Used for deps that libi's own tools depend on
   * (ffmpeg, ffprobe, chromium, mediapipe-vision, and the libi MCP itself).
   *
   * "tier-2": installed by the agent on demand via libi.get_install_plan +
   * libi.update_dep_status. Not in Category A. The agent reads the markdown
   * install plan at `installPlanPath` and follows the steps using its own
   * Bash/Read/Write tools.
   *
   * Default: "tier-1" (preserves current behavior for any entry not opted in).
   */
  installFlow?: "tier-1" | "tier-2";
  /**
   * Tier-2 only: path to the markdown install plan, relative to the libi
   * repo root. Returned verbatim by `libi.get_install_plan(mcpId)` and
   * executed step-by-step by the agent.
   */
  installPlanPath?: string;
}
