import { spawn } from "child_process";
import { Writable } from "stream";
import { toWebReadable } from "@/lib/http/streams";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
} from "@agentclientprotocol/sdk";
import { getAgentConfig } from "./acp/agent-registry";
import { isUsableCli, resolveAgentCli } from "@/lib/agents/cli/resolve";
import { cliUnavailableReason } from "@/lib/agents/cli/unavailable-reason";
import { getAgentSetup, isSetupAgentId } from "@/lib/agents/setup/registry";
import { AgentSpawnRefusedError } from "@/lib/agents/spawn-refused-error";
import { isShellEnvLoaded } from "@/lib/runtime/shell-env-state";
import type { AgentUnavailableReason } from "@/lib/agents/types";
import { ensureCodexHome } from "@/lib/codex-config/canonical";
import { stripHostSessionEnv } from "@/lib/agents/child-env";
import { CODEX_ACP_DISABLE_MCP_FILTER_ENV } from "@/lib/mcp/agent-surface";
import { LIBI_SERVER_PORT_ENV } from "@/lib/libi-home";
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

/** The refusal reason when nothing more specific is known about why an agent can't spawn. */
function notSetUpReason(agentId: string): AgentUnavailableReason {
  return {
    code: "not_installed",
    message: `${getAgentSetup(agentId)?.name ?? agentId} isn't set up yet — open Agents to install it.`,
  };
}

export class AgentProcessManager {
  /** agentId -> ManagedProcess */
  private processes = new Map<string, ManagedProcess>();

  /** Registered by SessionManager during startup to break circular dep. */
  private hooks: SessionManagerHooks | null = null;

  /** agentId -> was the user's shell environment loaded when that agent's CURRENT process was
   *  spawned? A child's environment is fixed at spawn, so this is never re-read later. */
  private shellEnvAtSpawn = new Map<string, boolean>();

  /** Processes taken out of service — replaced, terminated, shut down, or killed after a failed
   *  initialize. Their exit or error is expected and touches nothing. */
  private retiring = new WeakSet<ManagedProcess>();

  /** Set once the whole server is exiting. A process that finishes initializing afterwards is
   *  retired as it arrives, like every process that was current when the exit began. */
  private exiting = false;

  /** agentId -> the spawn in progress. A process enters `processes` only once ACP has initialized,
   *  so without this two starts that overlap (a re-select during a restart) would each spawn an
   *  adapter, and the second `processes.set` would orphan a live child. */
  private spawning = new Map<string, Promise<ManagedProcess>>();

  /** agentId -> the `restartProcess` in progress. Between the old process leaving `processes` and
   *  the new one initializing there is NO connection; callers that need one wait on this. */
  private restarts = new Map<string, Promise<void>>();

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

  /** Whether `agentId`'s process was spawned with the user's shell environment (the desktop app
   *  loads it in the background, so an early spawn can miss it). No process yet → the answer a
   *  spawn right now would get. */
  spawnedWithShellEnv(agentId: string): boolean {
    return this.shellEnvAtSpawn.get(agentId) ?? isShellEnvLoaded();
  }

  /** Kill `agentId`'s process (if any) and spawn a fresh one. Used only to hand an IDLE agent the
   *  shell environment that arrived after it started — never while a chat runs on it. A second
   *  call while one is in progress shares it. */
  restartProcess(agentId: string): Promise<void> {
    const inflight = this.restarts.get(agentId);
    if (inflight) return inflight;
    const restart = this.replaceProcess(agentId).finally(() => {
      if (this.restarts.get(agentId) === restart) this.restarts.delete(agentId);
    });
    this.restarts.set(agentId, restart);
    return restart;
  }

  /** The restart of `agentId` in progress, as a promise that settles (never rejects) once it is
   *  over — the new connection is up, or the restart failed and there is none. Null when no restart
   *  is in progress, so a caller with nothing to wait on stays synchronous. */
  pendingRestart(agentId: string): Promise<void> | null {
    const restart = this.restarts.get(agentId);
    return restart ? restart.then(() => undefined, () => undefined) : null;
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
    await this.retireAll();
  }

