// lib/video-download/launcher.ts
//
// The yt-dlp LAUNCHER libi writes into `<LIBI_HOME>/bin` — what it is, where
// it points, and whether that target is still there. Shared by the three
// places that must agree on "is Video download usable": the installer's
// verify() (`mcp/registry/installers.ts`), the job runner
// (`lib/jobs/runners/video-download.ts`), and the agent-facing tool
// (`mcp/tools/video-download-tools.ts`), which must not import the runner
// (nothing under `mcp/` imports `lib/jobs/*`). Kept free of the runner and of
// the DependencyManager for that reason.
//
// Why the TARGET matters, not just the file: on 2026-09-25 the owner's
// `~/.libi/bin/yt-dlp` exec'd `…/.libi/worktrees/mcp-http/uv/tools/yt-dlp/
// bin/yt-dlp` — a worktree that had since been deleted. The launcher existed
// and its install token was current, so libi called it installed, skipped the
// auto-install, spawned it, got exit 126, and told the agent to send the user
// to Settings. A launcher is only installed when the thing it execs exists.

import fs from "node:fs";
import path from "node:path";
import { getLibiBinDir } from "@/lib/libi-home";
import { isWindows } from "@/lib/platform";

/**
 * Prefix on every job error that means "libi could not make yt-dlp usable"
 * (install failed, repair failed, launcher still dead after a repair). The
 * tool turns exactly these into `needs_install`; every other failure is a
 * `download_failed` the agent reports as-is. A fixed marker instead of a
 * regex over free text, because the old `/ENOENT|not found|no such file/`
 * also matched yt-dlp's own "Video not found".
 */
export const YT_DLP_UNAVAILABLE = "yt-dlp unavailable:";

/** Where the agent's user finds the extension's chips (Download / Retry /
 *  Re-download). The ONE place the UI location is spelled, so the tool
 *  message, its description and the manual cannot drift from each other. */
export const VIDEO_DOWNLOAD_UI_PATH = "Agents → Libi MCP → Video download";

/** `<LIBI_HOME>/bin/yt-dlp` (Unix shell wrapper) or `yt-dlp.cmd` (Windows
 *  shim — symlinks need admin there). */
export function ytDlpLauncherPath(): string {
  return path.join(getLibiBinDir(), isWindows() ? "yt-dlp.cmd" : "yt-dlp");
}

/**
 * The absolute entry point a libi-written launcher runs, or null when the
 * text is not in the shape libi writes (`installYtDlpViaUv`):
 *   Unix      `exec "<entry>" --no-playlist "$@"`
 *   Windows   `  "<entry>" --no-playlist %*`
 * The FIRST quoted target wins; libi writes the same one on every line.
 */
export function parseYtDlpLauncherTarget(text: string): string | null {
  const unix = /\bexec\s+"([^"]+)"/.exec(text)?.[1];
  if (unix) return unix;
  const cmd = /^\s*"([^"]+)"\s/m.exec(text)?.[1];
  return cmd ?? null;
}

/**
 * One shell word at the start of `text`, unquoted — or null when it is not a word this parser can
 * read with certainty. uv shell-quotes the interpreter path (`shlex`-style), so a `'` in it
 * arrives as `'"'"'` (or, from other writers, `'\''`): concatenated single-quoted runs,
 * double-quoted runs and backslash-escaped characters. The word must end at whitespace. Anything
 * else — an unterminated quote, an unquoted `$` / backtick / glob, a word glued to the next — is
 * a parse doubt, and a doubt is null, never a guess.
 */
function readShellWord(text: string): string | null {
  let out = "";
  let i = 0;
  while (i < text.length && !/\s/.test(text[i])) {
    const ch = text[i];
    if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) return null;
      out += text.slice(i + 1, end);
      i = end + 1;
    } else if (ch === '"') {
      i++;
      let closed = false;
      while (i < text.length) {
        const c = text[i];
        if (c === '"') {
          closed = true;
          i++;
          break;
        }
        if (c === "$" || c === "`") return null;
        if (c === "\\" && i + 1 < text.length && '"\\$`'.includes(text[i + 1])) {
          out += text[i + 1];
          i += 2;
          continue;
        }
        if (c === "\n") return null;
        out += c;
        i++;
      }
      if (!closed) return null;
    } else if (ch === "\\") {
      if (i + 1 >= text.length || text[i + 1] === "\n") return null;
      out += text[i + 1];
      i += 2;
    } else if (/[A-Za-z0-9_./+@%,:=-]/.test(ch)) {
      out += ch;
      i++;
    } else {
      return null;
    }
  }
  // The word has to be followed by whitespace (uv's ` "$0" "$@"`), or it was glued to something.
  if (i >= text.length || !/[ \t]/.test(text[i])) return null;
  return out;
}

