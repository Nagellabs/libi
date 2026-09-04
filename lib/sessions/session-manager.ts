import type {
  ClientSideConnection,
  SessionConfigOption,
  SessionInfo,
} from "@agentclientprotocol/sdk";
import type { AgentEvent } from "@/lib/agents/types";
import type { AgentMessage } from "@/lib/agents/message-types";
import type { AgentReadiness } from "@/lib/agents/agent-readiness";
import { isAuthRequiredError } from "@/lib/agents/agent-readiness";
import type { TerminalRemedy } from "@/lib/agents/terminal-remedy";
import { resolveSignInRemedy } from "@/lib/agents/acp/sign-in-remedy";
import type { SessionEntry, GlobalSessionEventListener, SystemEvent } from "./types";
import { SessionEventHandler } from "@/lib/agents/session-event-handler";
import { MAX_ACTIVE_SESSIONS } from "./types";
import { getLibiAgentDir } from "@/lib/libi-home";
import { getMcpServersForAcp, onMcpConfigInvalidated } from "@/lib/mcp-config";
import { serverLogger as logger } from "@/lib/logger";
import { getProcessManager } from "@/lib/agents/process-manager";
import { applyAttachmentParsing } from "@/lib/agents/parse-attachments";
import { getApprovalMode } from "@/lib/approval/settings";
import { acpModeFor } from "@/lib/sessions/approval-mode-map";
import type { McpToolId } from "@/lib/agents/mcp-tool-id";
import { matchToolCall, type ToolCallCandidate } from "@/lib/sessions/tool-call-matcher";
import {
  deriveModelSnapshot,
  extractModelOption,
  MODEL_CONFIG_ID,
  type ModelState,
  type SessionModelSnapshot,
} from "@/lib/sessions/model-option";
import { recordWindow } from "@/lib/sessions/model-window-cache";
import { sessionMetaFor } from "@/lib/sessions/session-meta";
import {
  promptErrorNote,
  type AuthNoteContext,
} from "@/lib/sessions/prompt-error-note";
import { getAgentModelId, setAgentModelId } from "@/lib/sessions/model-preferences";
import { getSettings, updateSettings } from "@/lib/db/settings";
import { trackServerEvent } from "@/lib/analytics/server";
import type {
  SessionUsageState,
  AvailableCommandInfo,
} from "@/lib/sessions/usage";

/**
 * Flip `agentEverConnected` to true the first time a session successfully
 * connects, and emit the one-shot `agent_connected` analytics milestone.
 * Also arms the first-run "Show me how it works" demo offer (Task 13) under
 * the SAME guard, so it goes out exactly once per install, on a real
 * connection — never on every session, and never lost to a reload, since it
 * lives in the DB rather than client `useState`.
 * Exported so it can be unit-tested without constructing a SessionManager.
 * Errors are swallowed — a DB hiccup must never break a connection.
 */
export function markAgentConnected(): void {
  try {
    if (!getSettings().agentEverConnected) {
      updateSettings({ agentEverConnected: true, onboardingDemoOfferedAt: new Date() });
      void trackServerEvent("agent_connected");
    }
  } catch {
    // Settings may be unavailable in some contexts; never break a connection.
  }
}

/**
 * The Terminal command that fixes "this agent isn't signed in", or null when
 * we have nothing honest to offer.
 *
 * Resolution is a lookup into `lib/agents/acp/sign-in-remedy.ts`, which
 * mirrors — rather than reaches into — the agent registry (it keeps its
 * resolved bins private) and knows, per agent, which real binary on this
 * machine performs the sign-in. That module's own comments explain WHY each
 * agent's remedy looks the way it does; this function only has to look it up.
 *
 * Exported for unit tests; there is no other caller.
 *
 * Never throws: this runs inside a failure path that is already reporting bad
 * news, and a filesystem hiccup while looking for a nicety must not replace an
 * accurate `needs-auth` with an unhandled rejection. `null` means "no button",
 * which every consumer already has to handle.
 */
export function signInRemedyFor(agentId: string): TerminalRemedy | null {
  try {
    return resolveSignInRemedy(agentId);
  } catch (err) {
    logger.warn(
      { tag: "session-manager", op: "sign_in_remedy_failed", agentId, err },
      "Could not resolve a sign-in remedy; reporting the problem without one",
    );
    return null;
  }
}

/**
 * A timeout that never keeps the process (or a vitest worker) alive on its own.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/** Structural equality, so a repeated identical outcome doesn't re-broadcast. */
function sameReadiness(a: AgentReadiness, b: AgentReadiness): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// SessionManager
//
// Source of truth for all session state. Replaces the session-tracking parts
// of ProcessManager. The ProcessManager delegates to this class for session
// lifecycle, event routing, and message cache management.
//
// Sessions are keyed by their ACP sessionId. Each session has listeners,
// a message cache, and metadata from the agent.
// ---------------------------------------------------------------------------

/**
 * Dump per-entry MCP spawn details for logging. envValues are stripped —
 * we only emit the env keys so secrets don't end up in `~/.libi/logs/libi.log`.
 * Lets investigations see exactly what was handed to `newSession`/`loadSession`.
 */
type AcpMcpEntry = ReturnType<typeof getMcpServersForAcp>[number];
function summarizeMcpServers(servers: AcpMcpEntry[]): Array<
  | { name: string; transport: "stdio"; command: string; args: string[]; envKeys: string[] }
  | { name: string; transport: "http" | "sse"; url: string; headerKeys: string[] }
> {
  return servers.map((s) => {
    if ("type" in s && (s.type === "http" || s.type === "sse")) {
      return {
        name: s.name,
        transport: s.type,
        url: s.url,
        headerKeys: (s.headers ?? []).map((h) => h.name).sort(),
      };
    }
    // Only the stdio transport variant lacks a `type` discriminant in the
    // McpServer union (SDK 0.25 added an `acp` variant); narrow to it.
    const stdio = s as Extract<AcpMcpEntry, { command: string }>;
    return {
      name: stdio.name,
      transport: "stdio" as const,
      command: stdio.command,
      args: stdio.args ?? [],
      envKeys: (stdio.env ?? []).map((e) => e.name).sort(),
    };
  });
}

export class SessionManager {
  /** sessionId -> SessionEntry */
  private sessions = new Map<string, SessionEntry>();

  /** Listeners that receive events for ALL sessions (tagged with sessionId) */
  private globalListeners = new Set<GlobalSessionEventListener>();

  /** Listeners registered before a session exists for a sessionId */
  private pendingListeners = new Map<string, Set<(event: AgentEvent) => void>>();

  /** Pre-created empty session ready to be claimed by the next createSession() call.
   *  Carries `availableCommands` because claude-agent-acp advertises them
   *  ~0ms after newSession() returns — before any SessionEntry exists — and
   *  never re-sends them at claim time. The event handler's orphan fallback
   *  stashes them here; claim hands them to the new entry. */
  private standbySession:
    | {
        agentId: string;
        sessionId: string;
        configOptions: SessionConfigOption[];
        availableCommands: AvailableCommandInfo[];
        availableModes?: { id: string }[];
      }
    | null = null;
  private standbyCreating = false;

  /** System-level (sessionless) listeners — e.g. standby-ready broadcasts. */
  private systemListeners = new Set<
    (event: SystemEvent) => void
  >();

  /**
   * agentId -> the last readiness we OBSERVED for it.
   *
   * Absent means "nothing attempted this process" — `{state:"unknown"}`, which
   * is explicitly NOT a claim of health. Only an ACP outcome ever writes here;
   * see lib/agents/agent-readiness.ts for why nothing probes credentials.
   */
  private readiness = new Map<string, AgentReadiness>();

  /**
   * Dedup concurrent activations. When activateSession() is called while another
   * call for the same sessionId is still awaiting loadSession(), the second call
   * returns the in-flight promise so both callers see the fully-replayed cache.
   */
  private activatingSessions = new Map<string, Promise<AgentMessage[]>>();

  /** The currently active agent ID (set by switchAgent / startup) */
  private _activeAgentId: string | null = null;

  /** Monotonic counter for unique message IDs — shared with SessionEventHandler */
  private msgCounter = 0;

  /** Resolved agent directory path */
  private agentDir: string | null = null;

  /** Lazy-initialized event handler (breaks circular dep with SessionEventHandler) */
  private eventHandler: SessionEventHandler | null = null;

  /** Process manager interface — set via setProcessManager() */
  private pm: {
    getConnection(agentId: string): ClientSideConnection | null;
    warmProcess(agentId: string): Promise<void>;
    getCapabilitiesForAgent(agentId: string): { canListSessions: boolean };
    registerSessionId(agentId: string, sessionId: string): void;
    unregisterSessionId(agentId: string, sessionId: string): void;
  } | null = null;

  // -------------------------------------------------------------------------
  // Getters
  // -------------------------------------------------------------------------

  get activeAgentId(): string | null {
    return this._activeAgentId;
  }