  /**
   * Mark every agent process retiring because the server itself is exiting, without signalling or
   * awaiting anything. Call it first thing on a signal shutdown. Ctrl+C in the terminal running libi
   * delivers SIGINT to the whole foreground process group, adapters included (they are not
   * detached), and the shutdown then waits on other children before it exits. An adapter that dies
   * of that signal meanwhile would otherwise be reported as a crash, and every open chat would show
   * "Process was killed by SIGINT" while the server is going away on purpose. The processes stay in
   * `processes`, so nothing sees a missing connection and spawns a fresh adapter during the exit;
   * the children end with the parent.
   */
  retireAllForExit(): void {
    this.exiting = true;
    for (const managed of this.processes.values()) this.retiring.add(managed);
    logger.info(
      { tag: "process-manager", op: "retire_all_for_exit", count: this.processes.size },
      "Server is exiting; agent process exits from here on are expected",
    );
  }

  /**
   * Terminate every running agent process. Used when global state changes
   * (e.g., custom instructions updated) require a clean slate.
   * Returns the number of processes that were running.
   */
  async terminateAll(): Promise<number> {
    return this.retireAll();
  }

  // -------------------------------------------------------------------------
  // Private: Process lifecycle
  // -------------------------------------------------------------------------

  private async replaceProcess(agentId: string): Promise<void> {
    // A spawn already under way would land AFTER the kill below and survive the restart. Only
    // awaited when there is one: otherwise the old process leaves `processes` synchronously.
    const spawning = this.spawning.get(agentId);
    if (spawning) await spawning.catch(() => {});
    const existing = this.processes.get(agentId);
    if (existing) {
      this.retire(existing);
      await this.killProcess(existing);
    }
    await this.ensureProcess(agentId);
  }

  /**
   * Retire and kill every process. Each one leaves `processes` BEFORE its kill is awaited: a kill
   * gives up on a child 3 s after SIGTERM with its exit still unseen, and neither that late exit
   * nor a map cleared afterwards may drop a process started in the meantime (the respawn after a
   * terminate, or a spawn that was already under way). Returns how many there were.
   */
  private async retireAll(): Promise<number> {
    const all = [...this.processes.values()];
    for (const managed of all) this.retire(managed);
    await Promise.allSettled(all.map((managed) => this.killProcess(managed)));
    return all.length;
  }

  /** Take `managed` out of service: its exit or error from here on touches nothing, and it leaves
   *  `processes` if it is still its agent's current process. */
  private retire(managed: ManagedProcess): void {
    this.retiring.add(managed);
    if (this.processes.get(managed.agentId) !== managed) return;
    this.processes.delete(managed.agentId);
    this.shellEnvAtSpawn.delete(managed.agentId);
  }

  private ensureProcess(agentId: string): Promise<ManagedProcess> {
    const existing = this.processes.get(agentId);
    if (existing) {
      logger.debug(
        { tag: "process-manager", op: "ensure_reuse", agentId },
        `Process for ${agentId} already running (reusing)`,
      );
      return Promise.resolve(existing);
    }
    const inflight = this.spawning.get(agentId);
    if (inflight) {
      logger.debug(
        { tag: "process-manager", op: "ensure_join_spawn", agentId },
        `Process for ${agentId} is already being spawned (joining)`,
      );
      return inflight;
    }
    const spawned = this.spawnProcess(agentId).finally(() => {
      if (this.spawning.get(agentId) === spawned) this.spawning.delete(agentId);
    });
    this.spawning.set(agentId, spawned);
    return spawned;
  }

