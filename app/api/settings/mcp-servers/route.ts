import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { mcpServers } from "@/lib/db/schema/sqlite";
import { desc } from "drizzle-orm";
import { invalidateMcpConfig } from "@/lib/mcp-config";
import { BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";
import { trackServerEvent } from "@/lib/analytics/server";
import { redactServerRow } from "@/lib/security/redact-mcp-server";

export async function GET() {
  const db = getDb();
  const rows = db
    .select()
    .from(mcpServers)
    .orderBy(desc(mcpServers.bundled), desc(mcpServers.createdAt))
    .all();

  // noServer is a code-side flag on BUNDLED_MCP_SERVERS (whisper, local-tts,
  // local-music — libraries libi calls via `uv run`, with no spawnable
  // daemon). Surface it to the UI so it can hide the meaningless
  // "Server: unknown" row for those rows.
  const noServerIds = new Set(
    BUNDLED_MCP_SERVERS.filter((d) => d.noServer).map((d) => d.id),
  );

  const servers = rows.map((row) => ({
    // RC-F: redactServerRow strips the raw envVars AND headers values and
    // exposes only configuredEnvVars / configuredHeaders (names) so plaintext
    // secrets (API keys + bearer-token headers) never reach the client.
    ...redactServerRow(row),
    serverStatus: (row.serverStatus ?? "unknown") as "unknown" | "starting" | "up" | "down",
    serverError: row.serverError ?? null,
    serverLastChecked: row.serverLastChecked
      ? Math.floor(row.serverLastChecked.getTime() / 1000)
      : null,
    noServer: noServerIds.has(row.id),
  }));

  return NextResponse.json({ servers });
}

export async function POST(request: Request) {
  const body = await request.json();
  const { name, type, command, args, url, headers, envVars, requireApproval } = body;

  if (!name || !type) {
    return NextResponse.json({ error: "name and type are required" }, { status: 400 });
  }

  if (type !== "stdio" && type !== "http") {
    return NextResponse.json({ error: "type must be 'stdio' or 'http'" }, { status: 400 });
  }

  if (type === "stdio" && !command) {
    return NextResponse.json({ error: "command is required for stdio type" }, { status: 400 });
  }

  if (type === "http" && !url) {
    return NextResponse.json({ error: "url is required for http type" }, { status: 400 });
  }

  const db = getDb();
  const [row] = await db
    .insert(mcpServers)
    .values({
      name,
      type,
      command: command ?? null,
      args: args ? JSON.stringify(args) : null,
      url: url ?? null,
      headers: headers ? JSON.stringify(headers) : null,
      envVars: envVars ? JSON.stringify(envVars) : null,
      requireApproval: requireApproval ?? true,
      bundled: false,
      installStatus: "not_required",
    })
    .returning();

  void trackServerEvent("mcp_server_added", { transport: type });

  try { invalidateMcpConfig({ reason: "mcp-server-created" }); } catch { /* may not be initialized */ }

  // RC-F: never echo the just-saved plaintext secret back to the client.
  return NextResponse.json({ server: redactServerRow(row) }, { status: 201 });
}
