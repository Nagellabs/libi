import { NextResponse } from "next/server";
import fs from "fs";
import { getDbPath, backupDb, resetDbClient, migrateDatabase } from "@/lib/db/client";
import { invalidateMcpConfig } from "@/lib/mcp-config";
import { DependencyManager } from "@/mcp/registry/dependency-manager";
import { serverLogger as logger } from "@/lib/logger";
import { readTemplatesAuthorsForReset, restoreTemplatesAuthorsAfterReset, type CarriedTemplatesAuthors } from "@/lib/db/settings";

/**
 * POST /api/db/resolve
 * Body: { mode: "reset" }
 *
 * "reset" — back up, delete the DB file, re-create from scratch (loses data but guaranteed to work)
 */
export async function POST(request: Request) {
  const { mode } = (await request.json()) as { mode: string };

  if (mode === "reset") {
    const dbPath = getDbPath();
    const backupPath = backupDb(dbPath);

    // backupDb returns null both for "nothing to back up" (no file, or an empty
    // one) and for a failed copy. Only the second would make the reset lose
    // data — every piece, every setting, and the creator key — with no copy
    // anywhere, so refuse before anything is deleted.
    if (!backupPath && fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0) {
      logger.error({ tag: "db-resolve", op: "reset_refused_no_backup", dbPath }, "Refusing to reset: the database could not be backed up");
      return NextResponse.json(
        { success: false, error: "Could not back up the database, so it was not reset. Nothing was deleted." },
        { status: 500 }
      );
    }

    // The creator key is the only way to edit this install's published templates
    // and cannot be re-issued; the backup it would otherwise survive in rotates
    // out after three boots. Carry it across — test mode's own identity too,
    // which lives in a separate row, so a reset in either mode keeps both. A
    // DB too broken to read it from is exactly what a reset is for, so a
    // failed read never blocks one.
    let carried: CarriedTemplatesAuthors = { production: null, testMode: null };
    try {
      carried = readTemplatesAuthorsForReset();
    } catch {
      logger.warn({ tag: "db-resolve", op: "templates_author_unreadable" }, "Could not read the creator key before reset");
    }
    const carriesAKey = carried.production !== null || carried.testMode !== null;

    try {
      // Close the current connection and delete the DB file
      resetDbClient();
      if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
        logger.info({ tag: "db-resolve", op: "db_deleted", dbPath }, "Deleted database");
      }

      // Re-create: migrateDatabase() creates a fresh DB, runs migrations, and seeds data.
      // (At server startup this runs in the lifecycle prelude; after a reset we
      // must call it explicitly — getDb() alone only opens a connection.)
      migrateDatabase();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The old DB is gone and the new one is what failed, so the key cannot be
      // put back; the backup is its only copy. Say where — never the key itself.
      if (carriesAKey) {
        logger.error({ tag: "db-resolve", op: "templates_author_not_restored", backupPath }, "Reset failed; the creator key survives only in the backup");
      }
      return NextResponse.json(
        {
          success: false,
          error: carriesAKey ? `${message} — your creator key is in ${backupPath}` : message,
          backupPath,
        },
        { status: 500 }
      );
    }

    // The reset itself succeeded, so a failed restore must not report it as a
    // failure (the UI would never reload). No err in the log: a failed query's
    // message carries its parameters, which here include the key.
    if (carriesAKey) {
      try {
        restoreTemplatesAuthorsAfterReset(carried);
      } catch {
        logger.error({ tag: "db-resolve", op: "templates_author_restore_failed", backupPath }, "Could not restore the creator key after reset; it survives in the backup");
      }
    }

    // Check/download MCP binary dependencies (non-critical — don't fail the reset)
    try {
      const depManager = new DependencyManager();
      await depManager.ensureAll();
    } catch (err) {
      logger.warn(
        { tag: "db-resolve", op: "mcp_dependency_sync_failed", err },
        "MCP dependency sync failed after reset",
      );
    }

    try { invalidateMcpConfig({ reason: "db-resolve" }); } catch { /* may not be initialized */ }

    return NextResponse.json({
      success: true,
      message: "Database has been reset. All data was cleared but the app should work correctly now.",
      backupPath,
    });
  }

  return NextResponse.json(
    { success: false, error: "Invalid mode. Use 'reset'." },
    { status: 400 }
  );
}
