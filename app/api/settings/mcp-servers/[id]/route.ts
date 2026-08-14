import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { mcpServers } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";
import { invalidateMcpConfig } from "@/lib/mcp-config";
import { mergeEnvVars, mergeHeaders, redactServerRow } from "@/lib/security/redact-mcp-server";

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

  // Always allow toggling these
  if (body.enabled !== undefined) set.enabled = body.enabled;
  if (body.requireApproval !== undefined) set.requireApproval = body.requireApproval;

  // For non-bundled servers, allow editing connection details.
  if (!existing.bundled) {
    if (body.name !== undefined) set.name = body.name;
    if (body.description !== undefined) set.description = body.description;
    if (body.type !== undefined) set.type = body.type;
    if (body.command !== undefined) set.command = body.command;
    if (body.args !== undefined) set.args = body.args ? JSON.stringify(body.args) : null;
    if (body.url !== undefined) set.url = body.url;
    // RC-F: headers hold bearer-token secrets (Authorization: Bearer <FAL_KEY>).
    // The client only knows header NAMES (values are redacted on read), so it
    // sends just the headers the user just typed. Merge those into the stored
    // map — a blank/absent header leaves the stored secret unchanged (never
    // wiped). An explicit `null` still clears everything (API completeness).
    if (body.headers !== undefined) {
      if (body.headers === null) {
        set.headers = null;
      } else {
        const merged = mergeHeaders(existing.headers, body.headers as Record<string, string>);
        set.headers = Object.keys(merged).length > 0 ? JSON.stringify(merged) : null;
      }
    }
  }

  // Allow envVars editing for ALL servers (bundled + custom). Bundled servers use this for API keys.
  // RC-F: the client only ever knows key NAMES (values are redacted on read), so it sends just the
  // keys the user just typed. Merge those into the stored map — a blank/absent key leaves the stored
  // secret unchanged (never wiped). An explicit `null` still clears everything (API completeness).
  if (body.envVars !== undefined) {
    if (body.envVars === null) {
      set.envVars = null;
    } else {
      const merged = mergeEnvVars(existing.envVars, body.envVars as Record<string, string>);
      set.envVars = Object.keys(merged).length > 0 ? JSON.stringify(merged) : null;
    }
  }

  db.update(mcpServers).set(set).where(eq(mcpServers.id, id)).run();

  // For bundled servers with requiredEnvVars, re-derive installStatus.
  if (existing.bundled && body.envVars !== undefined) {
    const { BUNDLED_MCP_SERVERS } = await import("@/mcp/registry/bundled");
    const { DependencyManager } = await import("@/mcp/registry/dependency-manager");
    const def = BUNDLED_MCP_SERVERS.find((d) => d.id === id);
    if (def?.requiredEnvVars && def.requiredEnvVars.length > 0) {
      // Only flip between installed/needs_config — leave failed/checking/pending alone.
      const eligible = ["installed", "needs_config"];
      const [latest] = db.select().from(mcpServers).where(eq(mcpServers.id, id)).limit(1).all();
      if (latest && eligible.includes(latest.installStatus)) {
        const config = DependencyManager.evaluateConfigStatus({
          requiredEnvVars: def.requiredEnvVars,
          envVarsJson: latest.envVars ?? null,
        });
        db.update(mcpServers)
          .set({
            installStatus: config.status,
            installError: config.status === "needs_config"
              ? `Missing required env vars: ${config.missing.join(", ")}`
              : null,
            updatedAt: new Date(),
          })
          .where(eq(mcpServers.id, id))
          .run();
      }
    }
  }

  // Re-fetch the updated row after potential status flip
  const [final] = db.select().from(mcpServers).where(eq(mcpServers.id, id)).limit(1).all();

  try { invalidateMcpConfig({ reason: "mcp-server-updated" }); } catch { /* may not be initialized */ }

  // RC-F: write-only — accept new values in the request body but never echo them back.
  return NextResponse.json({ server: redactServerRow(final) });
}

export async function DELETE(_request: Request, { params }: RouteParams) {
  const { id } = await params;
  const db = getDb();

  const [existing] = db.select().from(mcpServers).where(eq(mcpServers.id, id)).limit(1).all();
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (existing.bundled) {
    return NextResponse.json({ error: "Cannot delete bundled MCP servers" }, { status: 403 });
  }

  db.delete(mcpServers).where(eq(mcpServers.id, id)).run();

  try { invalidateMcpConfig({ reason: "mcp-server-deleted" }); } catch { /* may not be initialized */ }

  return NextResponse.json({ success: true });
}
