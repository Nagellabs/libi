/**
 * The yt-dlp launcher can no longer bake a worktree path, and a launcher
 * whose target is gone counts as NOT installed
 * (docs-local/qa/2026-09-25-video-download-and-playback-plan.md T4).
 *
 * The incident: a dev worktree's LIBI_HOME links `bin/` and `uv/` to the
 * machine's real `~/.libi` (lib/dev/worktree-bootstrap.ts SHARED_LINKS). The
 * worktree installed yt-dlp; `uv tool dir` answered with the worktree's own
 * path, which went into the SHARED launcher. Deleting the worktree broke
 * video download everywhere, and verify() — "token current + launcher file
 * exists" — kept calling it installed.
 *
 * Driven for real: a fake `uv` shell script (answers `tool install` by
 * creating the entry point under $UV_TOOL_DIR, `tool dir` by echoing it) and
 * a real directory layout with real symlinks. Only DB transitions and
 * analytics are stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("@/mcp/registry/dep-transition", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/mcp/registry/dep-transition")>()),
  writeDepTransition: vi.fn(),
}));
vi.mock("@/lib/analytics/server", () => ({ trackServerEvent: vi.fn() }));
// An in-memory, migrated DB: the status resolver reads dependency rows.
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("../../../helpers/test-db");
  const db = createTestDb();
  return { getDb: () => db };
});

const realPlatform = process.platform;
const savedHome = process.env.LIBI_HOME;
let tmp: string;
let canonical: string;
let worktreeHome: string;

/** Every argv the fake uv saw, one line per call. */
function uvCalls(): string[] {
  try {
    return fs.readFileSync(path.join(tmp, "uv-calls.txt"), "utf-8").trim().split("\n");
  } catch {
    return [];
  }
}

function writeFakeUv(binDir: string): void {
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, "uv"),
    `#!/bin/bash\n` +
      `echo "$*" >> "${path.join(tmp, "uv-calls.txt")}"\n` +
      `if [ "$1" = tool ] && [ "$2" = install ]; then\n` +
      // Records the interpreter preference the install ran under, and takes a
      // moment, as a real install does, so concurrent callers overlap.
      `  echo "$UV_PYTHON_PREFERENCE" >> "${path.join(tmp, "uv-python-pref.txt")}"\n` +
      `  sleep 0.3\n` +
      `  mkdir -p "$UV_TOOL_DIR/yt-dlp/bin"\n` +
      `  printf '#!/bin/sh\\necho fake-yt-dlp\\n' > "$UV_TOOL_DIR/yt-dlp/bin/yt-dlp"\n` +
      `  chmod +x "$UV_TOOL_DIR/yt-dlp/bin/yt-dlp"\n` +
      `  exit 0\n` +
      `fi\n` +
      `if [ "$1" = tool ] && [ "$2" = dir ]; then echo "$UV_TOOL_DIR"; exit 0; fi\n` +
      `exit 1\n`,
    { mode: 0o755 },
  );
}

// No platform pin: these modules are imported per test, and pinning
// `process.platform` before an import breaks native-binding resolution. The
// block is skipped on Windows instead, whose launcher is a .cmd shim.
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-ytdlp-heal-"));
  canonical = path.join(tmp, "dot-libi");
  fs.mkdirSync(path.join(canonical, "bin"), { recursive: true });
  fs.mkdirSync(path.join(canonical, "uv"), { recursive: true });
  writeFakeUv(path.join(canonical, "bin"));
  vi.resetModules();
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.LIBI_HOME;
  else process.env.LIBI_HOME = savedHome;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.resetModules();
});

async function load() {
  const { DependencyManager } = await import("@/mcp/registry/dependency-manager");
  const { BUNDLED_MCP_SERVERS } = await import("@/mcp/registry/bundled");
  const installers = await import("@/mcp/registry/installers");
  const launcher = await import("@/lib/video-download/launcher");
  const dep = BUNDLED_MCP_SERVERS.find((d) => d.id === "youtube-download")!.dependencies.find(
    (d) => d.binary === "yt-dlp",
  )!;
  return { DependencyManager, dep, installers, launcher };
}

