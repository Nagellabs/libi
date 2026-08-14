import { spawn } from "child_process";
import { Writable } from "stream";
import { toWebReadable } from "@/lib/http/streams";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent,
  type Client,
} from "@agentclientprotocol/sdk";
import { getAgentConfig } from "./acp/agent-registry";
import {
  type ManagedProcess,
  ACP_INIT_TIMEOUT_MS,
} from "./managed-types";
import { serverLogger as logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// AgentProcessManager
//
// Manages agent subprocess lifecycle only. Session state lives in
// SessionManager (lib/sessions/session-manager.ts).
//
// One process per agent type (claude-code, codex, ...).
//
// Related modules:
//   managed-types.ts          — ManagedProcess interface
//   session-event-handler.ts  — ACP event routing + message cache building
//   lib/sessions/session-manager.ts — session lifecycle + state
// ---------------------------------------------------------------------------

/**
 * Narrow set of callbacks that SessionManager registers on AgentProcessManager
 * to break the circular import dependency. AgentProcessManager never imports
 * session-manager directly.
 */
export interface SessionManagerHooks {
  shutdown: () => Promise<void>;
  createClient: (managed: ManagedProcess) => Client;
  onProcessCrash: (agentId: string, errorMessage: string) => void;
}

export class AgentProcessManager {
  /** agentId -> ManagedProcess */
  private processes = new Map<string, ManagedProcess>();

  /** Registered by SessionManager during startup to break circular dep. */
  private hooks: SessionManagerHooks | null = null;

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Register the SessionManager callbacks. Called once during initialization. */
  setSessionManagerHooks(hooks: SessionManagerHooks): void {
    this.hooks = hooks;
  }

  /** Spawn a process without creating a session (for eager warming). */
  async warmProcess(agentId: string): Promise<void> {
    await this.ensureProcess(agentId);
  }

  /** Get the ACP connection for an agent. Returns null if no process exists. */
  getConnection(agentId: string): ClientSideConnection | null {
    return this.processes.get(agentId)?.connection ?? null;
  }

  /** Get capabilities by agent ID (used in providers listing). */
  getCapabilitiesForAgent(agentId: string): { canListSessions: boolean } {
    const managed = this.processes.get(agentId);
    return {
      canListSessions: !!managed?.agentCapabilities?.sessionCapabilities?.list,
    };
  }

  /** Register a sessionId as known to the agent's process (for ACP event routing). */
  registerSessionId(agentId: string, sessionId: string): void {
    this.processes.get(agentId)?.knownSessionIds.add(sessionId);
  }

  /** Unregister a sessionId from the agent's process. */
  unregisterSessionId(agentId: string, sessionId: string): void {
    this.processes.get(agentId)?.knownSessionIds.delete(sessionId);
  }

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  async shutdown(): Promise<void> {
    // Shut down session manager first (if hooks are registered)
    if (this.hooks) {
      await this.hooks.shutdown();
    }

    const kills: Promise<void>[] = [];

    for (const [, managed] of this.processes) {
      kills.push(this.killProcess(managed));
    }

    await Promise.allSettled(kills);
    this.processes.clear();
  }

  /**
   * Terminate every running agent process. Used when global state changes
   * (e.g., custom instructions updated) require a clean slate.
   * Returns the number of processes that were running.
   */
  async terminateAll(): Promise<number> {
    const count = this.processes.size;
    const kills: Promise<void>[] = [];
    for (const [, managed] of this.processes) {
      kills.push(this.killProcess(managed));
    }
    await Promise.allSettled(kills);
    this.processes.clear();
    return count;
  }

  // -------------------------------------------------------------------------
  // Private: Process lifecycle
  // -------------------------------------------------------------------------

  private async ensureProcess(agentId: string): Promise<ManagedProcess> {
    const existing = this.processes.get(agentId);
    if (existing) {
      logger.debug(
        { tag: "process-manager", op: "ensure_reuse", agentId },
        `Process for ${agentId} already running (reusing)`,
      );
      return existing;
    }
    logger.info(
      { tag: "process-manager", op: "spawn_start", agentId },
      `Spawning agent process: ${agentId}`,
    );

    const agentConfig = getAgentConfig(agentId);
    if (!agentConfig?.installed) {
      // Name the cause when detection knows it (still installing / half-installed
      // tree / absent) — a bare "not installed" sends the user hunting for a CLI
      // that a restart would have finished installing on its own.
      const why = agentConfig?.unavailableReason;
      throw new Error(
        `Agent ${agentId} is not installed` +
          (why ? `: ${why.message}${why.detail ? ` (${why.detail})` : ""}` : ""),
      );
    }

    // MCP_TIMEOUT (default 30000ms in claude-agent-sdk) is the per-MCP
    // initialize/connect deadline. Bundled MCP servers like yt-dlp-mcp
    // shell out to a PyInstaller binary that takes 10+ seconds to unpack on
    // cold start, and parallel-spawned children compete for disk IO and can
    // hit 40+ seconds. 60000ms gives every MCP — bundled or user-added —
    // 2x today's headroom without changing the SDK.
    const child = spawn(agentConfig.command, [...agentConfig.args], {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, MCP_TIMEOUT: "60000" },
    });

    const managed: ManagedProcess = {
      agentId,
      childProcess: child,
      connection: null!,
      agentCapabilities: null,
      knownSessionIds: new Set(),
    };

    child.on("error", (err) => {
      this.handleProcessCrash(agentId, `Process error: ${err.message}`);
    });

    child.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        this.handleProcessCrash(agentId, `Process exited with code ${code}`);
      } else {
        this.cleanupProcess(agentId);
      }
    });

    const writableStream = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
    const readableStream = toWebReadable(child.stdout!);
    const stream = ndJsonStream(writableStream, readableStream);

    if (!this.hooks) {
      throw new Error(
        "SessionManager hooks not registered — call setSessionManagerHooks before using AgentProcessManager"
      );
    }
    const client = this.hooks.createClient(managed);
    managed.connection = new ClientSideConnection((_agent: Agent) => client, stream);

    const initTimeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`ACP initialize timed out for ${agentId}`)),
        ACP_INIT_TIMEOUT_MS
      )
    );

    try {
      const initResult = await Promise.race([
        managed.connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        }),
        initTimeout,
      ]);
      managed.agentCapabilities = initResult.agentCapabilities ?? null;
    } catch (err) {
      child.kill("SIGTERM");
      throw err;
    }

    logger.info(
      {
        tag: "process-manager",
        op: "acp_initialized",
        agentId,
        agentCapabilities: managed.agentCapabilities ?? null,
      },
      `ACP connection initialized for ${agentId}`,
    );
    this.processes.set(agentId, managed);
    return managed;
  }

  private killProcess(managed: ManagedProcess): Promise<void> {
    return new Promise<void>((resolve) => {
      const child = managed.childProcess;
      if (child.killed || child.exitCode !== null) {
        resolve();
        return;
      }
      const forceKill = setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
        resolve();
      }, 3000);
      child.once("exit", () => {
        clearTimeout(forceKill);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  // -------------------------------------------------------------------------
  // Private: Crash handling
  // -------------------------------------------------------------------------

  private handleProcessCrash(agentId: string, errorMessage: string): void {
    this.hooks?.onProcessCrash(agentId, errorMessage);
    this.cleanupProcess(agentId);
  }

  private cleanupProcess(agentId: string): void {
    this.processes.delete(agentId);
  }
}

// ---------------------------------------------------------------------------
// Singleton (survives Next.js HMR via globalThis)
//
// Paired with SM_GLOBAL_KEY in session-manager.ts — both are bumped together
// so the wiring between PM and SM stays consistent after a class-shape change.
// ---------------------------------------------------------------------------

const PM_GLOBAL_KEY = "__agentProcessManager_v2";

const globalForPM = globalThis as unknown as {
  [PM_GLOBAL_KEY]?: AgentProcessManager;
};

export function getProcessManager(): AgentProcessManager {
  let pm = globalForPM[PM_GLOBAL_KEY];
  if (pm) return pm;

  pm = new AgentProcessManager();
  globalForPM[PM_GLOBAL_KEY] = pm;

  return pm;
}
