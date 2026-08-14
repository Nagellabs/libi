import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { mcpServers } from "@/lib/db/schema/sqlite";

/**
 * Reads the fal.ai API key from the mcp_servers["fal-ai"] row's env_vars JSON.
 *
 * Returns null when:
 * - the row is missing
 * - env_vars is unset
 * - FAL_KEY is absent, not a string, or empty
 * - env_vars contains malformed JSON
 */
export async function readFalApiKey(): Promise<string | null> {
  const db = getDb();
  const [row] = db
    .select({ envVars: mcpServers.envVars })
    .from(mcpServers)
    .where(eq(mcpServers.id, "fal-ai"))
    .limit(1)
    .all();

  if (!row?.envVars) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(row.envVars) as Record<string, unknown>;
  } catch {
    return null;
  }

  const key = parsed["FAL_KEY"];
  if (typeof key !== "string" || key.trim() === "") return null;
  return key.trim();
}