/**
 * The interpreter a Unix entry point's shebang names, when it names one by
 * absolute path. uv writes either `#!<venv>/bin/python3`, or — for a path
 * with spaces or one too long for a shebang — `#!/bin/sh` followed by
 * `'''exec' '<venv>/bin/python' "$0" "$@"`. Returns null when there is
 * nothing to check (a binary, an `env` shebang, an unreadable file).
 */
export function parseEntryInterpreter(head: string): string | null {
  // uv quotes the path with SINGLE quotes (`'''exec' '<venv>/bin/python' "$0" "$@"`
  // — verified with uv 0.11.32 on a path containing spaces, which is every packaged
  // macOS home under "Application Support"), escaping a `'` in it as `'"'"'` (verified
  // on "o'brien home"); double quotes are accepted too. A trampoline that does not read
  // unambiguously has nothing to check (null): a false `interpreter_missing` would
  // reinstall yt-dlp on every use and never succeed.
  const trampoline = /^'''exec' (.*)$/m.exec(head);
  if (trampoline) {
    const word = readShellWord(trampoline[1]);
    return word && path.isAbsolute(word) ? word : null;
  }
  const shebang = /^#!\s*(\S+)/.exec(head)?.[1];
  if (!shebang || shebang === "/bin/sh" || shebang.endsWith("/env")) return null;
  return shebang;
}

export type YtDlpLauncherHealth =
  | { ok: true; launcher: string; target: string }
  | {
      ok: false;
      launcher: string;
      /** `missing` — no launcher (a fresh machine: the first-use install).
       *  `unrecognised` — a file libi did not write, or no target in it.
       *  `target_missing` — the entry point it execs is gone.
       *  `interpreter_missing` — the entry exists but its Python does not. */
      reason: "missing" | "unrecognised" | "target_missing" | "interpreter_missing";
      target: string | null;
    };

export interface LauncherFs {
  readFile: (p: string) => string;
  exists: (p: string) => boolean;
  /** The start of a file; omitted = skip the interpreter check. */
  readHead?: (p: string) => string;
}

/** First 512 bytes — enough for either shebang shape, without reading a
 *  whole binary entry point (the Windows `.exe` trampoline). */
function readHead(p: string): string {
  const fd = fs.openSync(p, "r");
  try {
    const buf = Buffer.alloc(512);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf-8");
  } finally {
    fs.closeSync(fd);
  }
}

const realFs: LauncherFs = {
  readFile: (p) => fs.readFileSync(p, "utf-8"),
  exists: (p) => fs.existsSync(p),
  readHead,
};

/**
 * Is libi's yt-dlp launcher runnable, judged from the files alone — no spawn,
 * so it is cheap enough for every `ensureDep` and every tool call. `exists`
 * follows symlinks, so a venv `python3` whose base interpreter was removed
 * counts as missing too.
 */
export function checkYtDlpLauncher(io: LauncherFs = realFs): YtDlpLauncherHealth {
  const launcher = ytDlpLauncherPath();
  let text: string;
  try {
    text = io.readFile(launcher);
  } catch {
    return { ok: false, launcher, reason: "missing", target: null };
  }
  const target = parseYtDlpLauncherTarget(text);
  if (!target || !path.isAbsolute(target)) {
    return { ok: false, launcher, reason: "unrecognised", target };
  }
  if (!io.exists(target)) return { ok: false, launcher, reason: "target_missing", target };
  if (!isWindows() && io.readHead) {
    let interpreter: string | null = null;
    try {
      interpreter = parseEntryInterpreter(io.readHead(target));
    } catch {
      interpreter = null;
    }
    if (interpreter && !io.exists(interpreter)) {
      return { ok: false, launcher, reason: "interpreter_missing", target };
    }
  }
  return { ok: true, launcher, target };
}
