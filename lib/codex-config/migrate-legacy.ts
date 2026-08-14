/**
 * One-time, canonical-only migration that strips libi's LEGACY marker block
 * from the user's real `~/.codex/config.toml`.
 *
 * ## Why this exists
 *
 * An OLD version of the Codex writer wrapped its managed section in two comment
 * lines: `# libi-mcp-servers-start` and `# libi-mcp-servers-end`. Codex
 * re-serializes `config.toml` on its own writes and FLOATS those bare comment
 * lines to the very top and bottom of the file — trapping the user's own TOML
 * tables (`[projects.*]`, `[tui.*]`, `[marketplaces.*]`, `[plugins.*]`, bare
 * top-level keys like `notify`) BETWEEN the two markers. The new sync layer must
 * remove ONLY:
 *   (a) the two marker comment lines, and
 *   (b) the `[mcp_servers.<name>]` tables that libi OWNS,
 * and preserve every other byte of the user's file.
 *
 * ## Guiding principle: on ANY ambiguity, LEAVE content rather than remove it.
 *
 * This file has been corrupted twice already. The strip is deliberately
 * conservative: it only deletes a table when its name is in the owned set, and
 * it treats everything it doesn't recognize as user content to keep.
 */

import fs from "fs";
import path from "path";
import { serverLogger as logger } from "@/lib/logger";
import { isCanonicalLibiInstance, resolveCodexHome } from "./canonical";
import { BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";

/** The legacy marker comment lines the OLD writer emitted. They now live HERE
 * as the thing being removed — this is the only `libi-mcp-servers-` occurrence
 * in lib/mcp/app. */
export const START_MARKER = "# libi-mcp-servers-start";
export const END_MARKER = "# libi-mcp-servers-end";

/**
 * Parse a TOML table header line into its dotted key PATH (the `.`-joined key
 * segments), or null if the line is not a table header.
 *
 * Handles both bare (`[mcp_servers.libi]`) and quoted
 * (`[mcp_servers."YouTube Downloader"]`) segments. The returned path uses the
 * UNQUOTED inner value for quoted segments, so both header forms compare
 * equally against the owned-name set.
 */
function parseTableHeaderPath(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  // Reject array-of-tables (`[[...]]`) — not a shape the old writer produced,
  // and safer to treat as opaque user content.
  if (trimmed.startsWith("[[")) return null;

  const inner = trimmed.slice(1, -1).trim();
  if (inner.length === 0) return null;

  const segments: string[] = [];
  let i = 0;
  while (i < inner.length) {
    // Skip a leading dot between segments.
    if (inner[i] === ".") {
      i += 1;
      continue;
    }
    if (inner[i] === '"') {
      // Quoted segment — read until the closing unescaped quote.
      let j = i + 1;
      let value = "";
      while (j < inner.length) {
        if (inner[j] === "\\" && j + 1 < inner.length) {
          value += inner[j + 1];
          j += 2;
          continue;
        }
        if (inner[j] === '"') break;
        value += inner[j];
        j += 1;
      }
      if (j >= inner.length) return null; // unterminated quote → not a valid header
      segments.push(value);
      i = j + 1;
    } else {
      // Bare segment — read until the next dot.
      let j = i;
      let value = "";
      while (j < inner.length && inner[j] !== ".") {
        value += inner[j];
        j += 1;
      }
      segments.push(value.trim());
      i = j;
    }
  }
  return segments.length > 0 ? segments : null;
}

/**
 * The owned mcp_servers name for a header path, or null if the header is not an
 * `[mcp_servers.<name>...]` table owned by libi.
 *
 * `mcp_servers.<name>` and `mcp_servers.<name>.env` both resolve to `<name>`.
 */
function ownedServerNameForHeader(pathSegments: string[], ownedNames: Set<string>): string | null {
  if (pathSegments.length < 2) return null;
  if (pathSegments[0] !== "mcp_servers") return null;
  const name = pathSegments[1];
  return ownedNames.has(name) ? name : null;
}

/**
 * Remove the legacy marker comment lines and every libi-owned
 * `[mcp_servers.<name>]` table block from `contents`. Everything else is
 * preserved byte-for-byte.
 *
 * A "block" runs from an owned table header line THROUGH the line just before
 * the next TABLE HEADER whose path does NOT continue the owned server's path
 * (so `[mcp_servers.<name>.env]` is removed WITH its parent, but a different
 * `[mcp_servers.other]` or any `[projects.*]` starts a new, preserved block).
 *
 * This is a pure function: given a marker-less input it makes no non-marker
 * changes, but the caller (the sweep) only invokes it when a marker IS present.
 */
export function stripLegacyLibiBlock(contents: string, ownedNames: Set<string>): string {
  // Identity when there is no legacy marker to migrate. This is what makes the
  // whole operation safe: a config that libi never wrote (no markers) is
  // returned byte-for-byte unchanged, even if the user happens to have their
  // OWN `[mcp_servers.libi]` table. We only strip owned tables in the presence
  // of a marker, i.e. a file the old writer actually produced.
  if (!contents.includes(START_MARKER) && !contents.includes(END_MARKER)) {
    return contents;
  }

  const lines = contents.split("\n");
  const out: string[] = [];

  // When inside an owned table block, this holds the owned server name whose
  // sub-tables should also be dropped; null means we are keeping lines.
  let droppingOwnedName: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // (a) Marker comment lines — always dropped.
    if (trimmed === START_MARKER || trimmed === END_MARKER) {
      continue;
    }

    const headerPath = parseTableHeaderPath(line);

    if (headerPath) {
      // A new table header decides whether we (still) drop or start keeping.
      const ownedName = ownedServerNameForHeader(headerPath, ownedNames);
      if (ownedName) {
        // Start (or continue) dropping this owned server's block.
        droppingOwnedName = ownedName;
        continue;
      }
      // Header is NOT an owned server. If we were dropping an owned block,
      // does THIS header continue that owned server's path (a sub-table)?
      if (
        droppingOwnedName &&
        headerPath[0] === "mcp_servers" &&
        headerPath[1] === droppingOwnedName
      ) {
        // e.g. [mcp_servers.<owned>.env] — still part of the owned block.
        continue;
      }
      // Any other header ends the owned block and is itself kept.
      droppingOwnedName = null;
      out.push(line);
      continue;
    }

    // Non-header line: drop it if we're inside an owned block, else keep it.
    if (droppingOwnedName) continue;
    out.push(line);
  }

  return out.join("\n");
}

