import { NextResponse } from "next/server";
import fs from "fs";
import { getDbPath, backupDb, resetDbClient, migrateDatabase } from "@/lib/db/client";
import { invalidateMcpConfig } from "@/lib/mcp-config";
import { DependencyManager } from "@/mcp/registry/dependency-manager";
import { serverLogger as logger } from "@/lib/logger";

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
      return NextResponse.json(
        { success: false, error: message, backupPath },
        { status: 500 }
      );
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
