import { BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";
import { getDb } from "@/lib/db/client";
import { mcpServers } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";
import { checkBinary, checkEnvVar, type AuxResult } from "./aux-checks";
import { buildSpawnEnv } from "@/mcp/registry/spawn-env";
import { resolveBundledSpawn } from "@/mcp/registry/local-bin-resolver";

export interface DiagnoseMcpInput {
  mcpId: string;
}

export type DiagnoseMcpResult =
  | {
      success: true;
      mcpId: string;
      installStatus: string;
      serverStatus: string;
      lastServerError: string | null;
      lastInstallError: string | null;
      lastChecked: string | null;
      spawn: {
        command: string;
        args: string[];
        envKeys: string[];
        transport: "stdio" | "http";
      };
      inCurrentSession: boolean;
      whyExcluded: string | null;
      auxiliary: AuxResult[];
      hints: string[];
    }
  | { success: false; error: string };

// Row type for the AUX_CHECKS callbacks. We only need a few fields, so
// keep this loose — drizzle's $inferSelect can be fragile across versions.
type McpRow = {
  envVars: string | null;
  installStatus: string;
  installError: string | null;
  enabled: boolean;
  serverStatus: string;
  serverError: string | null;
  serverLastChecked: Date | null;
};

const AUX_CHECKS: Record<
  string,
  (row: McpRow) => Promise<AuxResult[]>
> = {
  "youtube-downloader": async () => [await checkBinary("yt-dlp")],
  "elevenlabs": async (row) => [checkEnvVar(row, "ELEVENLABS_API_KEY")],
  "fal-ai": async (row) => [checkEnvVar(row, "FAL_KEY")],
};

export async function diagnoseMcp(
  input: DiagnoseMcpInput,
): Promise<DiagnoseMcpResult> {
  const def = BUNDLED_MCP_SERVERS.find((d) => d.id === input.mcpId);
  if (!def) {
    return {
      success: false,
      error: `Unknown MCP id "${input.mcpId}". Known: ${BUNDLED_MCP_SERVERS.map((d) => d.id).join(", ")}.`,
    };
  }

  const db = getDb();
  const row = db
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.id, input.mcpId))
    .all()[0] as McpRow | undefined;
  if (!row) {
    return {
      success: false,
      error: `DB row missing for "${input.mcpId}" — seedDatabase() should have created it. This is a libi bug.`,
    };
  }

  const userEnv: Record<string, string> = row.envVars ? JSON.parse(row.envVars) : {};
  const env = buildSpawnEnv(userEnv);
  const resolved = resolveBundledSpawn(def);
  const spawnConfig = {
    command: resolved.command,
    args: resolved.args,
    envKeys: Object.keys(env).sort(),
    transport: (def.type === "http" ? "http" : "stdio") as "stdio" | "http",
  };

  const inCurrentSession =
    row.enabled && !["needs_config", "failed"].includes(row.installStatus);
  const whyExcluded = inCurrentSession
    ? null
    : !row.enabled
      ? "disabled by user"
      : row.installStatus === "needs_config"
        ? `needs_config: missing env var (${(row.installError ?? "see Settings").replace(/^Missing required env vars?: /, "")})`
        : row.installStatus === "failed"
          ? `failed: ${row.installError ?? "unknown error"}`
          : "unknown";

  const auxFn = AUX_CHECKS[input.mcpId];
  const auxiliary = auxFn ? await auxFn(row) : [];

  const hints: string[] = [];
  if (!inCurrentSession) {
    hints.push(
      `This MCP is excluded from your session: ${whyExcluded}. Fix the underlying issue, then call libi.update_dep_status to mark it ready.`,
    );
  }
  const failedAux = auxiliary.filter((a) => !a.ok);
  if (failedAux.length > 0) {
    hints.push(
      `Auxiliary check failed: ${failedAux.map((a) => `${a.name} (${a.detail})`).join("; ")}. Check the recovery guide via libi.get_install_plan.`,
    );
  }
  if (row.serverStatus === "down") {
    hints.push(
      `Last probe reported the server as down: ${row.serverError ?? "no error captured"}. Try libi.restart_mcp_server.`,
    );
  }
  if (hints.length === 0 && inCurrentSession && row.serverStatus !== "down") {
    hints.push(
      `MCP looks healthy. If tools are missing from your deferred list, try ToolSearch with a relevant keyword.`,
    );
  }

  return {
    success: true,
    mcpId: input.mcpId,
    installStatus: row.installStatus,
    serverStatus: row.serverStatus,
    lastServerError: row.serverError ?? null,
    lastInstallError: row.installError ?? null,
    lastChecked: row.serverLastChecked
      ? new Date(row.serverLastChecked).toISOString()
      : null,
    spawn: spawnConfig,
    inCurrentSession,
    whyExcluded,
    auxiliary,
    hints,
  };
}