  private async spawnProcess(agentId: string): Promise<ManagedProcess> {
    logger.info(
      { tag: "process-manager", op: "spawn_start", agentId },
      `Spawning agent process: ${agentId}`,
    );

    const agentConfig = getAgentConfig(agentId);
    if (!agentConfig?.installed) {
      // No adapter on disk: nothing to spawn. Detection names the cause; the
      // Agents tab is where the user installs it.
      throw new AgentSpawnRefusedError(
        agentId,
        agentConfig?.unavailableReason ?? notSetUpReason(agentId),
      );
    }

    // The adapter execs the USER's CLI, named by CLAUDE_CODE_EXECUTABLE /
    // CODEX_PATH. No usable CLI means no spawn, ever: codex-acp would otherwise
    // fall back to `node @openai/codex/bin/codex.js`, which the adapter install
    // (`--omit=optional`) never put on disk. A missing or unusable CLI is what
    // the user installs or updates from Agents. `staleOk`: once the CLI has been
    // resolved as usable, a spawn never waits on the login-shell probe or
    // `--version` — an expired usable memo is served and refreshed in the
    // background, while one that would refuse the spawn is resolved afresh
    // first, so a CLI the user just updated is not refused. An agent without a
    // setup declaration has no CLI of the user's to resolve, so it gets no CLI env.
    let cliEnv: Record<string, string> = {};
    if (isSetupAgentId(agentId)) {
      const cli = await resolveAgentCli(agentId, { staleOk: true });
      const cliReason = cliUnavailableReason(agentId, cli);
      if (cliReason !== null || !isUsableCli(cli)) {
        throw new AgentSpawnRefusedError(
          agentId,
          cliReason ?? notSetUpReason(agentId),
        );
      }
      if (agentId === "claude-code") cliEnv = { CLAUDE_CODE_EXECUTABLE: cli.execPath };
      else if (agentId === "codex") cliEnv = { CODEX_PATH: cli.execPath };
    }

    // MCP_TIMEOUT (default 30000ms in claude-agent-sdk) is the per-MCP
    // initialize/connect deadline. Bundled MCP servers like yt-dlp-mcp
    // shell out to a PyInstaller binary that takes 10+ seconds to unpack on
    // cold start, and parallel-spawned children compete for disk IO and can
    // hit 40+ seconds. 60000ms gives every MCP — bundled or user-added —
    // 2x today's headroom without changing the SDK.
    // CODEX_HOME: the same home the built-in Terminal's PTY is given
    // (lib/terminal/manager.ts), which is where a setup terminal's
    // `codex mcp add` writes. Without it this child inherited nothing and codex
    // fell back to its own default `~/.codex`, so under LIBI_TEST_MODE=1
    // (skill-eval), where resolveCodexHome() returns `<LIBI_HOME>/.codex`, the
    // Terminal read the scoped home while the agent read the user's real one:
    // the surface used to VERIFY Codex behaviour was the one surface not under
    // test. Everywhere else both are the user's `~/.codex`. Harmless for
    // Claude, which ignores it — same as the PTY.
    //
    // `ensureCodexHome`, not `resolveCodexHome`: naming a directory that does
    // not exist makes codex EXIT 1 ("CODEX_HOME points to … but that path does
    // not exist"), which is how the first version of this change broke Codex
    // on a scoped home. Creating it is unconditional for the same reason the
    // variable is — gating on the agent id would leave the hole open for
    // whichever surface we forgot.
    // The child takes `process.env` as it is at THIS moment, so this is what decides whether its
    // chats run with the user's shell environment.
    const shellEnvLoaded = isShellEnvLoaded();
    // DISABLE_MCP_CONFIG_FILTERING: codex-acp DROPS an ACP `mcpServers` entry
    // whose name already exists in the user's config
    // (`shouldDeduplicateMcpConflicts()`, read per call from `process.env`),
    // and libi's entry is deliberately named `libi` — the same name
    // `libi connect` writes — so that the ACP entry REPLACES the config one
    // instead of mounting libi twice. Without this flag the filter drops
    // libi's entry and the in-app session falls back to the headerless
    // registration, losing its surface. Set unconditionally for the same
    // reason CODEX_HOME is: gating on the agent id leaves the hole open for
    // whichever surface we forgot, and nothing but codex-acp reads it.
    // See `lib/mcp/agent-surface.ts#LIBI_MCP_ENTRY_NAME`.
    // `cliEnv` comes after `...process.env` so it overrides an inherited value.
    //
    // Minus LIBI_SERVER_PORT, which Category B sets in this server's own
    // environment. The agent reaches libi through the aggregator URL in its
    // ACP `mcpServers`, never through an inherited port, and what its shell
    // starts is the user's, as in the terminal (`lib/terminal/manager.ts`): a
    // stdio libi MCP pointed at another home has to find that home's server.
    const agentEnv: NodeJS.ProcessEnv = stripHostSessionEnv({
      ...process.env,
      ...cliEnv,
      MCP_TIMEOUT: "60000",
      CODEX_HOME: ensureCodexHome(),
      [CODEX_ACP_DISABLE_MCP_FILTER_ENV]: "true",
    });
    delete agentEnv[LIBI_SERVER_PORT_ENV];
    const child = spawn(agentConfig.command, [...agentConfig.args], {
      // windowsHide: Electron's main process is a GUI-subsystem process with no
      // console, so Windows allocates a BRAND-NEW console for every
      // console-subsystem child — which Windows 11 hands to Windows Terminal.
      // The adapter is long-lived, so that window sat open for the whole
      // session, empty (stdin/stdout are pipes; `inherit`ed stderr has no
      // console to land in), with libi's node path as its title. Observed on
      // the Azure QA box 2026-08-23. Harmless everywhere else: Node ignores
      // this option off Windows, and under `npx` the parent already owns a
      // console so no window was ever created.
      windowsHide: true,
      stdio: ["pipe", "pipe", "inherit"],
      env: agentEnv,
    });

    const managed: ManagedProcess = {
      agentId,
      childProcess: child,
      connection: null!,
      agentCapabilities: null,
      knownSessionIds: new Set(),
    };

    child.on("error", (err) => {
      if (this.retiring.has(managed)) return;
      this.handleProcessCrash(managed, `Process error: ${err.message}`);
    });

    child.on("exit", (code, signal) => {
      if (this.retiring.has(managed)) return;
      if (code !== 0 && code !== null) {
        this.handleProcessCrash(managed, `Process exited with code ${code}`);
      } else if (signal !== null) {
        // Killed by a signal libi did not send (libi retires a process before signalling it): an
        // OOM kill, say. That is a crash too — reported, or its sessions stay active on a dead
        // connection.
        this.handleProcessCrash(managed, `Process was killed by ${signal}`);
      } else {
        this.cleanupProcess(managed);
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
    managed.connection = new ClientSideConnection(() => client, stream);

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
      // Retired first: this child's exit can land after the next spawn has initialized. The same
      // kill as everywhere else, so a child that ignores SIGTERM is still SIGKILLed after the grace.
      this.retire(managed);
      void this.killProcess(managed);
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
    this.shellEnvAtSpawn.set(agentId, shellEnvLoaded);
    if (this.exiting) this.retiring.add(managed);
    return managed;
  }

  /** SIGTERM, then SIGKILL if the child has not exited 3 s later. Exit is read from `exitCode` /
   *  `signalCode`, never `killed`: `killed` turns true the moment a signal is SENT, so a child that
   *  ignores SIGTERM would read as dead and outlive the kill untracked. */
  private killProcess(managed: ManagedProcess): Promise<void> {
    return new Promise<void>((resolve) => {
      const child = managed.childProcess;
      const exited = () => child.exitCode !== null || child.signalCode !== null;
      if (exited()) {
        resolve();
        return;
      }
      const forceKill = setTimeout(() => {
        if (!exited()) child.kill("SIGKILL");
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

  /**
   * Acts only on the agent's CURRENT process, compared by identity. The agent id alone would reach
   * whatever process holds that key by the time the exit lands — a successor, whose sessions would
   * be errored and which would be left running untracked. A process that never became current (it
   * died before initializing) has no sessions to report.
   */
  private handleProcessCrash(managed: ManagedProcess, errorMessage: string): void {
    if (this.processes.get(managed.agentId) !== managed) return;
    this.hooks?.onProcessCrash(managed.agentId, errorMessage);
    this.cleanupProcess(managed);
  }

  private cleanupProcess(managed: ManagedProcess): void {
    if (this.processes.get(managed.agentId) !== managed) return;
    this.processes.delete(managed.agentId);
    this.shellEnvAtSpawn.delete(managed.agentId);
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
