import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestDb } from "../../../helpers/test-db";
import { mcpServers } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";

// Mock the db client
vi.mock("@/lib/db/client", () => ({
  getDb: vi.fn(),
}));

// Mock child_process.
//
// `execFile` is consumed two ways in dependency-manager.ts:
//   1. directly with a callback: execFile(cmd, args, cb)
//   2. via promisify(execFile): which calls execFile(cmd, args, options, cb)
//      — the callback is the LAST argument, NOT always the 3rd.
// The old mock only looked at the 3rd positional arg, so a promisified
// call (e.g. `execFileAsync("which", ["uv"], { timeout: 5000 })` in
// installYtDlpViaUv) passed the *options object* as `cb`, the callback
// (4th arg) was never invoked, and the promise hung forever. Resolve
// whichever trailing argument is the callback so promisified calls
// settle deterministically. Default stdout is empty — callers that
// shell out to `which uv` then treat "" as "not found" and fail fast
// (the production-correct behaviour: report failed promptly, don't hang).
//
// One exception to the empty-stdout default: a `capabilityCheck` probe
// (`ffmpeg -filters`) is checked for CONTENT, not just exit code, so an empty
// answer means "this ffmpeg has no drawtext filter" and the dep is correctly
// marked unusable. That is the F5 guard doing its job — but in these tests the
// binary is a mock, so it must answer like a healthy one or every ffmpeg
// assertion fails for the wrong reason.
// The real `child_process.execFile` carries a `util.promisify.custom` symbol so
// `promisify(execFile)` resolves to `{ stdout, stderr }`. A plain vi.fn() does
// NOT, so promisify falls back to resolving with the callback's first value — a
// bare string — and any caller destructuring `{ stdout }` silently gets
// undefined. `isBinaryRunnable` never noticed because it ignores the value;
// `missingCapabilities` reads it, so the mock has to be faithful here.
vi.mock("child_process", async () => {
  const { promisify } = await import("node:util");
  const stdoutFor = (argv: string[]) =>
    // A `capabilityCheck` probe is checked for CONTENT, not exit code, so an
    // empty answer legitimately means "this ffmpeg has no drawtext" and the dep
    // is marked unusable — the F5 guard working. These tests use a mock binary,
    // so it must answer like a healthy one.
    argv.includes("-filters")
      ? " TS. drawtext          V->V       Draw text on top of video frames.\n"
      : "";

  const execFile = vi.fn((...args: unknown[]) => {
    const cb = args[args.length - 1];
    const argv = Array.isArray(args[1]) ? (args[1] as string[]) : [];
    if (typeof cb === "function") {
      (cb as (err: Error | null, stdout: string, stderr: string) => void)(
        null,
        stdoutFor(argv),
        "",
      );
    }
  });
  (execFile as unknown as Record<symbol, unknown>)[promisify.custom] = (
    _cmd: string,
    argv?: string[],
  ) => Promise.resolve({ stdout: stdoutFor(argv ?? []), stderr: "" });

  return { execSync: vi.fn(), execFile };
});

// Mock fs and os
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(),
      mkdirSync: vi.fn(),
      chmodSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(),
      lstatSync: vi.fn(),
      realpathSync: vi.fn(),
      symlinkSync: vi.fn(),
      unlinkSync: vi.fn(),
    },
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    chmodSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(),
    lstatSync: vi.fn(),
    realpathSync: vi.fn(),
    symlinkSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