// Every test re-imports the dependency manager after vi.resetModules() and runs the fake uv
// installer: real module loading and child processes, which a loaded machine stretches past
// vitest's 5 s default. Nothing here asserts on time.
describe.skipIf(realPlatform === "win32")("yt-dlp launcher — canonical target, self-heal", { timeout: 30_000 }, () => {
  it("a worktree-symlinked home writes the CANONICAL entry path, which survives deleting the worktree", async () => {
    // The worktree layout: its own home whose bin/ and uv/ are links to the
    // canonical ones.
    worktreeHome = path.join(tmp, "dot-libi", "worktrees", "mcp-http");
    fs.mkdirSync(worktreeHome, { recursive: true });
    fs.symlinkSync(path.join(canonical, "bin"), path.join(worktreeHome, "bin"));
    fs.symlinkSync(path.join(canonical, "uv"), path.join(worktreeHome, "uv"));
    process.env.LIBI_HOME = worktreeHome;

    const { DependencyManager, dep, launcher } = await load();
    const dm = new DependencyManager() as unknown as {
      installYtDlpViaUv: (d: typeof dep, t: number) => Promise<void>;
    };
    await dm.installYtDlpViaUv(dep, 30_000);

    const written = fs.readFileSync(path.join(canonical, "bin", "yt-dlp"), "utf-8");
    const target = launcher.parseYtDlpLauncherTarget(written);
    expect(target).toBe(
      path.join(fs.realpathSync(canonical), "uv", "tools", "yt-dlp", "bin", "yt-dlp"),
    );
    expect(written).not.toContain(`${path.sep}worktrees${path.sep}`);

    // Delete the worktree — exactly what broke the owner's machine — and look
    // at the launcher from the canonical home.
    fs.rmSync(worktreeHome, { recursive: true, force: true });
    process.env.LIBI_HOME = canonical;
    expect(launcher.checkYtDlpLauncher()).toMatchObject({ ok: true, target });
  });

  it("verify() calls a launcher whose target is gone NOT installed, even with a current token", async () => {
    process.env.LIBI_HOME = canonical;
    const { installers } = await load();
    const binDir = path.join(canonical, "bin");
    fs.writeFileSync(
      path.join(binDir, "yt-dlp"),
      `#!/bin/bash\nexec "${path.join(tmp, "worktrees", "deleted", "uv", "tools", "yt-dlp", "bin", "yt-dlp")}" --no-playlist "$@"\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(installers.ytDlpTokenPath(binDir), installers.YT_DLP_UV_TOKEN);

    expect(await installers.getCustomInstaller("yt-dlp-uv")!.verify()).toBeNull();
  });

  it("ensureDep reinstalls a launcher with a dead target, and the rewrite points at an entry that exists", async () => {
    process.env.LIBI_HOME = canonical;
    const { DependencyManager, installers, launcher } = await load();
    const binDir = path.join(canonical, "bin");
    const dead = path.join(tmp, "worktrees", "deleted", "uv", "tools", "yt-dlp", "bin", "yt-dlp");
    fs.writeFileSync(path.join(binDir, "yt-dlp"), `#!/bin/bash\nexec "${dead}" --no-playlist "$@"\n`, {
      mode: 0o755,
    });
    fs.writeFileSync(installers.ytDlpTokenPath(binDir), installers.YT_DLP_UV_TOKEN);

    await new DependencyManager().ensureDep("youtube-download", "yt-dlp");

    expect(uvCalls().some((c) => c.startsWith("tool install"))).toBe(true);
    const health = launcher.checkYtDlpLauncher();
    expect(health.ok).toBe(true);
    expect(health.target).not.toBe(dead);
    expect(await installers.getCustomInstaller("yt-dlp-uv")!.verify()).toBe(
      path.join(binDir, "yt-dlp"),
    );
  });

  it("ensureDep leaves a healthy launcher alone — no uv call at all", async () => {
    process.env.LIBI_HOME = canonical;
    const { DependencyManager, installers } = await load();
    const binDir = path.join(canonical, "bin");
    const entry = path.join(canonical, "uv", "tools", "yt-dlp", "bin", "yt-dlp");
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, "#!/bin/sh\necho ok\n", { mode: 0o755 });
    fs.writeFileSync(path.join(binDir, "yt-dlp"), `#!/bin/bash\nexec "${entry}" --no-playlist "$@"\n`, {
      mode: 0o755,
    });
    fs.writeFileSync(installers.ytDlpTokenPath(binDir), installers.YT_DLP_UV_TOKEN);

    await new DependencyManager().ensureDep("youtube-download", "yt-dlp");
    expect(uvCalls()).toEqual([]);
  });

  it("installs yt-dlp on a uv-MANAGED Python only (UV_PYTHON_PREFERENCE=only-managed), never a system python3", async () => {
    // A system `python3` can be the macOS CLT stub (dialog + exit 1) or a broken
    // pyenv shim; uv's default discovery executes it and fails before downloading.
    process.env.LIBI_HOME = canonical;
    const { DependencyManager } = await load();
    await new DependencyManager().retryDep("youtube-download", "yt-dlp");
    expect(fs.readFileSync(path.join(tmp, "uv-python-pref.txt"), "utf-8").trim()).toBe("only-managed");
  });

  it("two concurrent repairs share ONE uv install (single-flight) — a second --reinstall would wipe the venv the first job runs from", async () => {
    process.env.LIBI_HOME = canonical;
    const { DependencyManager, launcher } = await load();
    // Two separate managers, as two video_download jobs each construct one.
    const a = new DependencyManager().retryDep("youtube-download", "yt-dlp");
    const b = new DependencyManager().retryDep("youtube-download", "yt-dlp");
    await Promise.all([a, b]);
    expect(uvCalls().filter((c) => c.startsWith("tool install"))).toHaveLength(1);
    expect(launcher.checkYtDlpLauncher().ok).toBe(true);
    // And the flight is released: a LATER repair runs its own install.
    await new DependencyManager().retryDep("youtube-download", "yt-dlp");
    expect(uvCalls().filter((c) => c.startsWith("tool install"))).toHaveLength(2);
  });

  it("retryDep THROWS when the install finishes but the dep is still not detected (was a silent return)", async () => {
    process.env.LIBI_HOME = canonical;
    const { DependencyManager, installers } = await load();
    const inst = installers.getCustomInstaller("yt-dlp-uv")!;
    const realVerify = inst.verify;
    let calls = 0;
    // First verify (the installer's own post-check) passes; the status
    // re-check after it does not.
    inst.verify = async () => (++calls === 1 ? path.join(canonical, "bin", "yt-dlp") : null);
    try {
      await expect(new DependencyManager().retryDep("youtube-download", "yt-dlp")).rejects.toThrow(
        /yt-dlp: the install completed without an error, but libi still does not detect it as installed/,
      );
    } finally {
      inst.verify = realVerify;
    }
  });
});