/** Injectable dependencies for {@link sweepLegacyCodexConfig} — keeps the sweep
 * pure/testable and, critically, lets tests assert that a NON-canonical
 * instance never opens the real `~/.codex/config.toml`. */
export interface SweepDeps {
  /** Canonical-instance guard — the sweep returns immediately when false. */
  isCanonical: () => boolean;
  /** Codex home dir; `config.toml` is resolved beneath it. */
  codexHome: string;
  /** The set of mcp_servers table names libi owns (`libi` + bundled names). */
  ownedNames: Set<string>;
  /** Read a file to a string; throws (ENOENT) when missing. */
  readFile: (filePath: string) => string;
  /** Write a string to a file. */
  writeFile: (filePath: string, contents: string) => void;
  /** Filesystem-safe timestamp for the backup filename. */
  now: () => string;
  /** Optional structured warn for the never-throw catch. */
  warn?: (err: unknown, op: string) => void;
}

/**
 * One-time boot sweep: strip the legacy marker block from the canonical user's
 * `~/.codex/config.toml`, backing the original up first.
 *
 * Contract (in order):
 *   1. `!isCanonical()` → return immediately, WITHOUT reading the file.
 *   2. Missing file → no-op.
 *   3. No marker present → no-op AND no backup.
 *   4. Marker present → write `config.toml.libi-backup-<ts>` (the ORIGINAL
 *      bytes) FIRST, then write the stripped result over `config.toml`.
 *
 * Idempotent (step 3 means a second run after a successful strip is a no-op).
 * Wrapped in try/catch → warn-and-continue; it NEVER throws, so a strip failure
 * can never block boot.
 */
export function sweepLegacyCodexConfig(deps: SweepDeps): void {
  // 1. Canonical-only. Return before touching the filesystem at all.
  if (!deps.isCanonical()) return;

  try {
    const configPath = path.join(deps.codexHome, "config.toml");

    let contents: string;
    try {
      contents = deps.readFile(configPath);
    } catch (err) {
      // Missing file (or unreadable) → nothing to migrate.
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
      throw err;
    }

    // 3. No marker → no-op, no backup. (Also the idempotency guarantee.)
    if (!contents.includes(START_MARKER) && !contents.includes(END_MARKER)) {
      return;
    }

    const stripped = stripLegacyLibiBlock(contents, deps.ownedNames);

    // 4. Backup the ORIGINAL bytes FIRST, then overwrite the config.
    const backupPath = path.join(deps.codexHome, `config.toml.libi-backup-${deps.now()}`);
    deps.writeFile(backupPath, contents);
    deps.writeFile(configPath, stripped);
  } catch (err) {
    // Best-effort. A strip failure must NEVER block boot.
    deps.warn?.(err, "legacy_migrate");
  }
}

/** libi-owned mcp_servers table names: `libi` core + every bundled def name. */
export function ownedCodexServerNames(): Set<string> {
  return new Set<string>(["libi", ...BUNDLED_MCP_SERVERS.map((d) => d.name)]);
}

/**
 * Production entrypoint wired to the real canonical guard, Codex home, bundled
 * registry, filesystem, and server logger. Called once at boot (Category B) as
 * a non-fatal, canonical-only step.
 */
export function sweepLegacyCodexConfigOnBoot(): void {
  sweepLegacyCodexConfig({
    isCanonical: isCanonicalLibiInstance,
    codexHome: resolveCodexHome(),
    ownedNames: ownedCodexServerNames(),
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    writeFile: (p, contents) => fs.writeFileSync(p, contents, "utf-8"),
    now: () => new Date().toISOString().replace(/[:.]/g, "-"),
    warn: (err, op) =>
      logger.warn(
        { err, tag: "codex-config", op },
        "legacy codex config marker-block migration failed (non-fatal)",
      ),
  });
}
