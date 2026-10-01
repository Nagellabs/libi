// electron/copy-file.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { clipboard, ipcMain } from "electron";
import { mainSyncLog } from "./sync-log";
import { MAC_FILE_CLIPBOARD_FORMAT, WINDOWS_FILE_CLIPBOARD } from "./clipboard-formats";

/**
 * "Copy" on an export (spec 2026-09-29 §A6): put the FILE on the OS clipboard,
 * so it pastes into Finder, Messages or Slack. The renderer names a path; main
 * copies it only when it is a regular file directly inside a piece's exports
 * folder under libi's storage — never an arbitrary path.
 *
 * Answers `true` when the file itself is on the clipboard and `false` when it
 * is not (a refused path, a platform that can't, a failed write): the renderer
 * then copies the path and says so. Feature-detected by the renderer — adding
 * it needs no SHELL_API_VERSION bump.
 */
export const COPY_FILE_CHANNEL = "libi:copy-file";

/**
 * libi's storage roots as the server resolves them: `STORAGE_DIR` when set
 * (lib/storage/local.ts), and `<LIBI_HOME>/storage` where LIBI_HOME is the env
 * var, else `~/.libi/config.json`'s `libiHome`, else `~/.libi`
 * (lib/libi-home.ts#getLibiHome). electron/ can't import lib/; the test pins
 * the parity.
 */
export function libiStorageRoots(env: Record<string, string | undefined> = process.env, home: string = os.homedir()): string[] {
  const roots: string[] = [];
  if (env.STORAGE_DIR) roots.push(env.STORAGE_DIR);
  let libiHome = env.LIBI_HOME;
  if (!libiHome) {
    const defaultHome = path.join(home, ".libi");
    libiHome = defaultHome;
    try {
      const config = JSON.parse(fs.readFileSync(path.join(defaultHome, "config.json"), "utf-8")) as { libiHome?: unknown };
      if (typeof config.libiHome === "string" && config.libiHome) libiHome = config.libiHome;
    } catch {
      // No config.json — the default home.
    }
  }
  roots.push(path.join(libiHome, "storage"));
  return roots;
}

/** The real path of `candidate` when it is a regular file at `<root>/<pieceId>/exports/<file>`; else null. */
export function copyableExportPath(candidate: unknown, roots: string[]): string | null {
  if (typeof candidate !== "string" || !path.isAbsolute(candidate)) return null;
  let real: string;
  try {
    real = fs.realpathSync(candidate);
    if (!fs.statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = fs.realpathSync(root);
    } catch {
      continue;
    }
    const rel = path.relative(realRoot, real);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    const parts = rel.split(path.sep);
    if (parts.length === 3 && parts[1] === "exports") return real;
  }
  return null;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function filenamesPlist(file: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' +
    `<plist version="1.0"><array><string>${escapeXml(file)}</string></array></plist>`
  );
}

/** Put the file on the clipboard. True when the FILE (not its path) is there. */
export function writeFileToClipboard(realPath: string, platform: NodeJS.Platform): boolean {
  if (platform === "darwin") {
    if (MAC_FILE_CLIPBOARD_FORMAT === "NSFilenamesPboardType") {
      clipboard.writeBuffer("NSFilenamesPboardType", Buffer.from(filenamesPlist(realPath), "utf8"));
    } else {
      clipboard.writeBuffer("public.file-url", Buffer.from(pathToFileURL(realPath).href, "utf8"));
    }
    return true;
  }
  if (platform === "win32" && WINDOWS_FILE_CLIPBOARD === "powershell-filedrop") {
    // The path travels in an env var, never inside the command string.
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Set-Clipboard -LiteralPath $env:LIBI_COPY_PATH"], {
      env: { ...process.env, LIBI_COPY_PATH: realPath },
      windowsHide: true,
      timeout: 5000,
    });
    return true;
  }
  return false;
}

export function registerCopyFileIpc(opts: { roots?: () => string[]; platform?: NodeJS.Platform } = {}): void {
  const roots = opts.roots ?? (() => libiStorageRoots());
  const platform = opts.platform ?? process.platform;
  ipcMain.handle(COPY_FILE_CHANNEL, (_e, candidate: unknown): boolean => {
    const real = copyableExportPath(candidate, roots());
    if (!real) {
      mainSyncLog("copy-file: refused a path that is not one of libi's exports");
      return false;
    }
    try {
      return writeFileToClipboard(real, platform);
    } catch (err) {
      mainSyncLog(`copy-file: clipboard write failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  });
}