  /**
   * Shared reference to the message counter. Passed to SessionEventHandler
   * so both use the same monotonic sequence.
   */
  get msgCounterRef(): { next: () => number } {
    return { next: () => this.msgCounter++ };
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  /** Inject the process manager interface. Called once during startup. */
  setProcessManager(pm: {
    getConnection(agentId: string): ClientSideConnection | null;
    warmProcess(agentId: string): Promise<void>;
    getCapabilitiesForAgent(agentId: string): { canListSessions: boolean };
    registerSessionId(agentId: string, sessionId: string): void;
    unregisterSessionId(agentId: string, sessionId: string): void;
  }): void {
    this.pm = pm;
  }

  /** Get the agent directory (lazily resolved). */
  getAgentDir(): string {
    if (!this.agentDir) {
      this.agentDir = getLibiAgentDir();
    }
    return this.agentDir;
  }

  // -------------------------------------------------------------------------
  // 2. loadInitialSessions(agentId)
  // -------------------------------------------------------------------------

  /**
   * Eager fetch from ACP on startup. Paginated via cursor.
   * Populates the sessions map with inactive entries from the agent's history.
   */
  async loadInitialSessions(agentId: string): Promise<void> {
    if (!this.pm) return;

    const { canListSessions } = this.pm.getCapabilitiesForAgent(agentId);
    if (!canListSessions) return;

    const conn = this.pm.getConnection(agentId);
    if (!conn) return;

    this._activeAgentId = agentId;

    const allSessions: SessionInfo[] = [];
    let cursor: string | undefined;

    // Paginate through all sessions.
    //
    // NEVER let this reject the whole switch. `listSessions` is the FIRST call
    // that touches credentials for an agent advertising `canListSessions`
    // (codex does), so an unauthenticated user's `-32000 Authentication
    // required` used to propagate out of `switchAgent`, out of
    // `POST /api/agent/start` as a 500, and out of `selectAgent` — which
    // rethrows any non-OK response — as a full-page Next error overlay. That is
    // a crash standing in for an ordinary, expected state.
    //
    // Failing to list PAST sessions never means the agent is unusable: a new
    // chat may still be possible, and if it isn't, readiness says so honestly.
    // So we record what we learned and carry on with an empty history.
    try {
      do {
        const result = await conn.listSessions({
          cwd: this.getAgentDir(),
          cursor,
        });
        allSessions.push(...result.sessions);
        cursor = result.nextCursor ?? undefined;
      } while (cursor);
    } catch (err) {
      this.markAgentAuthFailure(agentId, err);
      logger.warn(
        { tag: "session-manager", op: "list_sessions_failed", agentId, err },
        "Could not list past sessions — continuing with an empty history",
      );
    }

    // Create inactive SessionEntry for each
    for (const info of allSessions) {
      if (this.sessions.has(info.sessionId)) continue;

      const entry: SessionEntry = {
        sessionId: info.sessionId,
        agentId,
        title: this.stripContextPrefix(info.title ?? null),
        updatedAt: info.updatedAt ?? null,
        active: false,
        lastUsed: info.updatedAt ? new Date(info.updatedAt).getTime() : 0,
        messageCache: [],
        currentAgentMessage: null,
        currentUserMessage: null,
        listeners: new Set(),
        pendingApprovals: new Map(),
        configOptions: [],
        latestUsage: null,
        availableCommands: [],
      };

      this.sessions.set(info.sessionId, entry);
    }

    logger.info(
      {
        tag: "session-manager",
        op: "load_initial_sessions",
        agentId,
        count: allSessions.length,
      },
      `Loaded ${allSessions.length} sessions for ${agentId}`,
    );
  }

  // -------------------------------------------------------------------------
  // 3. stripContextPrefix(title)
  // -------------------------------------------------------------------------

  /**
   * Strip the [Context: ...] prefix that gets injected into the first user
   * message and sometimes reflected in the session title.
   */
  private stripContextPrefix(title: string | null): string | null {
    if (!title) return title;
    return title.replace(/^\[Context:.*?\]\s*/i, "").trim() || null;
  }

  // -------------------------------------------------------------------------
  // 4. syncSessions()
  // -------------------------------------------------------------------------

  /**
   * Re-fetch sessions from ACP and merge with local state.
   * Active entries keep their state; metadata is overwritten.
   * New sessions are added as inactive.
   */
  async syncSessions(): Promise<void> {
    const agentId = this._activeAgentId;
    if (!agentId || !this.pm) return;

    const { canListSessions } = this.pm.getCapabilitiesForAgent(agentId);
    if (!canListSessions) return;

    const conn = this.pm.getConnection(agentId);
    if (!conn) return;

    const allSessions: SessionInfo[] = [];
    let cursor: string | undefined;

    do {
      const result = await conn.listSessions({
        cwd: this.getAgentDir(),
        cursor,
      });
      allSessions.push(...result.sessions);
      cursor = result.nextCursor ?? undefined;
    } while (cursor);

    const seen = new Set<string>();

    for (const info of allSessions) {
      seen.add(info.sessionId);
      const existing = this.sessions.get(info.sessionId);

      if (existing) {
        // Update metadata but preserve active state, cache, listeners
        existing.title = this.stripContextPrefix(info.title ?? null);
        existing.updatedAt = info.updatedAt ?? null;
      } else {
        // New session discovered — add as inactive
        const entry: SessionEntry = {
          sessionId: info.sessionId,
          agentId,
          title: this.stripContextPrefix(info.title ?? null),
          updatedAt: info.updatedAt ?? null,
          active: false,
          lastUsed: info.updatedAt ? new Date(info.updatedAt).getTime() : 0,
          messageCache: [],
          currentAgentMessage: null,
          currentUserMessage: null,
          listeners: new Set(),
          pendingApprovals: new Map(),
          configOptions: [],
          latestUsage: null,
          availableCommands: [],
        };
        this.sessions.set(info.sessionId, entry);
      }
    }

    // Note: we do NOT remove sessions that vanished from ACP — they may still
    // be active locally or have pending listeners.
  }

  // -------------------------------------------------------------------------
  // 5. createSession()
  // -------------------------------------------------------------------------

  /**
   * Build a fresh active SessionEntry and register it with the process manager.
   * Also drains any pending listeners and emits an initial "connected" event.
   * Shared between the standby-claim and fresh-newSession paths.
   */
  private registerActiveSession(
    sessionId: string,
    agentId: string,
    configOptions: SessionConfigOption[] = [],
    availableCommands: AvailableCommandInfo[] = [],
  ): SessionEntry {
    const entry: SessionEntry = {
      sessionId,
      agentId,
      title: null,
      // Stamp with `now` so the session appears under "Today" in the sidebar
      // immediately. The agent will overwrite this with its own updatedAt on
      // the next syncSessions() after the first message.
      updatedAt: new Date().toISOString(),
      active: true,
      lastUsed: Date.now(),
      messageCache: [],
      currentAgentMessage: null,
      currentUserMessage: null,
      listeners: new Set(),
      pendingApprovals: new Map(),
      configOptions,
      latestUsage: null,
      availableCommands,
    };
    this.sessions.set(sessionId, entry);
    this.pm?.registerSessionId(agentId, sessionId);
    this.drainPendingListeners(sessionId);
    this.emitForSession(sessionId, {
      type: "agent-status",
      status: "connected",
    });
    markAgentConnected();
    return entry;
  }

  /**
   * Create a new session. Claims the standby if available, otherwise creates
   * fresh via ACP newSession(). Returns the sessionId.
   */
  async createSession(): Promise<string> {
    const agentId = this._activeAgentId;
    if (!agentId || !this.pm) {
      throw new Error("No active agent — call switchAgent() first");
    }

    // Try to claim standby — zero-latency new chat. If the standby was
    // spawned with a cold MCP cache (Category B prewarm still running),
    // Category B's post-prewarm `invalidateMcpConfig` will refresh both
    // the standby and any active sessions so subsequent interactions hit
    // a warm cache. The user therefore gets an instant "New chat" the
    // moment the UI opens, at the cost of one refresh per active session
    // when Category B finishes (see session 6823b191 investigation).
    const standbyConfigOptions = this.standbySession?.configOptions ?? [];
    const standbyCommands = this.standbySession?.availableCommands ?? [];
    const standbyModes = this.standbySession?.availableModes;
    const standbyId = this.claimStandbySession(agentId);
    if (standbyId) {
      const claimedEntry = this.registerActiveSession(
        standbyId,
        agentId,
        standbyConfigOptions,
        standbyCommands,
      );
      // Carry the advertised mode vocabulary captured at standby creation onto
      // the claimed entry so this (and later) mode pushes gate on the real
      // advertised set instead of pushing an unadvertised id blind.
      claimedEntry.availableModes = standbyModes;
      // The standby was created earlier with whatever mode was saved at
      // standby-creation time. Re-push the current mode so it reflects any
      // changes the user made between standby creation and claim.
      await this.pushApprovalModeToSession(standbyId, agentId, standbyModes);
      await this.pushModelToSession(standbyId, agentId, standbyConfigOptions);
      return standbyId;
    }

    // Create fresh via ACP
    const conn = this.pm.getConnection(agentId);
    if (!conn) throw new Error(`No connection for agent ${agentId}`);

    await this.evictIfNeeded();

    const mcpServers = getMcpServersForAcp(agentId);
    const start = Date.now();
    logger.info(
      {
        tag: "session-manager",
        op: "new_session_start",
        agentId,
        reason: "fresh",
        mcpCount: mcpServers.length,
        mcpNames: mcpServers.map((m) => m.name),
        mcpDetails: summarizeMcpServers(mcpServers),
      },
      `Creating fresh session for ${agentId} with ${mcpServers.length} MCP server(s)`,
    );
    // The handshake is the readiness oracle: whichever way this settles is the
    // only honest evidence we have about whether the agent is usable. Both
    // outcomes are recorded; the rejection is re-thrown unchanged so
    // `POST /api/sessions` still fails loudly.
    let result: Awaited<ReturnType<typeof conn.newSession>>;
    try {
      result = await conn.newSession({
        cwd: this.getAgentDir(),
        mcpServers,
        _meta: sessionMetaFor(agentId),
      });
      this.markAgentReady(agentId);
    } catch (err) {
      this.markAgentAuthFailure(agentId, err);
      throw err;
    }
    logger.info(
      {
        tag: "session-manager",
        op: "new_session_done",
        agentId,
        sessionId: result.sessionId,
        durationMs: Date.now() - start,
        mcpCount: mcpServers.length,
      },
      `Fresh session ready: ${result.sessionId} (${Date.now() - start}ms)`,
    );

    const freshEntry = this.registerActiveSession(
      result.sessionId,
      agentId,
      result.configOptions ?? [],
    );
    // Cache the advertised mode vocabulary so later broadcasts / resumes (which
    // have no fresh newSession response) never push an unadvertised ACP mode id
    // blind — the codex -32602 bug.
    freshEntry.availableModes = result.modes?.availableModes;
    await this.pushApprovalModeToSession(
      result.sessionId,
      agentId,
      result.modes?.availableModes,
    );
    await this.pushModelToSession(
      result.sessionId,
      agentId,
      result.configOptions ?? [],
    );
    return result.sessionId;
  }

  // -------------------------------------------------------------------------
  // 6. activateSession(sessionId)
  // -------------------------------------------------------------------------

  /**
   * Resume an inactive session. Calls loadSession to replay history.
   * LRU evicts if needed. Returns the message cache after replay.
   *
   * Concurrent callers (e.g. POST /activate + GET /messages that race on the
   * same sessionId) dedupe against a single in-flight promise, so both observe
   * the fully replayed cache rather than an empty partial one.
   */
  async activateSession(sessionId: string): Promise<AgentMessage[]> {
    const inflight = this.activatingSessions.get(sessionId);
    if (inflight) return inflight;

    const entry = this.sessions.get(sessionId);
    if (!entry) {
      // No entry, so nothing will ever fill this session's options — the
      // client's model skeleton has to end here. `emitForSession` still
      // reaches the pending and global (SSE) listeners when the session map
      // has no entry, which is exactly the case a client can be watching:
      // it mounted a picker on the id it just asked to activate.
      this.emitTerminalModelSnapshot(sessionId, undefined);
      throw new Error(`Session ${sessionId} not found`);
    }

    // Already fully loaded — return the warm cache immediately.
    if (entry.active) return entry.messageCache;

    const promise = this.performActivation(sessionId, entry);
    this.activatingSessions.set(sessionId, promise);
    try {
      return await promise;
    } catch (err) {
      // EVERY activation-failure exit publishes a terminal model snapshot.
      // Without this the client would have to infer "the wait is over" from a
      // generic `agent-status: error`, which (a) misses the exits that throw
      // before any status frame at all — no process manager, no connection —
      // and (b) can't tell an activation failure from a mid-turn prompt error,
      // so it took a working picker away and put it back a moment later.
      // Guaranteeing the terminal event server-side is what lets the client
      // hold one rule: the skeleton clears only on agent-config-options.
      this.emitTerminalModelSnapshot(sessionId, entry.configOptions);
      throw err;
    } finally {
      this.activatingSessions.delete(sessionId);
    }
  }

  /**
   * Publish this session's model state as a TERMINAL snapshot — one whose
   * `supported: false` carries `pending: false`, i.e. "there is no answer
   * coming", never "still waiting".
   *
   * `deriveModelSnapshot` reports `pending: true` for an empty option list
   * because a history-restored session's options only arrive with
   * `loadSession`. That is right for the pre-activation callers, but wrong
   * once activation has ended: on the success path `LoadSessionResponse.
   * configOptions` is optional, so an adapter that omits it leaves the list
   * empty for good; on a failure path nothing is going to fill it either. A
   * `pending: true` in either case strands the client on a loading skeleton
   * that no later event clears.
   *
   * Options that ARE known still win — a session that was active before,
   * got evicted, and fails to reactivate keeps its picker rather than having
   * it collapse to "unsupported".
   */
  private emitTerminalModelSnapshot(
    sessionId: string,
    configOptions: SessionConfigOption[] | undefined,
  ): void {
    const snapshot = deriveModelSnapshot(configOptions);
    this.emitForSession(sessionId, {
      type: "agent-config-options",
      model: snapshot.supported ? snapshot : { supported: false, pending: false },
    });
  }

  private async performActivation(
    sessionId: string,
    entry: SessionEntry,
  ): Promise<AgentMessage[]> {
    const agentId = entry.agentId;
    if (!this.pm) throw new Error("No process manager set");

    const conn = this.pm.getConnection(agentId);
    if (!conn) throw new Error(`No connection for agent ${agentId}`);

    await this.evictIfNeeded(sessionId);

    // Reset cache for the replay.
    entry.messageCache = [];
    entry.currentAgentMessage = null;
    entry.currentUserMessage = null;
    entry.lastUsed = Date.now();

    this.pm.registerSessionId(agentId, sessionId);
    this.drainPendingListeners(sessionId);
    this.emitForSession(sessionId, {
      type: "agent-status",
      status: "connecting",
    });

    const mcpServers = getMcpServersForAcp(agentId);
    const loadStart = Date.now();
    logger.info(
      {
        tag: "session-manager",
        op: "load_session_start",
        agentId,
        sessionId,
        mcpCount: mcpServers.length,
        mcpNames: mcpServers.map((m) => m.name),
        mcpDetails: summarizeMcpServers(mcpServers),
      },
      `Loading session ${sessionId} for ${agentId} with ${mcpServers.length} MCP server(s)`,
    );
    // Mark the entry as replaying so the event handler ingests history WITHOUT
    // wall-clock timestamps/status — a replay-time Date.now() would be a lie
    // (bogus tool-call timers after session re-activation).
    const replayEntry = this.sessions.get(sessionId);
    if (replayEntry) replayEntry.isReplaying = true;
    try {
      const loadResult = await conn.loadSession({
        sessionId,
        cwd: this.getAgentDir(),
        mcpServers,
      });
      const resumedEntry = this.sessions.get(sessionId);
      if (resumedEntry && loadResult?.configOptions) {
        resumedEntry.configOptions = loadResult.configOptions;
      }
      logger.info(
        {
          tag: "session-manager",
          op: "load_session_done",
          agentId,
          sessionId,
          durationMs: Date.now() - loadStart,
        },
        `Loaded session ${sessionId} (${Date.now() - loadStart}ms)`,
      );
    } catch (err) {
      logger.warn(
        {
          tag: "session-manager",
          op: "load_session_failed",
          agentId,
          sessionId,
          durationMs: Date.now() - loadStart,
          err,
        },
        `Failed to load session ${sessionId}`,
      );
      // Replay failed — leave the entry inactive so a future activation can retry.
      entry.messageCache = [];
      this.emitForSession(sessionId, {
        type: "agent-status",
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      const e = this.sessions.get(sessionId);
      if (e) e.isReplaying = false;
    }

    // Clean dangling user message after replay.
    if (entry.currentUserMessage) {
      this.getEventHandler().cleanUserMessageParts(entry.currentUserMessage);
    }
    entry.currentAgentMessage = null;
    entry.currentUserMessage = null;

    // Only flip `active` true AFTER the replay has populated the cache. This
    // ensures every other API route that observes `active === true` also sees
    // a populated messageCache — no partial-cache windows.
    entry.active = true;

    // Re-push the saved approval mode now that the session is reattached.
    // Without this, an LRU-evicted-then-reactivated session would resume with
    // the agent's default mode rather than the user's saved policy.
    // `loadSession` doesn't re-advertise modes; pass undefined so the push
    // reads the cached `entry.availableModes` (captured at newSession/standby)
    // and never pushes an unadvertised id blind.
    await this.pushApprovalModeToSession(sessionId, agentId, undefined);
    await this.pushModelToSession(sessionId, agentId, entry.configOptions);

    // The event that un-sticks the model picker for a restored session: its
    // GET raced this activation, cached {supported:false, pending:true}, and
    // nothing else invalidates sessionModelKeys. Emitted AFTER the model
    // re-push above so the snapshot carries the RE-APPLIED saved model —
    // `pushModelToSession` rewrites `entry.configOptions` on success, so an
    // emit at the `loadSession` fill site would publish the pre-push
    // currentValue and nothing later would correct it.
    //
    // Activation is also the point where "not known yet" becomes "not
    // offered" — see `emitTerminalModelSnapshot`.
    this.emitTerminalModelSnapshot(sessionId, entry.configOptions);

    this.emitForSession(sessionId, {
      type: "agent-status",
      status: "connected",
    });

    return entry.messageCache;
  }

  // -------------------------------------------------------------------------
  // 7. deactivateSession(sessionId)
  // -------------------------------------------------------------------------

  /**
   * Close the ACP connection for a session. Preserves listeners as pending.
   * Clears cache to free memory. The session remains in the map as inactive.
   */
  async deactivateSession(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry || !entry.active) return;

    const agentId = entry.agentId;

    // Log the unload symmetrically with load_session_start/done. The
    // agent-switch stranding bug (send → 400 after switching away and back)
    // was needlessly hard to diagnose because sessions left the active set
    // with no trace in the log.
    logger.info(
      { tag: "session-manager", op: "session_deactivate", agentId, sessionId },
      `Deactivating session ${sessionId}`,
    );

    // Drain any pending permission requests as cancelled — covers LRU
    // eviction, switchAgent teardown, and explicit deactivation. The agent
    // is about to lose its connection so any held promises would dangle.
    this.resolveAllPendingAsCancelled(entry);

    // Preserve listeners as pending so they survive reactivation
    if (entry.listeners.size > 0) {
      let pending = this.pendingListeners.get(sessionId);
      if (!pending) {
        pending = new Set();
        this.pendingListeners.set(sessionId, pending);
      }
      for (const cb of entry.listeners) pending.add(cb);
    }

    // Close ACP connection
    if (this.pm) {
      const conn = this.pm.getConnection(agentId);
      if (conn) {
        try {
          await conn.closeSession({ sessionId });
        } catch {
          /* agent may not support close */
        }
      }
      this.pm.unregisterSessionId(agentId, sessionId);
    }

    // Clear cache but keep the entry
    entry.active = false;
    entry.messageCache = [];
    entry.currentAgentMessage = null;
    entry.currentUserMessage = null;
    entry.listeners = new Set();
  }

  // -------------------------------------------------------------------------
  // 8. cancelTurn(sessionId)
  // -------------------------------------------------------------------------

  /**
   * Resolve every pending permission request for `entry` as `cancelled` and
   * clear the map. Emits `agent-permission-resolved` for each so the chat UI
   * transitions any pending permission cards into their resolved state.
   *
   * This satisfies the ACP spec invariant — when `session/cancel` is sent,
   * every pending `requestPermission` MUST resolve with
   * `{ outcome: "cancelled" }`. Also applied on LRU eviction / process crash
   * / shutdown so promises don't dangle.
   */
  private resolveAllPendingAsCancelled(entry: SessionEntry): void {
    if (entry.pendingApprovals.size === 0) return;
    for (const [pendingId, pending] of entry.pendingApprovals) {
      try {
        pending.resolve({ outcome: { outcome: "cancelled" } });
      } catch {
        // Listener errors must not stop the drain.
      }
      this.emitForSession(entry.sessionId, {
        type: "agent-permission-resolved",
        pendingId,
        outcome: { kind: "cancelled" },
      });
    }
    entry.pendingApprovals.clear();
  }

  /**
   * Cancel the agent's current turn for a session WITHOUT closing the
   * connection. Sends ACP `session/cancel`. The agent will respond with
   * `stop_reason: "cancelled"` in its next PromptResponse and the SSE
   * stream will transition back to `agent-status: connected`.
   *
   * No-op when the session is inactive (nothing in flight), the session is
   * unknown, or no process manager has been set.
   */
  async cancelTurn(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry || !entry.active) return;
    if (!this.pm) return;
    const conn = this.pm.getConnection(entry.agentId);
    if (!conn) return;

    // Pre-drain: ACP spec requires every in-flight `requestPermission`
    // promise to resolve as `cancelled` when `session/cancel` is sent.
    // Drain first so existing pending promises don't dangle if cancel throws.
    this.resolveAllPendingAsCancelled(entry);

    try {
      await conn.cancel({ sessionId });
      logger.info({ sessionId }, "Sent ACP session/cancel");
    } catch (err) {
      logger.warn({ sessionId, err }, "Failed to send session/cancel");
    } finally {
      // Post-drain: catches any `requestPermission` that arrived during the
      // cancel round-trip. Without this, a permission request that lands
      // mid-await would never resolve (it'd sit in `pendingApprovals` after
      // cancelTurn returns). Runs on both success and failure paths.
      this.resolveAllPendingAsCancelled(entry);
    }
  }

  // -------------------------------------------------------------------------
  // 9. sendMessage(sessionId, text)
  // -------------------------------------------------------------------------

  /**
   * Send a message to the agent for a specific session.
   * Builds user + agent messages in cache. Calls conn.prompt().
   * Syncs sessions after completion.
   */
  async sendMessage(sessionId: string, text: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry || !entry.active) {
      this.emitForSession(sessionId, {
        type: "agent-status",
        status: "error",
        error: `No active session ${sessionId}. Please reconnect.`,
      });
      return;
    }

    if (!this.pm) {
      this.emitForSession(sessionId, {
        type: "agent-status",
        status: "error",
        error: "Session manager not initialized.",
      });
      return;
    }

    const conn = this.pm.getConnection(entry.agentId);
    if (!conn) {
      this.emitForSession(sessionId, {
        type: "agent-status",
        status: "error",
        error: `No connection for agent ${entry.agentId}.`,
      });
      return;
    }

    entry.lastUsed = Date.now();
    entry.currentUserMessage = null;

    // Build user message in cache. The `text` we receive from
    // /api/agent/send already has the `[Attached files]` block appended
    // (see formatAttachments there). Parse it into proper file-attachment
    // parts so the API-served cache matches the LIVE-built parts on the
    // client — otherwise a page refresh would render the inline block as
    // plain text instead of file chips.
    const userMsg: AgentMessage = {
      id: `user_${Date.now()}_${this.msgCounter++}`,
      role: "user",
      parts: applyAttachmentParsing([{ type: "text", text }]),
      timestamp: Date.now(),
    };
    entry.messageCache.push(userMsg);

    // Build agent message placeholder in cache
    const agentMsg: AgentMessage = {
      id: `agent_${Date.now()}_${this.msgCounter++}`,
      role: "agent",
      parts: [],
      timestamp: Date.now(),
    };
    entry.currentAgentMessage = agentMsg;
    entry.messageCache.push(agentMsg);

    this.emitForSession(sessionId, {
      type: "agent-status",
      status: "thinking",
    });

    try {
      const result = await conn.prompt({
        sessionId,
        prompt: [{ type: "text", text }],
      });
      entry.currentAgentMessage = null;
      this.emitForSession(sessionId, {
        type: "agent-complete",
        stopReason: result.stopReason,
      });
      // Remember the settled context window for (agent, model) so the next
      // process seeds the right denominator immediately instead of showing
      // the adapter's default seed for its first turn on this model. The
      // RAW reported size, never the corrected one — recording a correction
      // would make the cache self-confirming (see model-window-cache.ts).
      const settledUsage = entry.latestUsage;
      if (settledUsage) {
        const settledModel = extractModelOption(entry.configOptions);
        if (settledModel) {
          recordWindow(
            entry.agentId,
            settledModel.currentModelId,
            settledUsage.reportedSize,
          );
        }
      }
    } catch (err) {
      entry.currentAgentMessage = null;
      this.emitForSession(sessionId, {
        type: "agent-status",
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
      // The client renders the STATUS but drops that `error` text, so a
      // sign-in failure would otherwise be a silent no-op — the user's message
      // vanishing into nothing. Only that one error gets a note; see
      // lib/sessions/prompt-error-note.ts.
      const note = promptErrorNote(err, entry.agentId);
      if (note) {
        this.emitForSession(sessionId, {
          type: "chat-note",
          text: note,
          noteId: `note_${Date.now()}_${this.msgCounter++}`,
        });
      }
      // Claude fails auth HERE rather than at session/new, so without this the
      // readiness state would only ever describe codex. The chat note above
      // covers this one session; readiness is what every other surface reads.
      // The prompt path — a session exists and the user just sent something,
      // so "that message" is a real thing on screen. The other two call sites
      // are session/new and take the "session-start" default.
      this.markAgentAuthFailure(entry.agentId, err, "prompt");
    }

    // Sync session metadata (title may have changed) and notify clients once
    // the new metadata is in our map, so the sidebar can refresh its list.
    try {
      await this.syncSessions();
      this.emitForSession(sessionId, { type: "sessions-changed" });
    } catch {
      // Non-fatal — ACP may have hiccuped. Client will get the updated title
      // on the next sync (e.g. after the next message).
    }
  }

  /**
   * Post a deterministic, system-authored transparency note into the chat
   * of the most-recently-used active session WITHOUT prompting the agent.
   *
   * Unlike `sendMessage`, this does NOT call `conn.prompt()` — there is no
   * agent generation, no "thinking"/streaming state, and no empty agent
   * placeholder. The note is delivered as a `chat-note` SSE event and the
   * client renders it as a finished message. Ephemeral by design (not pushed
   * to `messageCache`): the durable record of a manual edit is the persisted
   * anchor + the Re-anchors panel, not this transparency line.
   *
   * Returns `false` when there is no active session (e.g. bring-your-own-CLI
   * with no in-app agent) so the caller can fall back to UI-only feedback.
   */
  postManualEditNote(text: string): boolean {
    const active = this.getActiveSessions().sort((a, b) => b.lastUsed - a.lastUsed)[0];
    if (!active) return false;
    this.emitForSession(active.sessionId, {
      type: "chat-note",
      text,
      noteId: `note_${Date.now()}_${this.msgCounter++}`,
    });
    return true;
  }

  // -------------------------------------------------------------------------
  // 8b. Approval mode → ACP setSessionMode bridge
  // -------------------------------------------------------------------------

  /**
   * Push the saved approval mode for `agentId` to the given session via ACP
   * `session/set_mode`, using the PER-AGENT mode vocabulary (`acpModeFor`).
   * Each ACP adapter advertises a different mode-id set — pushing Claude's
   * `bypassPermissions` to codex (which advertises `read-only|auto|full-access`)
   * yields ACP -32602 `approval.mode.set_failed`. `acpModeFor` maps + gates on
   * the advertised set, returning `null` when the target isn't advertised.
   *
   * `availableModes` is the array from `result.modes?.availableModes` on the
   * fresh `newSession` response. On the broadcast / standby-claim / resume call
   * sites (which don't have a fresh response), pass `undefined`; we then read
   * the CACHED `entry.availableModes` so we never push an unverified id blind.
   * When neither is known (`null` from `acpModeFor`) we skip + warn rather than
   * push an unadvertised id.
   *
   * Best-effort: errors are logged and swallowed so a flaky agent never breaks
   * session creation.
   */
  private async pushApprovalModeToSession(
    sessionId: string,
    agentId: string,
    availableModes: { id: string }[] | undefined,
  ): Promise<void> {
    const mode = getApprovalMode(agentId);
    // Prefer the freshly-supplied advertised set; otherwise fall back to the
    // set cached on the entry at fresh-newSession time. Never push blind.
    const modes =
      availableModes ?? this.sessions.get(sessionId)?.availableModes;
    const target = acpModeFor(agentId, mode, modes);
    if (target === null) {
      logger.warn(
        {
          agentId,
          mode,
          availableModes: modes?.map((m) => m.id),
        },
        "approval.mode.unsupported_by_agent",
      );
      return;
    }
    if (!this.pm) return;
    const conn = this.pm.getConnection(agentId);
    if (!conn) return;
    try {
      await conn.setSessionMode({ sessionId, modeId: target });
    } catch (err) {
      logger.warn(
        { err, agentId, sessionId, target },
        "approval.mode.set_failed",
      );
    }
  }

  /**
   * Re-push the saved approval mode to every active session belonging to
   * `agentId`. Called from the PATCH endpoint when the user changes their
   * mode for an agent so all currently-running sessions adopt the new policy
   * immediately. Inactive sessions get the new mode the next time they're
   * activated — `performActivation` re-pushes after `loadSession` succeeds.
   * Pushes run in parallel; each is independent and error-swallowing.
   */
  async applyApprovalModeToActiveSessions(agentId: string): Promise<void> {
    const targets: string[] = [];
    for (const entry of this.sessions.values()) {
      if (entry.agentId === agentId && entry.active) {
        targets.push(entry.sessionId);
      }
    }
    await Promise.all(
      targets.map((sessionId) =>
        this.pushApprovalModeToSession(sessionId, agentId, undefined),
      ),
    );
  }

  /**
   * Read the current model state for a session from its captured ACP config
   * options. Returns null when the session is unknown or advertises no model
   * select (→ the UI hides the picker).
   */
  getSessionModelState(sessionId: string): ModelState | null {
    const entry = this.sessions.get(sessionId);
    if (!entry) return null;
    return extractModelOption(entry.configOptions);
  }

  /**
   * Pending-aware variant of `getSessionModelState` for the GET route: keeps
   * "options not captured yet" (activation replay in flight) distinct from
   * "the agent offers no model select". Null when the session is unknown.
   */
  getSessionModelSnapshot(sessionId: string): SessionModelSnapshot | null {
    const entry = this.sessions.get(sessionId);
    if (!entry) return null;
    return deriveModelSnapshot(entry.configOptions);
  }

  /** Usage + advertised-commands snapshot for GET /api/sessions/[id]/context.
   *  Null when the session is unknown. */
  getSessionContext(sessionId: string): {
    usage: SessionUsageState | null;
    commands: AvailableCommandInfo[];
  } | null {
    const entry = this.sessions.get(sessionId);
    if (!entry) return null;
    return { usage: entry.latestUsage, commands: entry.availableCommands };
  }

  /**
   * Switch the model for a single session via ACP `session/set_config_option`
   * (configId "model"). Applies to this session immediately and persists the
   * choice per-agent (`setAgentModelId`) so it becomes the default for future
   * sessions — ACP adapters apply a switch only to the live session and do NOT
   * persist it, so libi re-applies the saved model on every new/standby/resumed
   * session via `pushModelToSession`. On success we update the cached
   * `currentValue` so a re-read reflects the choice without a round-trip.
   * Throws if the session is unknown, has no connection, or the agent rejects.
   *
   * NOTE (deliberate): unlike `applyApprovalModeToActiveSessions`, a model switch
   * is NOT fanned out to other open sessions of the agent — it's per-session +
   * persisted-as-future-default by design (one chat can run Opus, another Haiku).
   */
  async setSessionModel(sessionId: string, modelId: string): Promise<ModelState | null> {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error(`Session ${sessionId} not found`);
    if (!this.pm) throw new Error("No process manager set");
    const conn = this.pm.getConnection(entry.agentId);
    if (!conn) throw new Error(`No connection for agent ${entry.agentId}`);

    await conn.setSessionConfigOption({
      sessionId,
      configId: MODEL_CONFIG_ID,
      value: modelId,
    });

    // Persist per-agent so future sessions inherit it (adapters don't).
    setAgentModelId(entry.agentId, modelId);

    // Reflect the new currentValue in the cached model select.
    entry.configOptions = entry.configOptions.map((o) =>
      o.id === MODEL_CONFIG_ID && o.type === "select"
        ? { ...o, currentValue: modelId }
        : o,
    );
    logger.info(
      { tag: "session-manager", op: "set_session_model", sessionId, agentId: entry.agentId, modelId },
      `Model for ${sessionId} set to ${modelId}`,
    );
    return extractModelOption(entry.configOptions);
  }

  /**
   * Re-apply the user's saved model (if any) to a freshly created/claimed/
   * resumed session via ACP `session/set_config_option`. Mirrors
   * `pushApprovalModeToSession`: best-effort, errors logged and swallowed so a
   * flaky agent never breaks session creation. No-ops when there's no saved
   * model, the agent advertises no model select, the session already has the
   * saved model, or the saved model isn't among the agent's offered options.
   *
   * `configOptions` is the session's ACP config-option array (from the
   * new/load-session response) — used to read the current model + offered set
   * without a round-trip.
   */
  private async pushModelToSession(
    sessionId: string,
    agentId: string,
    configOptions: SessionConfigOption[],
  ): Promise<void> {
    const saved = getAgentModelId(agentId);
    if (!saved) return;
    const state = extractModelOption(configOptions);
    if (!state || state.currentModelId === saved) return;
    if (!state.availableModels.some((m) => m.id === saved)) return;
    if (!this.pm) return;
    const conn = this.pm.getConnection(agentId);
    if (!conn) return;
    try {
      await conn.setSessionConfigOption({
        sessionId,
        configId: MODEL_CONFIG_ID,
        value: saved,
      });
      // Reflect on the registered entry if this session is active.
      const entry = this.sessions.get(sessionId);
      if (entry) {
        entry.configOptions = entry.configOptions.map((o) =>
          o.id === MODEL_CONFIG_ID && o.type === "select"
            ? { ...o, currentValue: saved }
            : o,
        );
      }
    } catch (err) {
      logger.warn(
        { err, agentId, sessionId, saved, tag: "session-manager", op: "push_model_failed" },
        "model.push_failed",
      );
    }
  }

  // -------------------------------------------------------------------------
  // 8b. scheduleSessionReload(sessionId)
  // -------------------------------------------------------------------------

  /**
   * Schedule a reload of the given session's ACP connection. The reload
   * fires asynchronously (via setImmediate) — the calling tool's response
   * is delivered first. The current in-flight prompt is cancelled when
   * the underlying claude-agent-acp session is torn down; that's expected
   * and the tool's instruction tells the agent to end its turn.
   *
   * Used by `libi.restart_acp_session` from `mcp/bundled-mcps/install-tools.ts`.
   * Tier-2 install plans call it after the agent verifies the MCP is up so
   * the newly-installed tools become visible on the user's next message.
   *
   * Per the spike findings
   * (docs-local/superpowers/plans/spikes/2026-05-15-acp-reload.md), the in-flight
   * prompt cannot be preserved across reload. `activateSession` triggers
   * `loadSession` which internally tears down + recreates the underlying
   * Query when the mcpServers fingerprint changes. `createSession({resume})`
   * can throw `"No conversation found"` — the .catch() below absorbs that.
   */
  scheduleSessionReload(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      logger.warn(
        { tag: "session-manager", op: "schedule_reload_unknown", sessionId },
        "scheduleSessionReload called with unknown sessionId — ignoring",
      );
      return;
    }
    entry.reloadPending = true;
    logger.info(
      {
        tag: "session-manager",
        op: "schedule_reload",
        sessionId,
        reason: "agent-requested-reload",
      },
      `Scheduled ACP reload for session ${sessionId}`,
    );
    // Fire asynchronously — don't block the current prompt's tool result
    // delivery. The in-flight prompt will be cancelled by teardownSession;
    // the tool's result is already delivered before that happens.
    //
    // Why deactivateSession (not just `entry.active = false`): claude-agent-acp
    // caches a `sessionFingerprint` per session computed from cwd + mcpServers.
    // On the next `loadSession` it does an early-return when the fingerprint
    // matches, WITHOUT tearing down the underlying claude-code child process.
    // The child process keeps its skill-index cache, so newly synced
    // SKILL.md files don't surface in the agent's live Skill tool surface.
    // Calling deactivateSession invokes `conn.closeSession()` which
    // drops the ACP session entry on the agent side, so the upcoming
    // activateSession's loadSession sees a fresh session and re-builds the
    // skill index. See docs-local/superpowers/notes/2026-05-26-phase2-qa-findings.md
    // (Gap D) for the original bug report + fingerprint analysis.
    setImmediate(async () => {
      try {
        await this.deactivateSession(sessionId);
        await this.activateSession(sessionId);
      } catch (err) {
        logger.warn(
          {
            tag: "session-manager",
            op: "schedule_reload_failed",
            sessionId,
            err,
          },
          "Scheduled ACP reload failed",
        );
      }
    });
  }

  // -------------------------------------------------------------------------
  // 9. Standby methods
  // -------------------------------------------------------------------------

  /**
   * Pre-create an empty ACP session in the background.
   * Called after process warm-up and after each standby is claimed.
   */
  async createStandbySession(): Promise<void> {
    if (this.standbyCreating || this.standbySession) return;

    const agentId = this._activeAgentId;
    if (!agentId || !this.pm) return;

    const conn = this.pm.getConnection(agentId);
    if (!conn) return;

    this.standbyCreating = true;
    const start = Date.now();
    const mcpServers = getMcpServersForAcp(agentId);
    logger.info(
      {
        tag: "session-manager",
        op: "standby_create_start",
        agentId,
        mcpCount: mcpServers.length,
        mcpNames: mcpServers.map((m) => m.name),
        mcpDetails: summarizeMcpServers(mcpServers),
      },
      `Creating standby session for ${agentId} with ${mcpServers.length} MCP server(s)`,
    );
    try {
      const result = await conn.newSession({
        cwd: this.getAgentDir(),
        mcpServers,
        _meta: sessionMetaFor(agentId),
      });
      this.markAgentReady(agentId);
      this.standbySession = {
        agentId,
        sessionId: result.sessionId,
        configOptions: result.configOptions ?? [],
        availableCommands: [],
        availableModes: result.modes?.availableModes,
      };
      // Route ACP notifications for the standby NOW — claude-agent-acp sends
      // available_commands_update right after newSession() returns, and the
      // createClient gate drops updates for unregistered sessionIds. Without
      // this, every standby-claimed chat has an empty command palette until
      // a later loadSession re-activation (QA 2026-07-04).
      this.pm.registerSessionId(agentId, result.sessionId);
      await this.pushApprovalModeToSession(
        result.sessionId,
        agentId,
        result.modes?.availableModes,
      );
      await this.pushModelToSession(
        result.sessionId,
        agentId,
        result.configOptions ?? [],
      );
      logger.info(
        {
          tag: "session-manager",
          op: "standby_create_done",
          agentId,
          sessionId: result.sessionId,
          durationMs: Date.now() - start,
          mcpCount: mcpServers.length,
        },
        `Standby session ready: ${result.sessionId} (${Date.now() - start}ms)`,
      );
    } catch (err) {
      // For codex this is THE failure the user sees: it advertises
      // canListSessions:false, so the standby is the only session it would
      // ever get, and until now its death emitted nothing but
      // `standby-ready {ready:false}` — a "+" button stuck on
      // "Preparing a new chat session…" forever. Recording readiness turns
      // that into a stated, actionable cause.
      this.markAgentAuthFailure(agentId, err);
      logger.warn(
        {
          tag: "session-manager",
          op: "standby_create_failed",
          agentId,
          durationMs: Date.now() - start,
          readiness: this.getReadiness(agentId).state,
          err,
        },
        "Failed to create standby session",
      );
    } finally {
      this.standbyCreating = false;
      this.emitSystemEvent({
        type: "standby-ready",
        ready: this.isStandbyReady(),
      });
    }
  }

  /** Discard current standby and create a new one (e.g. on MCP config change). */
  invalidateStandbySession(): void {
    const old = this.standbySession;
    this.standbySession = null;
    this.emitSystemEvent({ type: "standby-ready", ready: false });

    // Close the old session to avoid leaking ACP resources
    if (old && this.pm) {
      const conn = this.pm.getConnection(old.agentId);
      if (conn) {
        conn
          .closeSession({ sessionId: old.sessionId })
          .catch(() => {});
      }
    }

    this.createStandbySession().catch(() => {});
  }

  /**
   * Claim the standby session for a new chat.
   * Returns sessionId if available and matching the requested agent, else null.
   */
  private claimStandbySession(agentId: string): string | null {
    if (!this.standbySession || this.standbySession.agentId !== agentId) {
      return null;
    }

    const sessionId = this.standbySession.sessionId;
    this.standbySession = null;

    // Tell the UI the standby is gone while we replenish, so the "+" button
    // disables itself until the next standby is confirmed ready.
    this.emitSystemEvent({ type: "standby-ready", ready: false });

    // Replenish in the background (this will emit standby-ready again on
    // success, re-enabling the button).
    this.createStandbySession().catch(() => {});

    logger.info(
      {
        tag: "session-manager",
        op: "standby_claim",
        agentId,
        sessionId,
      },
      `Claimed standby session: ${sessionId}`,
    );
    return sessionId;
  }

  // -------------------------------------------------------------------------
  // 10. LRU eviction
  // -------------------------------------------------------------------------

  /**
   * Evict the least-recently-used active session if at capacity.
   * Excludes the given sessionId from eviction (it's about to be activated).
   */
  private async evictIfNeeded(excludeSessionId?: string): Promise<void> {
    const activeSessions = [...this.sessions.values()].filter(
      (s) => s.active && s.sessionId !== excludeSessionId
    );

    if (activeSessions.length < MAX_ACTIVE_SESSIONS) return;

    // A session mid-turn must never be an eviction candidate. Eviction runs
    // `deactivateSession` → `conn.closeSession`, which cancels the in-flight
    // prompt (see cancelTurn's contract above) — the user's generation dies
    // with no event that explains why. And a generating session is the PRIME
    // LRU candidate precisely because it is working: `lastUsed` is stamped
    // once at prompt time (sendMessage), so a long turn only ages while it
    // runs. `currentAgentMessage` is the in-flight signal — set when the
    // prompt goes out and cleared on every terminal path.
    const idleSessions = activeSessions.filter((s) => !s.currentAgentMessage);

    // Sort by lastUsed ascending — oldest first
    idleSessions.sort((a, b) => a.lastUsed - b.lastUsed);

    const toEvict = idleSessions[0];
    if (!toEvict) {
      // Everyone is mid-turn. Exceed the cap rather than cancel someone's
      // work: the cap is a resource heuristic, not a correctness constraint,
      // and the overflow is self-limiting — turns finish, and the next
      // activation trims back to it. Blocking the activation instead would
      // deadlock the user out of their own sidebar. Logged so a genuine
      // runaway is visible rather than silent.
      logger.warn(
        {
          tag: "session-manager",
          op: "lru_evict_skipped",
          activeCount: activeSessions.length,
          max: MAX_ACTIVE_SESSIONS,
        },
        "All active sessions are mid-turn — exceeding the active-session cap instead of cancelling a generation",
      );
      return;
    }

    logger.info(
      {
        tag: "session-manager",
        op: "lru_evict",
        sessionId: toEvict.sessionId,
        lastUsed: new Date(toEvict.lastUsed).toISOString(),
      },
      `LRU evicting session ${toEvict.sessionId}`,
    );
    await this.deactivateSession(toEvict.sessionId);
  }

  // -------------------------------------------------------------------------
  // 11. Event routing
  // -------------------------------------------------------------------------

  /**
   * Emit an event to all listeners for a specific session.
   * Also emits to global listeners and pending listeners.
   */
  emitForSession(sessionId: string, event: AgentEvent): void {
    // Per-session listeners
    const entry = this.sessions.get(sessionId);
    if (entry) {
      for (const cb of entry.listeners) cb(event);
    }

    // Pending listeners (registered before session exists)
    const pendingSet = this.pendingListeners.get(sessionId);
    if (pendingSet) {
      for (const cb of pendingSet) cb(event);
    }

    // Global listeners (SSE)
    for (const cb of this.globalListeners) {
      cb(sessionId, event);
    }
  }

  /**
   * Drain pending listeners into a session's listener set.
   */
  private drainPendingListeners(sessionId: string): void {
    const pending = this.pendingListeners.get(sessionId);
    if (pending) {
      const entry = this.sessions.get(sessionId);
      if (entry) {
        for (const cb of pending) entry.listeners.add(cb);
      }
      this.pendingListeners.delete(sessionId);
    }
  }

  // -------------------------------------------------------------------------
  // 12. Event subscriptions
  // -------------------------------------------------------------------------

  /** Subscribe to events for a specific session. */
  onEvent(sessionId: string, callback: (event: AgentEvent) => void): void {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.listeners.add(callback);
      return;
    }

    // Session doesn't exist yet — store as pending
    let pending = this.pendingListeners.get(sessionId);
    if (!pending) {
      pending = new Set();
      this.pendingListeners.set(sessionId, pending);
    }
    pending.add(callback);
  }

