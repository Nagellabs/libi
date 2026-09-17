import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { mcpServers } from "@/lib/db/schema/sqlite";
import { DependencyManager } from "@/mcp/registry/dependency-manager";
import {
  isRemovableExtension,
  removeExtensionFiles,
} from "@/mcp/registry/extension-uninstall";
import { serverLogger as logger } from "@/lib/logger";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * Delete an extension's downloaded files and let the row re-derive.
 *
 * Deliberately NOT a `DELETE` on the row: an extension is a bundled definition
 * that `seedDatabase` re-creates on every boot, so the row is not the thing
 * being removed — the gigabytes under `<LIBI_HOME>/models` are. What comes back
 * is an extension in its pre-install state, exactly as a fresh install has it.
 *
 * `installStatus` is cleared BEFORE re-settling because `settleInstallStatus`
 * short-circuits on a row parked at `failed` and would otherwise report the old
 * status over an empty disk.
 */
export async function POST(_req: Request, { params }: RouteParams): Promise<NextResponse> {
  const { id } = await params;

  const db = getDb();
  const [existing] = db.select().from(mcpServers).where(eq(mcpServers.id, id)).limit(1).all();
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!isRemovableExtension(id)) {
    return NextResponse.json(
      { error: `${id} has no files of its own to remove` },
      { status: 400 },
    );
  }

  let result: { removed: string[]; freedBytes: number };
  try {
    result = removeExtensionFiles(id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { tag: "mcp-config", op: "extension_remove_error", mcpId: id, err: message },
      "extension removal failed",
    );
    return NextResponse.json({ error: message }, { status: 500 });
  }

  db.update(mcpServers)
    .set({ installStatus: "pending", installError: null, updatedAt: new Date() })
    .where(eq(mcpServers.id, id))
    .run();
  await new DependencyManager().settleInstallStatus(id);

  return NextResponse.json({ ok: true, freedBytes: result.freedBytes });
}
