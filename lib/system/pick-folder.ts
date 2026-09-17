import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { serverLogger as logger } from "@/lib/logger";
import { isMac, isWindows } from "@/lib/platform";

/**
 * A native "choose a folder" dialog opened by libi's OWN server, for the
 * browser (`npx`) case where there is no Electron bridge. The dialog is a
 * child process: macOS `osascript` (`choose folder` sits above every normal
 * window and asks for no permission — never `tell application "System Events"`,
 * which is what raises the Automation prompt), Windows PowerShell's
 * FolderBrowserDialog under a TopMost owner form, Linux `zenity`. One dialog
 * at a time; a 5-minute cap kills a dialog nobody answers.
 */
export type PickFolderPlatform = "darwin" | "win32" | "linux";
export type PickFolderResult =
  | { status: "picked"; path: string }
  | { status: "cancelled" }
  | { status: "unavailable"; reason: string };
export type PickFolderOutcome = PickFolderResult | { status: "busy" };

export interface PickFolderCommand {
  command: string;
  args: string[];
  /** Layered over the process env. The Windows start dir travels here, never inside `-Command`. */
  env?: Record<string, string>;
}

export const PICK_FOLDER_PROMPT = "Choose a project folder";
export const PICK_FOLDER_TIMEOUT_MS = 300_000;
/** How long a killed dialog gets to close after SIGTERM before it is SIGKILLed and given up on. */
export const PICK_FOLDER_KILL_GRACE_MS = 3_000;

const WINDOWS_SCRIPT = [
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
  "Add-Type -AssemblyName System.Windows.Forms",
  "$owner = New-Object System.Windows.Forms.Form -Property @{TopMost=$true; ShowInTaskbar=$false; WindowState='Minimized'}",
  "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
  `$d.Description = '${PICK_FOLDER_PROMPT}'`,
  "$d.ShowNewFolderButton = $true",
  "if ($env:LIBI_START_DIR) { $d.SelectedPath = $env:LIBI_START_DIR }",
  "$r = $d.ShowDialog($owner)",
  "$owner.Dispose()",
  "if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath); exit 0 } else { exit 1 }",
].join("; ");

/** Pure: the exact command for a platform. `startDir` is passed only when the caller has checked it exists. */
export function pickFolderCommand(platform: PickFolderPlatform, startDir: string | null): PickFolderCommand {
  if (platform === "darwin") {
    const body = startDir
      ? "POSIX path of (choose folder with prompt (item 1 of argv) default location (POSIX file (item 2 of argv)))"
      : "POSIX path of (choose folder with prompt (item 1 of argv))";
    return {
      command: "osascript",
      args: ["-e", "on run argv", "-e", body, "-e", "end run", PICK_FOLDER_PROMPT, ...(startDir ? [startDir] : [])],
    };
  }
  if (platform === "win32") {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-STA", "-Command", WINDOWS_SCRIPT],
      env: startDir ? { LIBI_START_DIR: startDir } : {},
    };
  }
  return {
    command: "zenity",
    args: [
      "--file-selection",
      "--directory",
      `--title=${PICK_FOLDER_PROMPT}`,
      ...(startDir ? [`--filename=${startDir.endsWith("/") ? startDir : `${startDir}/`}`] : []),
    ],
  };
}

/** Trim, then drop ONE trailing separator unless the path is a root (`/`, `C:\`). */
export function normalizePickedPath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length > 1 && /[\\/]$/.test(trimmed) && !/^[A-Za-z]:[\\/]$/.test(trimmed)) return trimmed.slice(0, -1);
  return trimmed;
}

/** The only stderr content that turns a Linux exit 1 into a real failure rather than a Cancel. */
const LINUX_DISPLAY_FAILURE = /cannot open display|failed to open display/i;

export function mapPickFolderExit(
  platform: PickFolderPlatform,
  exit: { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean; spawnError?: NodeJS.ErrnoException | null },
): PickFolderResult {
  if (exit.spawnError) {
    const program = pickFolderCommand(platform, null).command;
    const reason = exit.spawnError.code === "ENOENT" ? `${program} is not installed` : exit.spawnError.message;
    return { status: "unavailable", reason };
  }
  if (exit.timedOut) return { status: "unavailable", reason: "timed out" };
  if (exit.code === 0) return { status: "picked", path: normalizePickedPath(exit.stdout) };
  const firstLine = firstStderrLine(platform, exit.stderr);
  if (exit.code === 1) {
    // macOS (measured): a cancel always says (-128); any other exit 1 is a failure (-1700 etc.).
    if (platform === "darwin" && /\(-128\)\s*$/.test(exit.stderr)) return { status: "cancelled" };
    // Windows exits 1 on Cancel too, but silently. Exit 1 WITH something on stderr is a failure
    // (PowerShell in a session without a desktop).
    if (platform === "win32" && firstLine === undefined) return { status: "cancelled" };
    // Linux: a normal zenity Cancel can print harmless warning noise on stderr (dbind-WARNING when
    // it can't reach the accessibility bus, Adwaita-WARNING theme complaints, …) — none of that is a
    // failure. Only a known display failure turns exit 1 into "unavailable".
    if (platform === "linux" && !LINUX_DISPLAY_FAILURE.test(exit.stderr)) return { status: "cancelled" };
  }
  if (platform === "linux" && exit.code === 5) return { status: "unavailable", reason: "timed out" };
  return {
    status: "unavailable",
    reason: firstLine ?? (exit.signal ? `ended by ${exit.signal}` : `exited with code ${exit.code ?? "unknown"}`),
  };
}

