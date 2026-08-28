import { spawn } from "child_process";
import { serverLogger as logger } from "@/lib/logger";
import { getDb } from "@/lib/db/client";
import { mcpServers } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";
import { buildSpawnEnv } from "./spawn-env";
import { resolveBundledSpawn } from "./local-bin-resolver";
import { scrubSecrets } from "@/lib/security/secret-scrub";
import type { BundledMcpDef } from "./types";
import type { ServerStatus } from "./server-status";

export interface ProbeOptions {
  command: string;
  args: string[];
  env: Record<string, string>;
  timeoutMs?: number;
}

export interface ProbeResult {
  status: Extract<ServerStatus, "up" | "down">;
  error: string | null;
  durationMs: number;
}

const STDERR_LIMIT = 4096;

/**
 * Collect the configured secret VALUES for an mcp_servers row — the `envVars`
 * values plus any HTTP `headers` values — so captured stderr can be scrubbed of
 * them before persist. Tolerant of malformed JSON (returns what it can).
 */
function collectRowSecrets(row: { envVars?: string | null; headers?: string | null } | undefined): string[] {
  if (!row) return [];
  const secrets: string[] = [];
  const collect = (json: string | null | undefined) => {
    if (!json) return;
    try {
      const obj = JSON.parse(json);
      if (obj && typeof obj === "object") {
        for (const v of Object.values(obj)) {
          if (typeof v === "string" && v) secrets.push(v);
        }
      }
    } catch {
      // Malformed JSON — nothing to add.
    }
  };
  collect(row.envVars);
  collect(row.headers);
  return secrets;
}

// 3 min — covers cold first-install paths where npx/uvx must fetch the
// package from the registry before the server can respond to `initialize`.
// Once the package is cached, probes return in ~1–2s anyway.
const PROBE_TIMEOUT_MS = 180_000;

/**
 * Probe an MCP server without touching the DB. Used during Category A
 * (before the DB exists / is migrated).
 *
 * Reads NO user-configured envVars — the bundled spawn-env defaults are
 * sufficient for verifying a bundled MCP can start. User-config-gated
 * MCPs are skipped before this is called.
 *
 * Returns the same `ProbeResult` as `probeAndPersist` but performs no
 * `mcpServers` table writes.
 */
export async function probeMcpInMemory(def: BundledMcpDef): Promise<ProbeResult> {
  const userEnv: Record<string, string> = {};
  const env = buildSpawnEnv(userEnv);
  const resolved = resolveBundledSpawn(def);

  logger.info(
    {
      tag: "mcp-probe",
      op: "probe_in_memory_start",
      mcpId: def.id,
      command: resolved.command,
      args: resolved.args,
      spawnSource: resolved.source,
      timeoutMs: PROBE_TIMEOUT_MS,
    },
    `Probing MCP server "${def.id}" (in-memory, ${resolved.source})`,
  );

  return probeMcpServer({
    command: resolved.command,
    args: resolved.args,
    env,
    timeoutMs: PROBE_TIMEOUT_MS,
  });
}

/**
 * Probe an MCP server and persist the result into `mcp_servers`.
 * Owns the full lifecycle: starting → probe → done.
 *
 * Env is always built via `buildSpawnEnv` (HOME-aware) — never spawn an
 * MCP child outside this function (or `lib/mcp-config.ts:buildMcpServers`
 * for the live ACP/settings spawn path) without going through buildSpawnEnv.
 */