  /** Unsubscribe from events for a specific session. */
  offEvent(sessionId: string, callback: (event: AgentEvent) => void): void {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.listeners.delete(callback);
    }

    const pendingSet = this.pendingListeners.get(sessionId);
    if (pendingSet) {
      pendingSet.delete(callback);
      if (pendingSet.size === 0) this.pendingListeners.delete(sessionId);
    }
  }

  /** Subscribe to events for ALL sessions. */
  onGlobalEvent(callback: GlobalSessionEventListener): void {
    this.globalListeners.add(callback);
  }

  /** Unsubscribe from global events. */
  offGlobalEvent(callback: GlobalSessionEventListener): void {
    this.globalListeners.delete(callback);
  }

  /** Subscribe to system-level (sessionless) events — e.g. standby-ready. */
  onSystemEvent(callback: (event: SystemEvent) => void): void {
    // `agent-readiness` rides this same channel — it is a SystemEvent variant
    // (lib/sessions/types.ts), so no widening or cast is needed here.
    this.systemListeners.add(callback);
  }

  /** Unsubscribe from system-level events. */
  offSystemEvent(callback: (event: SystemEvent) => void): void {
    this.systemListeners.delete(callback);
  }

  private emitSystemEvent(event: SystemEvent): void {
    for (const cb of this.systemListeners) {
      try {
        cb(event);
      } catch {
        /* listener errors shouldn't block the rest */
      }
    }
  }

  /** True when a pre-warmed standby session is ready to be claimed by the
   *  next createSession() call. Used by the UI to gate the "New chat" button
   *  so every click feels equally fast. */
  isStandbyReady(): boolean {
    return this.standbySession !== null && !this.standbyCreating;
  }

  // -------------------------------------------------------------------------
  // 12b. Agent readiness
  // -------------------------------------------------------------------------

  /**
   * What we KNOW about an agent's usability right now. Defaults to
   * `{state:"unknown"}` — which asserts nothing, and must never be rendered as
   * "healthy". `null`/omitted agentId asks about the active agent.
   */
  getReadiness(agentId: string | null = this._activeAgentId): AgentReadiness {
    if (!agentId) return { state: "unknown" };
    return this.readiness.get(agentId) ?? { state: "unknown" };
  }

  /** Record a transition and broadcast it. No-ops when nothing changed. */
  private setReadiness(agentId: string, next: AgentReadiness): void {
    const prev = this.readiness.get(agentId);
    if (prev && sameReadiness(prev, next)) return;
    this.readiness.set(agentId, next);
    logger.info(
      {
        tag: "session-manager",
        op: "agent_readiness",
        agentId,
        state: next.state,
        from: prev?.state ?? "unknown",
      },
      `Agent ${agentId} readiness: ${next.state}`,
    );
    this.emitSystemEvent({ type: "agent-readiness", agentId, readiness: next });
  }

  /**
   * A `session/new` (or a prompt) came back clean — that IS the proof of
   * readiness, and the only proof we accept.
   */
  private markAgentReady(agentId: string): void {
    this.setReadiness(agentId, { state: "ready" });
  }

  /**
   * An ACP call rejected. ONLY an observed auth rejection changes readiness —
   * every other failure (transport hiccup, crashed subprocess, cancelled turn)
   * leaves the previous state alone rather than inventing a diagnosis.
   *
   * The message comes from `promptErrorNote`, which already owns the wording
   * for this exact failure. Wiring it in here is what finally makes its
   * non-Claude branch reachable: codex fails at `session/new`, one step before
   * the prompt path that was its only call site.
   */
  private markAgentAuthFailure(
    agentId: string,
    err: unknown,
    context: AuthNoteContext = "session-start",
  ): void {
    if (!isAuthRequiredError(err)) return;
    // `session-start` is the default because that is where codex fails and
    // where this was previously silent. Live QA caught the cost of getting it
    // wrong: the note read "it couldn't run that message" on a failure that
    // happens BEFORE any message exists.
    const message =
      promptErrorNote(err, agentId, context) ??
      `${agentId} needs to be signed in before it can start a chat.`;
    this.setReadiness(agentId, {
      state: "needs-auth",
      agentId,
      message,
      remedy: signInRemedyFor(agentId),
    });
  }

  // -------------------------------------------------------------------------
  // 13. Query helpers
  // -------------------------------------------------------------------------

  /** Get a session entry by ID. */
  getSession(sessionId: string): SessionEntry | undefined {
    return this.sessions.get(sessionId);
  }

  /** Get all sessions (both active and inactive), sorted by updatedAt descending. */
  getAllSessions(): SessionEntry[] {
    return [...this.sessions.values()].sort((a, b) => {
      const dateA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const dateB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      return dateB - dateA;
    });
  }

  /** Get only active sessions. */
  getActiveSessions(): SessionEntry[] {
    return [...this.sessions.values()].filter((s) => s.active);
  }

  /** Get the IDs of all active sessions. */
  getActiveSessionIds(): string[] {
    return [...this.sessions.values()]
      .filter((s) => s.active)
      .map((s) => s.sessionId);
  }

  /** Check if a session is active. */
  hasActiveSession(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.active ?? false;
  }

  /** Get the message cache for a session. */
  getMessageCache(sessionId: string): AgentMessage[] {
    return this.sessions.get(sessionId)?.messageCache ?? [];
  }

  /** Clear the message cache for a session. */
  clearMessageCache(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.messageCache = [];
      entry.currentAgentMessage = null;
      entry.currentUserMessage = null;
    }
  }

  // -------------------------------------------------------------------------
  // 14. Agent switching
  // -------------------------------------------------------------------------

  /**
   * Switch to a different agent. Closes all active sessions, clears the map,
   * warms the new process, and loads its sessions.
   *
   * Returns the readiness known for `agentId` once the switch settles, so the
   * caller can answer "did that work?" instead of assuming it did.
   *
   * `awaitStandbyMs` buys a bounded wait on the standby session before
   * returning. It matters because for codex the standby is the FIRST (and,
   * given `canListSessions:false`, only) `session/new` of the switch — i.e. the
   * one call that can report `needs-auth`. The wait is bounded rather than
   * unconditional so a slow-but-healthy agent can't hang the caller; a late
   * transition still reaches the UI as an `agent-readiness` SSE event.
   */
  async switchAgent(
    agentId: string,
    opts: { awaitStandbyMs?: number } = {},
  ): Promise<AgentReadiness> {
    if (!this.pm) throw new Error("No process manager set");

    // Close all active sessions
    const deactivations = this.getActiveSessions().map((s) =>
      this.deactivateSession(s.sessionId)
    );
    await Promise.allSettled(deactivations);

    // Clear all session entries
    this.sessions.clear();
    this.pendingListeners.clear();

    // Clear standby
    if (this.standbySession) {
      const conn = this.pm.getConnection(this.standbySession.agentId);
      if (conn) {
        conn
          .closeSession({ sessionId: this.standbySession.sessionId })
          .catch(() => {});
      }
      this.standbySession = null;
    }

    // Warm FIRST, then adopt. `_activeAgentId` used to be set here, BEFORE the
    // warm — which is what let the sidebar's status dot go green for an agent
    // whose subprocess never came up. It is now set only once we have a
    // process, so the dot can never claim more than we know.
    await this.pm.warmProcess(agentId);
    this._activeAgentId = agentId;

    // Load sessions from the new agent
    await this.loadInitialSessions(agentId);

    // Create standby session for the new agent. `createStandbySession` records
    // readiness and never rejects, so the fire-and-forget branch drops nothing
    // a caller could have acted on.
    const standby = this.createStandbySession();
    const budget = opts.awaitStandbyMs ?? 0;
    if (budget > 0) {
      await Promise.race([standby, delay(budget)]);
    } else {
      standby.catch(() => {});
    }

    return this.getReadiness(agentId);
  }

  // -------------------------------------------------------------------------
  // 15. Process crash handling
  // -------------------------------------------------------------------------

  /**
   * Handle a process crash for an agent. Emits error events to all affected
   * sessions and marks them as inactive.
   */
  handleProcessCrash(agentId: string, errorMessage: string): void {
    for (const [sessionId, entry] of this.sessions) {
      if (entry.agentId === agentId && entry.active) {
        // Drain pending permission requests — the agent is gone, the
        // promises must resolve so callers don't hang forever.
        this.resolveAllPendingAsCancelled(entry);

        this.emitForSession(sessionId, {
          type: "agent-status",
          status: "error",
          error: errorMessage,
        });

        entry.active = false;
        entry.messageCache = [];
        entry.currentAgentMessage = null;
        entry.currentUserMessage = null;
        entry.listeners = new Set();
      }
    }

    // Clear standby if it belonged to the crashed process
    if (this.standbySession?.agentId === agentId) {
      this.standbySession = null;
    }
  }

  // -------------------------------------------------------------------------
  // 16. Shutdown
  // -------------------------------------------------------------------------

  /** Gracefully shut down all sessions. */
  async shutdown(): Promise<void> {
    const deactivations = this.getActiveSessions().map((s) =>
      this.deactivateSession(s.sessionId)
    );
    await Promise.allSettled(deactivations);

    // Clear standby
    if (this.standbySession && this.pm) {
      const conn = this.pm.getConnection(this.standbySession.agentId);
      if (conn) {
        try {
          await conn.closeSession({
            sessionId: this.standbySession.sessionId,
          });
        } catch {
          /* best effort */
        }
      }
      this.standbySession = null;
    }

    this.sessions.clear();
    this.pendingListeners.clear();
    this.globalListeners.clear();
    this._activeAgentId = null;
  }

  /**
   * Reset all in-memory session state. Called when the agent workspace files
   * change (custom instructions update) — every session must be re-created so
   * the agent picks up the new CLAUDE.md.
   *
   * Emits an `instructions_updated` system event so the UI can banner the user.
   */
  resetAll(sessionsTerminated: number): void {
    // Drain pending permission requests for every session before clearing —
    // every session is about to be re-created and any held promises would
    // dangle otherwise.
    for (const entry of this.sessions.values()) {
      this.resolveAllPendingAsCancelled(entry);
    }
    this.sessions.clear();
    this.pendingListeners.clear();
    this.activatingSessions.clear();
    this.standbySession = null;
    this.standbyCreating = false;
    for (const fn of this.systemListeners) {
      try {
        fn({ type: "instructions_updated", sessionsTerminated });
      } catch {
        // listener errors don't bubble
      }
    }
  }

  // -------------------------------------------------------------------------
  // 17. getEventHandler()
  // -------------------------------------------------------------------------

  getEventHandler(): SessionEventHandler {
    if (!this.eventHandler) {
      this.eventHandler = new SessionEventHandler(
        this.msgCounterRef,
        (sessionId: string, event: AgentEvent) =>
          this.emitForSession(sessionId, event),
        (sessionId: string) => this.getSession(sessionId),
        (sessionId, commands) => {
          if (this.standbySession?.sessionId === sessionId) {
            this.standbySession.availableCommands = commands;
          }
        },
        (sessionId, configOptions) => {
          if (this.standbySession?.sessionId === sessionId) {
            this.standbySession.configOptions = configOptions;
          }
        },
      );
      this.eventHandler.attachJobProgressBridge(
        (toolCallId) => this.findSessionByToolCallId(toolCallId),
        (toolIds, toolArgs) => this.findInProgressToolCall(toolIds, toolArgs),
      );
    }
    return this.eventHandler;
  }

  /** Walk every active session's message cache looking for a tool-call or
   *  subagent part with the given `toolCallId`. Used by the job-progress
   *  bridge to route synthetic `agent-tool-progress` events back to the
   *  session that owns the call. Linear in the number of cached parts,
   *  bounded by MAX_ACTIVE_SESSIONS × cache depth. */
  private findSessionByToolCallId(toolCallId: string): SessionEntry | undefined {
    for (const entry of this.sessions.values()) {
      for (let i = entry.messageCache.length - 1; i >= 0; i--) {
        const msg = entry.messageCache[i];
        if (msg.role !== "agent") continue;
        const hit = msg.parts.some(
          (p) =>
            (p.type === "tool-call" || p.type === "subagent") &&
            p.toolCallId === toolCallId,
        );
        if (hit) return entry;
      }
    }
    return undefined;
  }

  /** Collect every unresolved tool-call part across active sessions and
   *  run the pure matcher (tool identity + args subset, oldest-first).
   *  Used by the job-progress bridge when a payload arrives without an
   *  attached toolCallId. */
  private findInProgressToolCall(
    toolIds: McpToolId[],
    toolArgs: unknown | undefined,
  ): { session: SessionEntry; toolCallId: string } | undefined {
    const sorted = Array.from(this.sessions.values()).sort(
      (a, b) => b.lastUsed - a.lastUsed,
    );
    for (const entry of sorted) {
      const candidates: ToolCallCandidate[] = [];
      let order = 0;
      for (const msg of entry.messageCache) {
        if (msg.role !== "agent") continue;
        for (const p of msg.parts) {
          if (p.type !== "tool-call") continue;
          const completed = msg.parts.some(
            (q) => q.type === "tool-result" && q.toolCallId === p.toolCallId,
          );
          if (completed) continue;
          candidates.push({
            toolCallId: p.toolCallId,
            toolId: p.toolId,
            args: p.args,
            order: order++,
          });
        }
      }
      const hit = matchToolCall(candidates, { toolIds, toolArgs });
      if (hit) return { session: entry, toolCallId: hit };
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Singleton (survives Next.js HMR via globalThis)
//
// Bump the key when making non-backwards-compatible changes to the class shape
// so the dev server's HMR replaces the singleton on the next reload rather
// than keeping an old instance with stale behaviour.
// ---------------------------------------------------------------------------

const SM_GLOBAL_KEY = "__sessionManager_v2";

const globalForSM = globalThis as unknown as {
  [SM_GLOBAL_KEY]?: SessionManager;
};

export function getSessionManager(): SessionManager {
  let sm = globalForSM[SM_GLOBAL_KEY];
  if (!sm) {
    sm = new SessionManager();
    globalForSM[SM_GLOBAL_KEY] = sm;

    // Register callback so mcp-config can refresh sessions without importing
    // us directly. We only refresh the standby — never disturb sessions
    // the user is mid-conversation with.
    onMcpConfigInvalidated(({ reason }) => {
      const inst = globalForSM[SM_GLOBAL_KEY];
      if (!inst) return;
      void reason;
      inst.invalidateStandbySession();
    });

    // Wire AgentProcessManager <-> SessionManager via injection to avoid circular imports.
    // AgentProcessManager never imports session-manager; it only calls through these hooks.
    const pm = getProcessManager();
    const smRef = sm;

    // Inject SessionManager callbacks into ProcessManager.
    pm.setSessionManagerHooks({
      shutdown: () => smRef.shutdown(),
      createClient: (managed) => smRef.getEventHandler().createClient(managed),
      onProcessCrash: (agentId, errorMessage) =>
        smRef.handleProcessCrash(agentId, errorMessage),
    });

    // Inject ProcessManager interface into SessionManager.
    smRef.setProcessManager({
      getConnection: (agentId) => pm.getConnection(agentId),
      warmProcess: (agentId) => pm.warmProcess(agentId),
      getCapabilitiesForAgent: (agentId) => pm.getCapabilitiesForAgent(agentId),
      registerSessionId: (agentId, sessionId) =>
        pm.registerSessionId(agentId, sessionId),
      unregisterSessionId: (agentId, sessionId) =>
        pm.unregisterSessionId(agentId, sessionId),
    });
  }
  return sm;
}
