import fs from "node:fs";
import path from "node:path";
import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema/sqlite";
import { getLibiStorageDir } from "@/lib/libi-home";
import { proxyLogger as logger } from "@/lib/logger";
import { recordEvictedProxy } from "@/lib/proxy/evicted";
import { moveAnalysisDir } from "@/lib/files/move-derived";

/**
 * Startup repair for files `assignFile` moved before it carried their derived
 * artifacts along (lib/files/move-derived.ts). Until then a file moved to
 * another scope — typically a video an agent downloaded to the library and
 * then assigned to a piece — left its proxy and its `_analysis/<fileId>/`
 * behind in the old scope folder, under a row still saying "proxy ready": the
 * proxy route 404'd and the asset view played nothing.
 *
 * - A `ready` row whose proxy is not in its scope folder goes back to `idle`
 *   (the preview plays the original meanwhile) and is recorded as evicted, so
 *   the piece's next open re-makes it (ensure.ts). Never re-linked to a file
 *   found elsewhere by name: a same-named file's proxy is not this one's. A
 *   left-behind `<name>-proxy.*` in the library folder that no library row
 *   names, as its file or its proxy, is deleted.
 * - An `_analysis/<fileId>/` in a scope that isn't its row's moves to the
 *   row's scope, unless one is already there.
 *
 * Runs every boot (one stat per ready proxy, one listing per scope's
 * `_analysis/`), so a proxy that vanishes any other way is caught too.
 * Never throws.
 */
export function sweepMisplacedFileArtifacts(): { proxiesReset: number; analysisMoved: number } {
  const result = { proxiesReset: 0, analysisMoved: 0 };
  let db: ReturnType<typeof getDb>;
  try {
    db = getDb();
  } catch (err) {
    logger.warn({ tag: "proxy", op: "repair_misplaced_db_unavailable", err }, "proxy.repair_misplaced.db_unavailable");
    return result;
  }
  const storageDir = getLibiStorageDir();

  try {
    const rows = db
      .select({ id: files.id, pieceId: files.pieceId, proxyFilename: files.proxyFilename })
      .from(files)
      .where(and(eq(files.proxyStatus, "ready"), isNotNull(files.proxyFilename)))
      .all();
    for (const row of rows) {
      const name = row.proxyFilename!;
      if (fs.existsSync(path.join(storageDir, row.pieceId ?? "_global", name))) continue;
      db.update(files)
        .set({ proxyFilename: null, proxyStatus: "idle", proxyGeneratedAt: null })
        .where(eq(files.id, row.id))
        .run();
      recordEvictedProxy(row.id, 0);
      result.proxiesReset++;
      if (row.pieceId) removeUnclaimedLibraryProxy(db, storageDir, name);
    }
  } catch (err) {
    logger.warn({ tag: "proxy", op: "repair_misplaced_proxy_failed", err: err instanceof Error ? err.message : String(err) }, "proxy.repair_misplaced.proxy_failed");
  }

  try {
    result.analysisMoved = relocateAnalysisDirs(db, storageDir);
  } catch (err) {
    logger.warn({ tag: "analysis", op: "repair_misplaced_analysis_failed", err: err instanceof Error ? err.message : String(err) }, "analysis.repair_misplaced.failed");
  }

  if (result.proxiesReset > 0 || result.analysisMoved > 0) {
    logger.info({ tag: "proxy", op: "repair_misplaced", ...result }, "proxy.repair_misplaced");
  }
  return result;
}

function removeUnclaimedLibraryProxy(db: ReturnType<typeof getDb>, storageDir: string, name: string): void {
  const orphan = path.join(storageDir, "_global", name);
  if (!fs.existsSync(orphan)) return;
  const [claimed] = db
    .select({ id: files.id })
    .from(files)
    .where(and(isNull(files.pieceId), or(eq(files.filename, name), eq(files.proxyFilename, name))))
    .limit(1)
    .all();
  if (claimed) return;
  fs.rmSync(orphan, { force: true });
}

function relocateAnalysisDirs(db: ReturnType<typeof getDb>, storageDir: string): number {
  let scopes: string[];
  try {
    scopes = fs.readdirSync(storageDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return 0;
  }
  const found: Array<{ fileId: string; scope: string }> = [];
  for (const scope of scopes) {
    let entries: string[];
    try {
      entries = fs.readdirSync(path.join(storageDir, scope, "_analysis"));
    } catch {
      continue;
    }
    for (const fileId of entries) found.push({ fileId, scope });
  }
  if (found.length === 0) return 0;

  const owner = new Map<string, string>();
  const ids = [...new Set(found.map((f) => f.fileId))];
  for (let i = 0; i < ids.length; i += 500) {
    for (const r of db
      .select({ id: files.id, pieceId: files.pieceId })
      .from(files)
      .where(inArray(files.id, ids.slice(i, i + 500)))
      .all()) {
      owner.set(r.id, r.pieceId ?? "_global");
    }
  }

  let moved = 0;
  for (const { fileId, scope } of found) {
    const target = owner.get(fileId);
    if (!target || target === scope) continue;
    const from = scope === "_global" ? null : scope;
    const to = target === "_global" ? null : target;
    if (moveAnalysisDir(fileId, from, to)) moved++;
  }
  return moved;
}
