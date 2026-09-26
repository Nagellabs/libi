import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { mcpServers } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";
import { invalidateMcpConfig } from "@/lib/mcp-config";
import { redactServerRow } from "@/lib/security/redact-mcp-server";
import { serverLogger as logger } from "@/lib/logger";
import { browserOnlyRefusal } from "@/lib/security/request-guard";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * The extension card's "Require approval" switch (`useUpdateMcpServer`, its one
 * caller). Takes the browser-only checks (`browserOnlyRefusal`): the flag
 * decides whether an extension's tools raise a card, so an agent's shell must
 * not be able to switch it off with a header-less curl. The agent's own tool,
 * `libi.update_mcp_server`, may only turn it ON (mcp/tools/mcp-server-tools.ts).
 */
export async function PATCH(request: Request, { params }: RouteParams) {
  const refused = browserOnlyRefusal(request);
  if (refused) {
    logger.warn({ tag: "mcp-config", op: "mcp_server_update_refused", reason: refused }, "extension setting change refused: not from libi's own page");
    return NextResponse.json({ error: "Extension settings are changed only on libi's Agents page.", code: "browser_only" }, { status: 403 });
  }
  const { id } = await params;
  const body = await request.json();

  const db = getDb();
  const [existing] = db.select().from(mcpServers).where(eq(mcpServers.id, id)).limit(1).all();
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const set: Record<string, unknown> = { updatedAt: new Date() };

  // The only writable field on a libi-owned row: the extension
  // approval gate. `enabled` was dropped with migration 0051 — an extension's
  // tools are always listed.
  if (body.requireApproval !== undefined) set.requireApproval = body.requireApproval;

  db.update(mcpServers).set(set).where(eq(mcpServers.id, id)).run();

  const [final] = db.select().from(mcpServers).where(eq(mcpServers.id, id)).limit(1).all();

  try { invalidateMcpConfig({ reason: "mcp-server-updated" }); } catch { /* may not be initialized */ }

  // RC-F: write-only — accept new values in the request body but never echo them back.
  return NextResponse.json({ server: redactServerRow(final) });
}
