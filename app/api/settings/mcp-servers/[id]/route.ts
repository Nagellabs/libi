import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { mcpServers } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";
import { invalidateMcpConfig } from "@/lib/mcp-config";
import { redactServerRow } from "@/lib/security/redact-mcp-server";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: Request, { params }: RouteParams) {
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