import { getDb } from "@/lib/db/client";
import { execSync } from "child_process";
import fs from "fs";
// Un-mocked fs, for the rare test that needs to read a real repo file
// (mcp/tracking/py/models.json) while keeping the rest of fs mocked.
const realFs = await vi.importActual<typeof import("fs")>("fs");
import { DependencyManager } from "@/mcp/registry/dependency-manager";
import { seedDatabase } from "@/lib/db/init";
import { getLibiBinDir, getLibiModelsDir } from "@/lib/libi-home";
import { TRACKING_PYENV_TOKEN } from "@/mcp/registry/installers/tracking-pyenv";
import { YT_DLP_UV_TOKEN } from "@/mcp/registry/installers";
import { BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";

// The bin/models dirs resolve against the isolated LIBI_HOME set by the
// global setup (a fresh os.tmpdir() path — NOT literally "~/.libi"). The
// fs.existsSync mocks below must therefore match the *actual* resolved
// directories, not a hardcoded ".libi/..." substring (which never appears
// in the temp path and silently makes every bundled-binary look missing).
const BIN_DIR = getLibiBinDir();
const MODELS_DIR = getLibiModelsDir();

// Derive per-binary install tokens + the set of requireBundled binaries
// straight from the bundled defs, so a future pinnedInstallToken bump or a
// newly-requireBundled dep can never silently desync these mocks. (That was
// the failure mode that left libi-core permanently "failed" in CI: ffmpeg /
// ffprobe were pinned to 2026-05-23 AND made requireBundled — which skips the
// system-PATH branch — while this test hardcoded 2026-05-15 and only mocked
// the PATH lookup.)
const TOKEN_BY_BINARY = new Map<string, string>();
const REQUIRE_BUNDLED_BINS = new Set<string>();
for (const def of BUNDLED_MCP_SERVERS) {
  for (const dep of def.dependencies ?? []) {
    if (dep.pinnedInstallToken) TOKEN_BY_BINARY.set(dep.binary, dep.pinnedInstallToken);
    if (dep.requireBundled && !dep.files && !dep.customInstallerId) {
      REQUIRE_BUNDLED_BINS.add(dep.binary);
    }
  }
}

describe("DependencyManager", () => {
  let db: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
    // yt-dlp is installed via a custom installer that verifies by lstat'ing
    // ~/.libi/bin/yt-dlp + realpath'ing the symlink target. Default to
    // "missing" — individual tests override to simulate the symlink being
    // present.
    vi.mocked(fs.lstatSync).mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    vi.mocked(fs.realpathSync).mockImplementation((p) => p as string);
    // Default the marker read to "always matches" so deps with a
    // pinnedInstallToken pass the marker check when their files exist.
    // Individual tests can override to simulate drift.
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (typeof p === "string" && p.endsWith(".install-token")) {
        // The tracking-pyenv custom installer manages its own token marker
        // under <LIBI_HOME>/models/tracking/.install-token. Return the REAL
        // TRACKING_PYENV_TOKEN (imported, not hardcoded) so
        // trackingPyenvInstaller.verify() reports "installed" and ensureMcp
        // skips the real `uv sync`. Importing it means a future token bump
        // (e.g. the Family-A "...familya" bump) can never silently desync
        // this mock and leave libi-tracking permanently "failed".
        if (p.includes("models/tracking")) return TRACKING_PYENV_TOKEN;
        // yt-dlp's custom installer manages its own token next to the wrapper
        // at <BIN_DIR>/yt-dlp.install-token (not a pinnedInstallToken dep, so
        // it isn't in TOKEN_BY_BINARY). Return the REAL YT_DLP_UV_TOKEN so the
        // yt-dlp-uv verify() reports "installed"; a future token bump can't
        // silently desync this mock.
        if (p.endsWith("/yt-dlp.install-token")) return YT_DLP_UV_TOKEN;
        // Return the marker token that actually matches each dep's current
        // pinnedInstallToken (sourced from the bundled defs above), so the
        // marker check passes when the dep's files exist — regardless of
        // future per-dep token bumps. The marker path is
        // `${BIN_DIR}/<binary>.install-token` (raw-binary deps) or
        // `${root}/<binary>/.install-token` (files[] deps).
        for (const [binary, token] of TOKEN_BY_BINARY) {
          if (p.endsWith(`/${binary}.install-token`) || p.endsWith(`/${binary}/.install-token`)) {
            return token;
          }
        }
        // Fallback for any unmapped marker (no dep declares a token for it).
        return "";
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("seeds bundled MCP rows into the database", () => {
    seedDatabase(db as never);

    const rows = db.select().from(mcpServers).all();
    // Eight bundled entries: core libi, yt-dlp, elevenlabs, fal-ai,
    // libi-tracking, plus the three non-spawning capability rows
    // (whisper, local-tts, local-music).
    expect(rows.length).toBe(8);
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual([
      "elevenlabs",
      "fal-ai",
      "libi",
      "libi-tracking",
      "local-music",
      "local-tts",
      "whisper",
      "youtube-downloader",
    ]);
    expect(rows.every((r) => r.bundled)).toBe(true);
    const ytdlp = rows.find((r) => r.id === "youtube-downloader")!;
    expect(ytdlp.name).toBe("YouTube Downloader");
  });

  it("marks installed when binary found on system PATH", async () => {
    seedDatabase(db as never);
    // `which`/`where` succeeds for every PATH-checked binary (ffmpeg, ffprobe, uv).
    vi.mocked(execSync).mockReturnValue(Buffer.from("/usr/local/bin/bin"));
    // The chromium dep uses a customInstaller whose verify() checks
    // fs.existsSync against the real Playwright cache path. Mock the cache
    // path as present so verify returns truthy.
    // The mediapipe-vision multi-file dep checks fs.existsSync on each
    // file under <LIBI_HOME>/models/mediapipe-vision/ — mock those too.
    // requireBundled deps (ffmpeg / ffprobe) deliberately SKIP the system
    // PATH branch (they need a feature-complete bundled build, e.g. drawtext),
    // so "found on PATH" is not enough — their bundled binary must exist in
    // BIN_DIR. Mark those present so the marker check (above) decides status.
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      if (typeof p !== "string") return false;
      return (
        p.includes("ms-playwright/chromium") ||
        p.startsWith(`${MODELS_DIR}/mediapipe-vision/`) ||
        [...REQUIRE_BUNDLED_BINS].some((b) => p === `${BIN_DIR}/${b}`)
      );
    });
    // yt-dlp's custom installer verifies via lstat+realpath of the
    // ~/.libi/bin/yt-dlp symlink — pretend the symlink exists.
    vi.mocked(fs.lstatSync).mockImplementation((p) => {
      if (typeof p === "string" && p.endsWith("/bin/yt-dlp")) {
        return { isSymbolicLink: () => true } as unknown as fs.Stats;
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const manager = new DependencyManager();
    await manager.ensureAll();

    const rows = db.select().from(mcpServers).all();
    for (const row of rows) {
      // Rows with requiredEnvVars and no envVars set → needs_config.
      // (elevenlabs requires ELEVENLABS_API_KEY; fal-ai requires FAL_KEY.)
      // All other rows should be installed when their binaries are on PATH.
      const expected =
        row.id === "elevenlabs" || row.id === "fal-ai" ? "needs_config" : "installed";
      expect(row.installStatus).toBe(expected);
    }
  });

  it("marks installed when binary found in ~/.libi/bin/", async () => {
    seedDatabase(db as never);
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error("not found");
    });
    // All bundled binaries are present in their expected locations:
    //   - ffmpeg / ffprobe / uv → <LIBI_HOME>/bin/  (raw-binary deps)
    //   - yt-dlp → <LIBI_HOME>/bin/yt-dlp  (symlink installed by yt-dlp-uv custom installer)
    //   - chromium → ~/Library/Caches/ms-playwright/chromium-<rev>/ (Playwright's own cache)
    //   - mediapipe-vision → <LIBI_HOME>/models/mediapipe-vision/{wasm,models}/...
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      if (typeof p !== "string") return false;
      return (
        p === `${BIN_DIR}/ffmpeg` ||
        p === `${BIN_DIR}/ffprobe` ||
        p === `${BIN_DIR}/uv` ||
        p.includes("ms-playwright/chromium") ||
        p.startsWith(`${MODELS_DIR}/mediapipe-vision/`)
      );
    });
    // yt-dlp symlink present.
    vi.mocked(fs.lstatSync).mockImplementation((p) => {
      if (typeof p === "string" && p.endsWith("/bin/yt-dlp")) {
        return { isSymbolicLink: () => true } as unknown as fs.Stats;
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const manager = new DependencyManager();
    await manager.ensureAll();

    const rows = db.select().from(mcpServers).all();
    for (const row of rows) {
      // Rows with requiredEnvVars and no envVars set → needs_config.
      const expected =
        row.id === "elevenlabs" || row.id === "fal-ai" ? "needs_config" : "installed";
      expect(row.installStatus).toBe(expected);
    }
  });

  it("marks failed when binary not found and download fails", async () => {
    seedDatabase(db as never);
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error("not found");
    });
    // Nothing is on disk in this scenario — including the tracking-pyenv
    // engine marker. Override the beforeEach default (which pretends the
    // marker is present so the install-path tests skip the real `uv sync`)
    // so trackingPyenvInstaller.verify() returns null and libi-tracking is
    // forced down the install path. There the mocked execFile makes the
    // `uv sync` step resolve instantly, then the rejected fetch below makes
    // the model download fail with "network error" → libi-tracking ends up
    // "failed" with the same error string as the fetch-based deps.
    // Non-marker reads (e.g. mcp/tracking/py/models.json, which the
    // tracking-pyenv installer parses before downloading models) delegate
    // to the real fs so the install can progress to the failing fetch.
    vi.mocked(fs.readFileSync).mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      const [p] = args;
      if (typeof p === "string" && p.endsWith(".install-token")) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      return realFs.readFileSync(...args);
    }) as typeof fs.readFileSync);
    // All fetches (ffmpeg/ffprobe archive, yt-dlp raw binary, tracking
    // model artifacts) reject.
    global.fetch = vi.fn().mockRejectedValue(new Error("network error"));

    const manager = new DependencyManager();
    await manager.ensureAll();

    const rows = db.select().from(mcpServers).all();
    for (const row of rows) {
      // fal-ai has no binary deps — it stays in needs_config (FAL_KEY is unset)
      // regardless of whether other binaries failed to download.
      if (row.id === "fal-ai") {
        expect(row.installStatus).toBe("needs_config");
        continue;
      }
      expect(row.installStatus).toBe("failed");
      expect(row.installError).toContain("network error");
    }
  });

  it("preserves user toggles on re-seed", async () => {
    seedDatabase(db as never);
    vi.mocked(execSync).mockReturnValue(Buffer.from("/usr/local/bin/bin"));
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => typeof p === "string" && p.includes("ms-playwright/chromium"),
    );
    // yt-dlp symlink present so the custom installer's verify returns truthy.
    vi.mocked(fs.lstatSync).mockImplementation((p) => {
      if (typeof p === "string" && p.endsWith("/bin/yt-dlp")) {
        return { isSymbolicLink: () => true } as unknown as fs.Stats;
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const manager = new DependencyManager();
    await manager.ensureAll();

    // User disables the yt-dlp MCP (libi core is not user-toggleable).
    db.update(mcpServers)
      .set({ enabled: false, requireApproval: false })
      .where(eq(mcpServers.id, "youtube-downloader"))
      .run();

    // Re-seed (seedDatabase uses onConflictDoUpdate — preserves user toggles)
    seedDatabase(db as never);
    await manager.ensureAll();

    const ytdlp = db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, "youtube-downloader"))
      .all()[0];
    expect(ytdlp.enabled).toBe(false);
    expect(ytdlp.requireApproval).toBe(false);
    expect(ytdlp.installStatus).toBe("installed");
  });
});
