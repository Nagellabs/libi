// lib/codex-config/backup.ts
//
// Keep a recoverable copy of the user's `config.toml` from before `libi connect`
// asks codex to touch it. That CLI — run by the user from their own terminal —
// is the only caller left: the studio server never writes an agent's config.
//
// ## Why this exists
//
// libi never hand-edits `config.toml` — that is a hard rule, and it is the
// right one: codex re-serializes the file on write, so an edit libi made by
// hand would be mangled by codex's next write anyway. Registration therefore
// goes through `codex mcp add`, codex's own command.
//
// But codex re-serializes on `mcp add` too, and QA measured what that costs a
// user with a hand-written config (codex-cli 0.153.4). A single
// `codex mcp add` on an unrelated server:
//
//     - args = []                   ← DROPPED from the user's node_repl entry
//     - startup_timeout_sec = 120   ← becomes 120.0 (int → float)
//       … 16 env keys reordered …
//
// and `codex mcp remove` does NOT put any of it back: an add+remove round trip
// is not a no-op. That is codex's behaviour, not libi's bug — but when
// `libi connect` runs it, libi is the proximate cause.
//
// So the write is made RECOVERABLE, and the CLI says so where the user can see
// it. This module is the recoverable half: a timestamped copy, taken
// immediately before the spawn, logged with its path.
//
// ## Why de-duplication matters here and not in `backupDb`
//
// `libi connect` can be re-run any number of times, and each run may spawn
// more than one `codex mcp` command. Copying an unchanged file each time would
// roll the one revision the user actually wants off the end of the retention
// window.
// So a backup is written only when the current bytes differ from the newest
// backup already on disk — which is exactly when there is something new to
// protect.

import fs from "node:fs";
import path from "node:path";

import { serverLogger as logger } from "@/lib/logger";

const LOG_TAG = "codex-config";

/** Matches the filenames older libi versions used, so one listing finds both. */
const BACKUP_PREFIX = "config.toml.libi-backup-";

/**
 * Distinct revisions retained. Higher than `backupDb`'s 3 because the file is
 * a few KB and repeated `libi connect` runs can produce several genuine revisions.
 */
const MAX_BACKUPS = 5;

function backupTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Existing backups in a codex home, newest first. */
export function listCodexConfigBackups(codexHome: string): string[] {
  try {
    return fs
      .readdirSync(codexHome)
      .filter((f) => f.startsWith(BACKUP_PREFIX))
      .sort()
      .reverse()
      .map((f) => path.join(codexHome, f));
  } catch {
    return [];
  }
}

function pruneBackups(codexHome: string): void {
  for (const old of listCodexConfigBackups(codexHome).slice(MAX_BACKUPS)) {
    try {
      fs.unlinkSync(old);
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Copy `<codexHome>/config.toml` aside before codex rewrites it.
 *
 * Returns the backup path, or `null` when there was nothing to protect (no
 * config yet, or the newest backup already holds these bytes). NEVER throws:
 * failing to take a backup must not fail the registration the user asked for.
 */
export function backupCodexConfig(codexHome: string): string | null {
  const configPath = path.join(codexHome, "config.toml");
  try {
    if (!fs.existsSync(configPath)) return null;
    const current = fs.readFileSync(configPath);
    if (current.length === 0) return null;

    const newest = listCodexConfigBackups(codexHome)[0];
    if (newest) {
      try {
        if (fs.readFileSync(newest).equals(current)) return null;
      } catch {
        // Unreadable backup — fall through and write a fresh one.
      }
    }

    // The timestamp has millisecond resolution and two `codex mcp` calls can
    // land inside one — a `libi connect` run can remove and re-add an entry.
    // Without the suffix the second copy overwrites the first, which is the one
    // revision the user actually wants.
    const stamp = backupTimestamp();
    let backupPath = path.join(codexHome, `${BACKUP_PREFIX}${stamp}`);
    for (let n = 1; fs.existsSync(backupPath); n++) {
      backupPath = path.join(codexHome, `${BACKUP_PREFIX}${stamp}-${n}`);
    }
    fs.writeFileSync(backupPath, current);
    logger.info(
      { tag: LOG_TAG, op: "backup_created", path: backupPath },
      "copied config.toml aside before codex rewrote it",
    );
    pruneBackups(codexHome);
    return backupPath;
  } catch (err) {
    logger.warn(
      { tag: LOG_TAG, op: "backup_failed", err: (err as Error).message },
      "could not back up config.toml before running codex mcp",
    );
    return null;
  }
}