/**
 * The first meaningful stderr line. On Linux, GTK's informational `Gtk-Message:` lines (e.g.
 * "GtkDialog mapped without a transient parent") are printed on a normal cancel and are not
 * failures; `Gtk-WARNING` is kept, because "cannot open display" arrives as one.
 */
function firstStderrLine(platform: PickFolderPlatform, stderr: string): string | undefined {
  return stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !(platform === "linux" && /^Gtk-Message:/.test(l)));
}

export interface ChildLike {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: "close" | "error", cb: (...a: never[]) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}
export type SpawnLike = (command: string, args: string[], options: { env: NodeJS.ProcessEnv; windowsHide: boolean }) => ChildLike;

function currentPlatform(): PickFolderPlatform {
  if (isMac()) return "darwin";
  if (isWindows()) return "win32";
  return "linux";
}

/** An existing DIRECTORY. A file path makes macOS fail with -1700 and show no dialog at all. */
function isExistingDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

let inFlight: Promise<PickFolderResult> | null = null;

export function isPickFolderBusy(): boolean {
  return inFlight !== null;
}

/**
 * Open the dialog. Resolves with the outcome; `busy` when another dialog is still open. Never
 * rejects, and always settles: a dialog that will not close is SIGKILLed and given up on, and an
 * aborted `signal` (the HTTP request went away) closes the dialog and resolves `cancelled`.
 */
export async function pickFolder(
  opts: {
    initialPath?: string | null;
    platform?: PickFolderPlatform;
    spawnImpl?: SpawnLike;
    isDirectory?: (p: string) => boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<PickFolderOutcome> {
  if (inFlight) return { status: "busy" };
  if (opts.signal?.aborted) return { status: "cancelled" };
  const platform = opts.platform ?? currentPlatform();
  const isAbsolute = platform === "win32" ? path.win32.isAbsolute : path.posix.isAbsolute;
  const isDirectory = opts.isDirectory ?? isExistingDirectory;
  const start = opts.initialPath && isAbsolute(opts.initialPath) && isDirectory(opts.initialPath) ? opts.initialPath : null;
  const spawnImpl: SpawnLike = opts.spawnImpl ?? ((c, a, o) => spawn(c, a, o) as unknown as ChildLike);
  const cmd = pickFolderCommand(platform, start);
  const signal = opts.signal;

  inFlight = new Promise<PickFolderResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let child: ChildLike | undefined;
    // Declared (and initialised) before `finish`, which clears it: a synchronous spawn throw calls
    // `finish` before the cap timer exists.
    let timer: NodeJS.Timeout | undefined = undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const finish = (result: PickFolderResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      // Never the picked path: the status (and a failure's reason) is all the log needs.
      logger.info(
        { tag: "skills", op: "pick_folder", platform, status: result.status, ...(result.status === "unavailable" ? { reason: result.reason } : {}) },
        "pick_folder",
      );
      resolve(result);
    };
    const kill = (sig: NodeJS.Signals) => {
      try {
        child?.kill(sig);
      } catch {
        // Already gone.
      }
    };
    /** SIGTERM, then SIGKILL if `close` has not come within the grace period — never wait on it forever. */
    const stop = () => {
      if (settled || killTimer || !child) return;
      clearTimeout(timer);
      kill("SIGTERM");
      killTimer = setTimeout(() => {
        kill("SIGKILL");
        // A timeout that started this kill wins even if an abort follows during the grace period —
        // the dialog was already being torn down for running out of time, not for being abandoned.
        finish(timedOut ? { status: "unavailable", reason: "timed out" } : { status: "cancelled" });
      }, PICK_FOLDER_KILL_GRACE_MS);
    };
    const onAbort = () => {
      aborted = true;
      stop();
    };

    try {
      // Windows: `windowsHide: true` makes the child's first ShowWindow SW_HIDE, which can start
      // the PowerShell dialog hidden. Nothing else has a console window to hide.
      child = spawnImpl(cmd.command, cmd.args, { env: { ...process.env, ...(cmd.env ?? {}) }, windowsHide: platform !== "win32" });
    } catch (err) {
      finish(mapPickFolderExit(platform, { code: null, signal: null, stdout, stderr, timedOut: false, spawnError: err as NodeJS.ErrnoException }));
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, opts.timeoutMs ?? PICK_FOLDER_TIMEOUT_MS);
    signal?.addEventListener("abort", onAbort, { once: true });
    // Decode as UTF-8 across chunk boundaries: a multi-byte character split between two `data`
    // events must not turn into replacement characters.
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => {
      stdout += d;
    });
    child.stderr?.on("data", (d: string) => {
      stderr += d;
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      finish(mapPickFolderExit(platform, { code: null, signal: null, stdout, stderr, timedOut, spawnError: err }));
    });
    // `close`, not `exit`: it fires once both stdio streams have ended, so stdout is complete.
    child.on("close", (code: number | null, exitSignal: NodeJS.Signals | null) => {
      // As in `stop`: an abort that arrives while a timeout kill is already under way does not turn
      // it into a cancel — whether the dialog then closes or has to be SIGKILLed, it timed out.
      if (aborted && !timedOut) finish({ status: "cancelled" });
      else finish(mapPickFolderExit(platform, { code, signal: exitSignal, stdout, stderr, timedOut }));
    });
  }).finally(() => {
    inFlight = null;
  });
  return inFlight;
}
