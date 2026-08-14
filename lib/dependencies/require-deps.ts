import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { mcpServers } from "@/lib/db/schema/sqlite";
import type { DependencyStatus } from "@/mcp/registry/types";

/**
 * Structural subset of `DependencyStatus` returned for not-yet-installed deps.
 * `runtimeStatus` excludes `"installed"` because `requireDeps` filters those out
 * before constructing the result — keeps the union honest at the type level.
 */
export type MissingDep = Pick<
  DependencyStatus,
  "binary" | "error" | "bytesDownloaded" | "bytesTotal"
> & {
  runtimeStatus: Exclude<DependencyStatus["runtimeStatus"], "installed">;
};

/**
 * Returns the subset of `binaries` that are NOT installed for the given mcpId.
 * Empty array means "all good — caller may proceed".
 *
 * mcpId-agnostic: works for any MCP row (e.g. "libi", "elevenlabs"), not just libi.
 *
 * Sync because the underlying DB driver (better-sqlite3) is sync — no need to
 * Promise-wrap. If the driver ever becomes async, callers can be updated then.
 */
export function requireDeps(
  mcpId: string,
  binaries: string[],
): MissingDep[] {
  const db = getDb();
  const rows = db
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.id, mcpId))
    .limit(1)
    .all();
  const row = rows[0];
  if (!row) {
    return binaries.map((b) => ({
      binary: b,
      runtimeStatus: "pending",
      error: "mcp row missing",
    }));
  }

  let deps: DependencyStatus[] = [];
  try {
    deps = JSON.parse(row.dependencyStatus ?? "[]") as DependencyStatus[];
  } catch {
    // leave empty — treat as nothing installed
  }
  const byBin = new Map(deps.map((d) => [d.binary, d]));

  const missing: MissingDep[] = [];
  for (const b of binaries) {
    const d = byBin.get(b);
    if (!d || !d.installed) {
      missing.push({
        binary: b,
        runtimeStatus:
          (d?.runtimeStatus as MissingDep["runtimeStatus"]) ?? "pending",
        error: d?.error ?? null,
        ...(d?.bytesDownloaded != null
          ? { bytesDownloaded: d.bytesDownloaded }
          : {}),
        ...(d?.bytesTotal != null ? { bytesTotal: d.bytesTotal } : {}),
      });
    }
  }
  return missing;
}

/**
 * Persist a single dependency's status into an MCP row's `dependencyStatus`
 * JSON — the SAME array `requireDeps` reads. Merges into the existing entry
 * (or appends one), so sibling deps are preserved.
 *
 * This is the write-side pair to `requireDeps`. It deliberately lives here
 * (not in `DependencyManager`) so request-path callers — e.g. the tracking
 * verify endpoint closing the lazy-install loop — can persist a verified dep
 * without importing the heavy server-only `dependency-manager.ts` (which
 * pulls `child_process` / playwright into the bundle).
 *
 * Used to close the tracking-pyenv lazy-install loop: a successful
 * `libi.verify_install` marks the dep installed on the `libi` row so the
 * `computeObjectTrack` gate (`requireDeps("libi", ["tracking-pyenv"])`)
 * stops blocking — no manual sqlite patching, no `update_dep_status`.
 *
 * No-op when the MCP row is absent (fresh dev / test harness without seed).
 * Returns true when a write occurred.
 */
export function markDepInstalled(
  mcpId: string,
  binary: string,
  patch?: Partial<DependencyStatus>,
): boolean {
  const db = getDb();
  const rows = db
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.id, mcpId))
    .limit(1)
    .all();
  const row = rows[0];
  if (!row) return false;

  let list: DependencyStatus[] = [];
  try {
    list = JSON.parse(row.dependencyStatus ?? "[]") as DependencyStatus[];
    if (!Array.isArray(list)) list = [];
  } catch {
    list = [];
  }

  const installed: DependencyStatus = {
    binary,
    installed: true,
    path: null,
    source: "bundled",
    runtimeStatus: "installed",
    error: null,
    ...patch,
  };

  const idx = list.findIndex((d) => d.binary === binary);
  if (idx === -1) {
    list.push(installed);
  } else {
    list[idx] = { ...list[idx], ...installed };
  }

  db.update(mcpServers)
    .set({ dependencyStatus: JSON.stringify(list), updatedAt: new Date() })
    .where(eq(mcpServers.id, mcpId))
    .run();
  return true;
}