export async function probeAndPersist(def: BundledMcpDef): Promise<ProbeResult> {
  const db = getDb();

  db.update(mcpServers)
    .set({ serverStatus: "starting", serverLastChecked: new Date(), updatedAt: new Date() })
    .where(eq(mcpServers.id, def.id))
    .run();

  const [row] = db.select().from(mcpServers).where(eq(mcpServers.id, def.id)).limit(1).all();
  const userEnv: Record<string, string> = row?.envVars ? JSON.parse(row.envVars) : {};
  const env = buildSpawnEnv(userEnv);
  const resolved = resolveBundledSpawn(def);

  logger.info(
    {
      tag: "mcp-probe",
      op: "probe_start",
      mcpId: def.id,
      command: resolved.command,
      args: resolved.args,
      spawnSource: resolved.source,
      envKeys: Object.keys(env).sort(),
      hasHome: typeof env.HOME === "string" && env.HOME.length > 0,
      timeoutMs: PROBE_TIMEOUT_MS,
    },
    `Probing MCP server "${def.id}" (${resolved.source})`,
  );

  const probe = await probeMcpServer({
    command: resolved.command,
    args: resolved.args,
    env,
    timeoutMs: PROBE_TIMEOUT_MS,
  });

  // Captured child stderr can echo a configured API key (e.g. a 401 body that
  // reflects the Authorization header). Scrub every configured secret — the
  // row's envVars values plus any HTTP header values — before it is persisted
  // to `serverError` (returned by the settings API, shown in diagnose). RC-F.
  const configuredSecrets = collectRowSecrets(row);
  const scrubbedError = probe.error
    ? scrubSecrets(probe.error, configuredSecrets)
    : probe.error;

  db.update(mcpServers)
    .set({
      serverStatus: probe.status,
      serverError: scrubbedError,
      serverLastChecked: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(mcpServers.id, def.id))
    .run();

  if (probe.status === "up") {
    logger.info(
      {
        tag: "mcp-probe",
        op: "probe_persisted",
        mcpId: def.id,
        status: probe.status,
        durationMs: probe.durationMs,
      },
      `MCP server "${def.id}" is up`,
    );
  } else {
    logger.warn(
      {
        tag: "mcp-probe",
        op: "probe_persisted",
        mcpId: def.id,
        status: probe.status,
        durationMs: probe.durationMs,
        error: scrubbedError,
      },
      `MCP server "${def.id}" is down`,
    );
  }

  return probe;
}

/**
 * Spawn an MCP stdio server, perform the JSON-RPC initialize handshake,
 * kill it, and report up/down. Captures stderr on failure (truncated to 4 KiB).
 *
 * Note: we deliberately do NOT keep the connection open or list tools —
 * the ACP session will discover tools fresh. This is purely a liveness
 * + protocol-handshake check.
 */
export async function probeMcpServer(opts: ProbeOptions): Promise<ProbeResult> {
  const { command, args, env, timeoutMs = 10_000 } = opts;
  const start = Date.now();

  logger.debug(
    { tag: "mcp-probe", op: "spawn", command, args, timeoutMs },
    "Spawning MCP child for probe",
  );

  return new Promise<ProbeResult>((resolve) => {
    let resolved = false;
    let stderr = "";
    let stderrBytes = 0;
    let pid: number | undefined;
    let initSentAt: number | null = null;
    let firstStdoutAt: number | null = null;
    const finish = (result: ProbeResult) => {
      if (resolved) return;
      resolved = true;
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      resolve(result);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        env: env as NodeJS.ProcessEnv,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      pid = child.pid;
      logger.debug(
        { tag: "mcp-probe", op: "spawned", command, pid },
        `MCP child spawned (pid=${pid ?? "?"})`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        { tag: "mcp-probe", op: "spawn_failed", command, args, err: message },
        "Failed to spawn MCP child",
      );
      finish({ status: "down", error: message, durationMs: Date.now() - start });
      return;
    }

    const timer = setTimeout(() => {
      // NB: never log raw stderr — it can echo a configured secret (e.g. a 401
      // body reflecting an Authorization header). Only the caller
      // (`probeAndPersist`) logs error TEXT, and only after scrubbing. Here we
      // emit lengths/metadata only. RC-F.
      logger.warn(
        {
          tag: "mcp-probe",
          op: "timeout",
          command,
          pid,
          timeoutMs,
          stderrBytes,
          stderrLength: stderr.length,
          initSentAt,
          firstStdoutAt,
        },
        `MCP probe timed out after ${timeoutMs}ms`,
      );
      finish({
        status: "down",
        error: `MCP probe timed out after ${timeoutMs}ms${stderr ? `\nstderr: ${stderr.slice(0, STDERR_LIMIT)}` : ""}`,
        durationMs: Date.now() - start,
      });
    }, timeoutMs);

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      stderrBytes += chunk.length;
      stderr += text;
      if (stderr.length > STDERR_LIMIT * 2) {
        stderr = stderr.slice(-STDERR_LIMIT);
      }
      // Do NOT log the stderr text — it may carry a configured secret. Length
      // only. RC-F.
      logger.trace(
        { tag: "mcp-probe", op: "stderr", command, pid, bytes: chunk.length, stderrLength: stderr.length },
        "MCP child stderr",
      );
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      // `err.message` is the Node spawn/stream error (e.g. EPIPE), not child
      // output — safe. Raw stderr is NOT logged (may hold a secret). RC-F.
      logger.warn(
        { tag: "mcp-probe", op: "child_error", command, pid, err: err.message, stderrLength: stderr.length },
        "MCP child errored",
      );
      finish({
        status: "down",
        error: `${err.message}${stderr ? `\nstderr: ${stderr.slice(0, STDERR_LIMIT)}` : ""}`,
        durationMs: Date.now() - start,
      });
    });

    child.on("exit", (code, signal) => {
      if (resolved) return;
      clearTimeout(timer);
      // Raw stderr is NOT logged (may hold a secret). Length only. RC-F.
      logger.warn(
        { tag: "mcp-probe", op: "exit_before_init", command, pid, code, signal, stderrLength: stderr.length },
        `MCP child exited before initialize (code=${code} signal=${signal})`,
      );
      finish({
        status: "down",
        error: `MCP exited before initialize (code=${code} signal=${signal})${stderr ? `\nstderr: ${stderr.slice(0, STDERR_LIMIT)}` : ""}`,
        durationMs: Date.now() - start,
      });
    });

    let stdoutBuf = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      if (firstStdoutAt === null) {
        firstStdoutAt = Date.now() - start;
        logger.debug(
          { tag: "mcp-probe", op: "first_stdout", command, pid, msSinceSpawn: firstStdoutAt },
          "First stdout from MCP child",
        );
      }
      stdoutBuf += chunk.toString("utf-8");
      let nl: number;
      while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 1 && msg.result) {
            clearTimeout(timer);
            finish({ status: "up", error: null, durationMs: Date.now() - start });
            return;
          }
          if (msg.id === 1 && msg.error) {
            clearTimeout(timer);
            // `msg.error` is child-emitted RPC error text — it can reflect a
            // configured secret, so do NOT log it. The scrubbed text is logged
            // by `probeAndPersist` via the returned ProbeResult. RC-F.
            logger.warn(
              { tag: "mcp-probe", op: "init_rpc_error", command, pid, hasRpcError: true },
              "MCP initialize returned error",
            );
            finish({
              status: "down",
              error: `initialize returned error: ${JSON.stringify(msg.error)}`,
              durationMs: Date.now() - start,
            });
            return;
          }
        } catch {
          // Raw stdout line may hold a secret — log its length only. RC-F.
          logger.trace(
            { tag: "mcp-probe", op: "non_json_stdout", command, pid, lineLength: line.length },
            "Non-JSON stdout line",
          );
        }
      }
    });

    const initRequest =
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "libi-prober", version: "1.0.0" },
        },
      }) + "\n";

    try {
      child.stdin?.write(initRequest);
      initSentAt = Date.now() - start;
      logger.debug(
        { tag: "mcp-probe", op: "init_sent", command, pid, msSinceSpawn: initSentAt },
        "Sent initialize request to MCP child",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        { tag: "mcp-probe", op: "stdin_write_failed", command, pid, err: message },
        "Failed to write initialize to MCP child stdin",
      );
      finish({ status: "down", error: message, durationMs: Date.now() - start });
    }
  }).then((result) => {
    // The error text (which may embed raw stderr) is NOT logged here — only
    // `probeAndPersist` logs it, after scrubbing configured secrets. Emit the
    // presence + length so failures are still traceable. RC-F.
    logger.info(
      {
        tag: "mcp-probe",
        op: "complete",
        command,
        status: result.status,
        durationMs: result.durationMs,
        hasError: result.error !== null,
        errorLength: result.error?.length ?? 0,
      },
      `MCP probe complete (${result.status}, ${result.durationMs}ms)`,
    );
    return result;
  });
}
