import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node-pty";
import { serverLogger as logger } from "@/lib/logger";
import type { PtyFactory, PtyLike } from "./types";

/**
 * npm strips the execute bit when unpacking node-pty's prebuilt
 * `spawn-helper` (a Mach-O/ELF executable that node-pty posix_spawn's on
 * every PTY launch), and node-pty's own install scripts never restore it
 * — `pty.spawn()` then fails with the opaque "posix_spawnp failed.".
 * Restore the bit once before the first spawn. No-op on win32 (ConPTY
 * has no helper) and when the bit is already set.
 */
let helperEnsured = false;
function ensureSpawnHelperExecutable(): void {
  if (helperEnsured || process.platform === "win32") return;
  helperEnsured = true;
  try {
    const require_ = createRequire(path.join(process.cwd(), "noop.js"));
    const pkgDir = path.dirname(require_.resolve("node-pty/package.json"));
    const candidates = [
      path.join(pkgDir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
      path.join(pkgDir, "build", "Release", "spawn-helper"),
    ];
    for (const helper of candidates) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(helper);
      } catch {
        continue;
      }
      if ((stat.mode & 0o111) === 0) {
        fs.chmodSync(helper, stat.mode | 0o755);
        logger.info(
          { tag: "terminal", op: "spawn_helper_chmod", helper },
          "restored execute bit on node-pty spawn-helper",
        );
      }
    }
  } catch (err) {
    // Spawn will surface the real failure if the helper genuinely can't run.
    logger.warn(
      { tag: "terminal", op: "spawn_helper_chmod_failed", err },
      "could not verify node-pty spawn-helper permissions",
    );
  }
}

/**
 * Resolve the user's shell. Login shell (`-l`) so the user's profile is
 * sourced — Homebrew / npm-global PATHs must resolve for the CLI presets
 * (`claude`, `codex`, …) even when the Electron-spawned server itself has
 * a minimal PATH.
 */
export function resolveShell(): { shell: string; args: string[] } {
  if (process.platform === "win32") {
    return { shell: "powershell.exe", args: [] };
  }
  const shell =
    process.env.SHELL ||
    (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  return { shell, args: ["-l"] };
}

export const realPtyFactory: PtyFactory = (opts): PtyLike => {
  ensureSpawnHelperExecutable();
  const { shell, args } = resolveShell();
  const pty = spawn(shell, args, {
    name: "xterm-256color",
    cwd: opts.cwd,
    cols: opts.cols,
    rows: opts.rows,
    env: opts.env as { [key: string]: string },
  });
  return {
    pid: pty.pid,
    write: (data) => pty.write(data),
    resize: (cols, rows) => pty.resize(cols, rows),
    kill: () => pty.kill(),
    pause: () => pty.pause(),
    resume: () => pty.resume(),
    onData: (cb) => {
      pty.onData(cb);
    },
    onExit: (cb) => {
      pty.onExit(cb);
    },
  };
};