// UV-2: a launcher-only repair needs no network. A broken launcher over an intact tool venv is rewritten without
// `uv tool install --reinstall` (which needs PyPI); a fresh install, a token bump and a Settings Re-download over a
// healthy launcher still go through uv.
describe.skipIf(realPlatform === "win32")("yt-dlp launcher-only repair (offline)", () => {
  /** A uv that fails every call, as offline, recording each. */
  function offlineUv(): void {
    fs.writeFileSync(
      path.join(canonical, "bin", "uv"),
      `#!/bin/bash\necho "$*" >> "${path.join(tmp, "uv-calls.txt")}"\necho "error: Request failed after 3 retries" >&2\nexit 2\n`,
      { mode: 0o755 },
    );
  }

  /** The tool venv uv left behind, with an entry point that answers --version. */
  function intactVenv(): string {
    const entry = path.join(canonical, "uv", "tools", "yt-dlp", "bin", "yt-dlp");
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, "#!/bin/sh\necho 2026.09.20\n", { mode: 0o755 });
    return entry;
  }

  it("intact venv, missing launcher, uv failing: the repair succeeds with no uv call, and the launcher runs the venv's entry", async () => {
    process.env.LIBI_HOME = canonical;
    const { DependencyManager, installers, launcher } = await load();
    offlineUv();
    const entry = intactVenv();
    const binDir = path.join(canonical, "bin");
    fs.writeFileSync(installers.ytDlpTokenPath(binDir), installers.YT_DLP_UV_TOKEN);

    const { serverLogger } = await import("@/lib/logger");
    const info = vi.spyOn(serverLogger, "info");

    await new DependencyManager().retryDep("youtube-download", "yt-dlp");

    expect(uvCalls()).toEqual([]);
    expect(launcher.checkYtDlpLauncher()).toMatchObject({ ok: true, target: fs.realpathSync(entry) });
    expect(await installers.getCustomInstaller("yt-dlp-uv")!.verify()).toBe(path.join(binDir, "yt-dlp"));
    // The success line names what actually ran (found on the Windows VM: it said "uv" here).
    const ok = info.mock.calls.map((c) => c[0] as { op?: string; via?: string }).find((f) => f.op === "custom_installer_ok");
    expect(ok?.via).toBe("launcher");
    info.mockRestore();
  });

  it("a launcher that fails to start (the job's repair) over an intact venv is rewritten without uv too", async () => {
    process.env.LIBI_HOME = canonical;
    const { DependencyManager, installers, launcher } = await load();
    offlineUv();
    const entry = intactVenv();
    const binDir = path.join(canonical, "bin");
    // Passes the file checks, but lost its exec bit: exit 126 at spawn.
    fs.writeFileSync(path.join(binDir, "yt-dlp"), `#!/bin/bash\nexec "${entry}" --no-playlist "$@"\n`, { mode: 0o644 });
    fs.writeFileSync(installers.ytDlpTokenPath(binDir), installers.YT_DLP_UV_TOKEN);

    const launcherOnly = vi.fn();
    await new DependencyManager().retryDep("youtube-download", "yt-dlp", { launcherFailed: true, onLauncherOnlyRepair: launcherOnly });

    expect(uvCalls()).toEqual([]);
    expect(launcherOnly).toHaveBeenCalledTimes(1); // the job is told no reinstall ran (review M6)
    expect(fs.statSync(path.join(binDir, "yt-dlp")).mode & 0o111).not.toBe(0);
    expect(launcher.checkYtDlpLauncher().ok).toBe(true);
  });

  it("a Re-download over a HEALTHY launcher is still a real reinstall through uv (it is how yt-dlp gets updated)", async () => {
    process.env.LIBI_HOME = canonical;
    const { DependencyManager, installers } = await load();
    const entry = intactVenv();
    const binDir = path.join(canonical, "bin");
    fs.writeFileSync(path.join(binDir, "yt-dlp"), `#!/bin/bash\nexec "${entry}" --no-playlist "$@"\n`, { mode: 0o755 });
    fs.writeFileSync(installers.ytDlpTokenPath(binDir), installers.YT_DLP_UV_TOKEN);

    const launcherOnly = vi.fn();
    await new DependencyManager().retryDep("youtube-download", "yt-dlp", { onLauncherOnlyRepair: launcherOnly });

    expect(uvCalls().some((c) => c.startsWith("tool install"))).toBe(true);
    expect(launcherOnly).not.toHaveBeenCalled();
  });

  it("an old token (a YT_DLP_UV_TOKEN bump) goes through uv even with an intact venv, and fails offline in words", async () => {
    process.env.LIBI_HOME = canonical;
    const { DependencyManager, installers } = await load();
    offlineUv();
    intactVenv();
    fs.writeFileSync(installers.ytDlpTokenPath(path.join(canonical, "bin")), "yt-dlp-uv@1999-01-01");

    await expect(new DependencyManager().retryDep("youtube-download", "yt-dlp")).rejects.toThrow();
    expect(uvCalls().some((c) => c.startsWith("tool install"))).toBe(true);
  });

  it("a venv entry that does not run is reinstalled through uv", async () => {
    process.env.LIBI_HOME = canonical;
    const { DependencyManager, installers } = await load();
    const entry = intactVenv();
    fs.writeFileSync(entry, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    fs.writeFileSync(installers.ytDlpTokenPath(path.join(canonical, "bin")), installers.YT_DLP_UV_TOKEN);

    await new DependencyManager().retryDep("youtube-download", "yt-dlp");
    expect(uvCalls().some((c) => c.startsWith("tool install"))).toBe(true);
  });
});
