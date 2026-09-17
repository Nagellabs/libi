import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { mcpServers } from "@/lib/db/schema/sqlite";
import { desc } from "drizzle-orm";
import { BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";
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
