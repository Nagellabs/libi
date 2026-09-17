/**
 * The per-binary `dependencyStatus` transitions on an `mcp_servers` row —
 * a LEAF so both writers can share it without importing each other:
 *
 *   - `DependencyManager.writeDepTransition` (every Category A / retry path)
 *   - `lib/export/ensure-chromium.ts`, which streams the Chromium download
 *     and writes `installing` (+ bytes) → `installed | failed` itself.
 *
 * `DependencyManager.retryDep` now calls `ensureChromium` for the chromium
 * dep (one install path, one single-flight), so ensure-chromium importing the
 * manager class for this write would be a cycle.
 *
 * The "no DB writes before migrations have run" invariant lives HERE, in the
 * leaf, rather than in the manager. Category A runs in the CLI parent
 * before Category B has migrated, so a write from that process targets a
 * schemaless database; the guard used to be a `private skipDbWrites` field on
 * `DependencyManager`, which meant a future Category A caller reaching this
 * function any other way — ensure-chromium, a new installer, a job runner —
 * bypassed it entirely, and the invariant was documented rather than enforced.
 * It is one flag now: `setDepDbWritesSuppressed` is what
 * `DependencyManager.setSkipDbWrites` sets, and the manager reads it back.
 *
 * Process-scoped, because that is what the invariant actually is: "THIS
 * process runs before migrations". `ensure-chromium` never runs in Category A,
 * so it is unaffected in practice — but it is now covered rather than trusted.
 */
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { mcpServers } from "@/lib/db/schema/sqlite";
import { navigationEmitter } from "@/lib/navigation-events";
import type { DependencyStatus } from "./types";

/**
 * Are DB writes suppressed in this process? See the module docblock.
 *
 * Default `false` — every caller outside Category A (the Settings resync, a
 * retry, an export's Chromium download) writes normally.
 */
let dbWritesSuppressed = false;

/** Set by `DependencyManager.setSkipDbWrites`; there is no second flag. */
export function setDepDbWritesSuppressed(suppressed: boolean): void {
  dbWritesSuppressed = suppressed;
}

export function depDbWritesSuppressed(): boolean {
  return dbWritesSuppressed;
}

function readList(mcpId: string): { list: DependencyStatus[]; present: boolean } {
  const db = getDb();
  const [row] = db
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.id, mcpId))
    .limit(1)
    .all();
  if (!row) return { list: [], present: false };
  try {
    return { list: JSON.parse(row.dependencyStatus ?? "[]"), present: true };
  } catch {
    return { list: [], present: true };
  }
}

/** The last transition written for one binary, or null when none was. */
export function readDepTransition(mcpId: string, binary: string): DependencyStatus | null {
  return readList(mcpId).list.find((s) => s.binary === binary) ?? null;
}

/**
 * Patch the live `dependencyStatus` JSON for a single binary so callers (UI,
 * agent) can see in-flight transitions before an aggregate refresh. Reads the
 * row, merges the patch into the matching entry (creating one if absent),
 * writes back.
 */
export function writeDepTransition(
  mcpId: string,
  binary: string,
  patch: Partial<DependencyStatus>,
): void {
  if (dbWritesSuppressed) return;
  const { list, present } = readList(mcpId);
  if (!present) return;
  const idx = list.findIndex((s) => s.binary === binary);
  if (idx === -1) {
    list.push({
      binary,
      installed: false,
      path: null,
      source: null,
      runtimeStatus: "pending",
      ...patch,
    });
  } else {
    list[idx] = { ...list[idx], ...patch };
  }
  getDb()
    .update(mcpServers)
    .set({ dependencyStatus: JSON.stringify(list), updatedAt: new Date() })
    .where(eq(mcpServers.id, mcpId))
    .run();

  // Emit refresh_query so future Settings UI subscribers can invalidate the
  // mcp-servers query and re-render the dep chip. Today the Settings page
  // uses React Query polling and doesn't subscribe to SSE directly; this
  // emit is preparatory wiring for a future event-driven refresh path.
  try {
    navigationEmitter.emit("refresh_query", { queryKey: "mcp-servers" });
  } catch {
    /* non-fatal — emit must not break the install loop */
  }
}
