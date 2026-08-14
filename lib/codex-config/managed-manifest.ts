/**
 * Managed-name manifest for codex-native MCP writes.
 *
 * Codex owns its own `~/.codex/config.toml` (libi shells out to `codex mcp
 * add`/`remove` rather than editing the TOML). To avoid ever removing a server
 * the USER added by hand, libi records the names IT added in a sidecar manifest
 * at `<codexHome>/.libi-managed-mcps.json`. The sync layer removes only names
 * present in this set — never the user's own entries.
 *
 * Mirrors the skills-writer manifest convention (`mcp/skills/writer.ts`):
 * `{ managed: string[] }`, missing/malformed → treat as absent (empty set),
 * sorted output, write-only-on-change discipline.
 */

import fs from "fs";
import path from "path";

const MANIFEST_FILE = ".libi-managed-mcps.json";

function manifestPath(codexHome: string): string {
  return path.join(codexHome, MANIFEST_FILE);
}

/**
 * Names of MCP servers libi wrote to the Codex config previously. A missing OR
 * malformed manifest yields an empty set — libi then manages only what it
 * creates from that point on (never touching the user's hand-added servers).
 */
export function readManagedNames(codexHome: string): Set<string> {
  const p = manifestPath(codexHome);
  if (!fs.existsSync(p)) return new Set();
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
    if (parsed && Array.isArray(parsed.managed)) {
      return new Set(
        parsed.managed.filter((n: unknown): n is string => typeof n === "string"),
      );
    }
  } catch {
    // malformed → treat as absent
  }
  return new Set();
}

/**
 * Atomically write the managed-name set to the manifest. Output is sorted and
 * only rewritten when the on-disk content differs (write-only-on-change), then
 * flushed via a temp-file rename so a crash mid-write never leaves a partial
 * manifest.
 */
export function writeManagedNames(codexHome: string, names: Set<string>): void {
  const p = manifestPath(codexHome);
  const next = JSON.stringify({ managed: [...names].sort() }, null, 2) + "\n";

  let existing: string | null = null;
  try {
    existing = fs.readFileSync(p, "utf-8");
  } catch {
    existing = null;
  }
  if (existing === next) return;

  fs.mkdirSync(codexHome, { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, next);
  fs.renameSync(tmp, p);
}
