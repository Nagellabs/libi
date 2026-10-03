import type {
  ClientSideConnection,
  SessionConfigOption,
  SessionInfo,
} from "@agentclientprotocol/sdk";
import type { AgentEvent } from "@/lib/agents/types";
import type { AgentMessage } from "@/lib/agents/message-types";
import type { AgentReadiness } from "@/lib/agents/agent-readiness";
import { ACP_AUTH_REQUIRED_CODE, isAuthRequiredError } from "@/lib/agents/agent-readiness";
import { clearSignInConfirmation } from "@/lib/agents/sign-in-confirmation";
import { getAgentSetup, isSetupAgentId } from "@/lib/agents/setup/registry";
import { isAgentSpawnRefused } from "@/lib/agents/spawn-refused-error";
import { isShellEnvLoaded, readShellEnvState } from "@/lib/runtime/shell-env-state";
import { captureStandbyFreshness, staleStandbyReason, type StandbyFreshness } from "@/lib/sessions/standby-freshness";
import { onSetupTerminalsSettled, setupActivity } from "@/lib/terminal/setup-activity";
import type {
  ApprovalNotAppliedReason,
  ApprovalPushContext,
  SessionEntry,
  GlobalSessionEventListener,
  SystemEvent,
} from "./types";
import { SessionEventHandler } from "@/lib/agents/session-event-handler";
import { isSessionMidTurn, markPermissionResolvedInCache, MAX_ACTIVE_SESSIONS } from "./types";
import { getLibiAgentDir } from "@/lib/libi-home";
import {
  getMcpServersForAcp,
  getMcpServersForAcpFallback,
  onMcpConfigInvalidated,
  TEST_MODE_STDIO_FAKE_NAMES,
  testModeFakesEnabled,
} from "@/lib/mcp-config";
import { agentConfigLoadErrorDetail, isLibiMcpEntryConfigError, LIBI_MCP_ENTRY_NAME, mcpEntryConfigErrorName } from "@/lib/mcp/agent-surface";
import { existsSync } from "node:fs";
import { join as joinPath } from "node:path";
import { isTestMode } from "@/lib/test-mode";
import { readLibiCodexEntryShape } from "@/lib/agents/libi-registration";
import { resolveCodexHome } from "@/lib/codex-config/canonical";
import { serverLogger as logger } from "@/lib/logger";
import { getProcessManager } from "@/lib/agents/process-manager";
import { ACP_INIT_TIMEOUT_MS } from "@/lib/agents/managed-types";
import { applyAttachmentParsing } from "@/lib/agents/parse-attachments";
import { getApprovalMode } from "@/lib/approval/settings";
import { acpModeFor, stableAcpModeCandidates } from "@/lib/sessions/approval-mode-map";
import { APPROVAL_MODE_LABELS, type ApprovalMode } from "@/lib/approval/mode";
import { makeMcpToolId, type McpToolId } from "@/lib/agents/mcp-tool-id";
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
import { agentChildPath, pathDelimiter, refreshFreshPathDirs } from "@/lib/agents/agent-path";
import { lookupLauncher } from "@/lib/providers/launcher";

import {
  promptErrorNote,
  type AuthNoteContext,
} from "@/lib/sessions/prompt-error-note";
import { getAgentModelId, setAgentModelId } from "@/lib/sessions/model-preferences";
import { getSettings, updateSettings } from "@/lib/db/settings";
import { trackServerEvent } from "@/lib/analytics/server";
import { SessionRestartError, type SessionRestartResult } from "@/lib/sessions/restart-error";
import { AgentHistoryMissingError, isAgentHistoryMissingError } from "@/lib/sessions/history-missing";
import { fileSessionIndex, MISSING_WINDOW_MS, type SessionIndex, type SessionIndexEntry } from "@/lib/sessions/session-index";
export { SessionRestartError, type SessionRestartFailureCode, type SessionRestartResult } from "@/lib/sessions/restart-error";
import { toAgentEventId } from "@/lib/analytics/events";
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
 * A timeout that never keeps the process (or a vitest worker) alive on its own.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/** How often the session manager re-reads the shell→runtime environment seam while it says
 *  `pending` (`lib/runtime/shell-env-state.ts`). */
const SHELL_ENV_WATCH_INTERVAL_MS = 1_000;
/** How long the background start after a failed restart waits on a resume's history load before it
 *  creates the standby anyway. A load on a live adapter has no timeout of its own; this reuses the
 *  bound the adapter already gets to answer `initialize`. */
const REWARM_RESUME_WAIT_MS = ACP_INIT_TIMEOUT_MS;

/** How a promise ended within a bound — or that it had not, when the bound ran out. */
type Settled<T> = { kind: "ok"; value: T } | { kind: "error"; error: unknown } | { kind: "timed_out" };

/** Wait for `p` for at most `ms`. Never rejects; a `p` still pending at the bound keeps running,
 *  and its eventual rejection is absorbed here. */
function settleWithin<T>(p: Promise<T>, ms: number): Promise<Settled<T>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind: "timed_out" }), ms);
    timer.unref?.();
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve({ kind: "ok", value });
      },
      (error: unknown) => {
        clearTimeout(timer);
        resolve({ kind: "error", error });
      },
    );
  });
}

/** What became of a `session/close`: answered, rejected, not answered within a restart's bound, or
 *  never sent because the agent has no process. */
export type AcpCloseOutcome = "closed" | "failed" | "timed_out" | "no_connection";

/** How long a restart waits for the adapter to close the chat's session (and to take the cancel
 *  of a running turn). Both adapters answer in well under a second when healthy: 3 ms and 105 ms
 *  measured on 2026-09-25, a running prompt included. */
export const RESTART_CLOSE_TIMEOUT_MS = 10_000;
/** How long a restart waits for the chat to load again — its history replay included. Healthy
 *  loads measured 0.8–0.9 s (Claude) and 40 ms (Codex); twice the adapter's `initialize` bound
 *  leaves room for a long history on a slow machine. */
export const RESTART_LOAD_TIMEOUT_MS = 2 * ACP_INIT_TIMEOUT_MS;
/** After the process of an unresponsive adapter is replaced, how long to wait for the load that
 *  was stuck on it to let go (killing the process closes its connection, which rejects it). */
export const RESTART_STALE_SETTLE_MS = 5_000;
/** The whole restart, however it goes. Each wait inside is bounded, but on the worst path they add
 *  up to several minutes (a stuck activation, the close, a process restart, the stale load, the
 *  load again); past this the user is told, the row's wait ends, and the run is abandoned at its
 *  next step. 90 s covers a healthy restart many times over and one process replacement. */
export const RESTART_DEADLINE_MS = 90_000;

/** Thrown inside a restart run that its deadline already gave up on, to stop it at its next step. */
class RestartAbandoned extends Error {}

/** The part of an error worth showing the user: one line, bounded. An ACP error's `data` carries
 *  the adapter's diagnosis (its `message` is often just "Internal error"), so it wins. */
function plainReason(err: unknown): string {
  const { data, message } = (typeof err === "object" && err !== null ? err : {}) as { data?: unknown; message?: unknown };
  const text =
    typeof data === "string" && data.trim()
      ? data
      : typeof message === "string"
        ? message
        : typeof err === "string"
          ? err
          : "";
  const line = text.split("\n")[0]?.trim() ?? "";
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
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

/** What happens in each mode the user was promised, for the note of a chat that did not get it. */
const APPROVAL_MODE_PROMISE: Record<ApprovalMode, string> = {
  ask: "to be asked before each tool",
  auto: "for extensions marked “requires approval” to ask first",
  "auto-with-generations": "to use it",
};

/** The promise for `agentId`: libi's extension gate exists for Claude only, so a new Codex chat
 *  can't promise that "requires approval" extensions ask first (lib/approval/extensions.ts). */
function approvalModePromise(agentId: string, mode: ApprovalMode): string {
  if (mode === "auto" && agentId !== "claude-code") return "to use it";
  return APPROVAL_MODE_PROMISE[mode];
}

/**
 * Whether a chat whose saved mode was NOT applied has its prompts held until it is. "Ask each
 * time" and "Auto": the chat may be in the agent's own mode, which can run tools with no card.
 * "Auto, no extension prompts" is sent anyway — nothing the chat can be left in is more permissive.
 */
export function approvalModeHoldsPrompts(mode: ApprovalMode): boolean {
  return mode !== "auto-with-generations";
}

/** The chat note for a mode libi could not apply (`reportApprovalModeNotApplied`). It says which
 *  way out applies: send again (a retry re-attempts the push), or pick another mode / new chat. */
export function approvalModeNotAppliedNote(
  agentId: string,
  mode: ApprovalMode,
  context: ApprovalPushContext,
  reason: ApprovalNotAppliedReason,
): string {
  const label = APPROVAL_MODE_LABELS[mode];
  const chat = context === "resume" ? "this resumed chat" : "this chat";
  const promise = approvalModePromise(agentId, mode);
  if (!approvalModeHoldsPrompts(mode)) {
    return `libi couldn't apply '${label}' to ${chat} — start a new chat ${promise}.`;
  }
  if (reason === "unsupported_by_agent") {
    return `The agent doesn't offer '${label}' in ${chat}, so libi won't send messages here — pick another approval mode, or start a new chat ${promise}.`;
  }
  if (reason === "modes_unknown") {
    return `libi doesn't know which approval modes this agent offers, so it couldn't apply '${label}' to ${chat} and won't send messages here — start a new chat ${promise}.`;
  }
  if (reason === "set_timeout") {
    // While the push hangs, sending again only waits again, and a new chat on the same hung agent
    // hangs the same way: replacing the agent's process is what gets it answering.
    return `libi couldn't apply '${label}' to ${chat} in time — the agent isn't answering, so libi won't send messages here until it does. Use Restart session on this chat, then send again.`;
  }
  return `libi couldn't apply '${label}' to ${chat}, so it won't send messages here until it can — send again to retry, or start a new chat ${promise}.`;
}

/** Whether sending again can fix a held chat: a retry re-attempts the push. Not when the agent
 *  doesn't offer the mode, nor when its modes are unknown — only a new chat (whose `session/new`
 *  advertises them) changes that. */
function approvalModeRetryable(reason: ApprovalNotAppliedReason | undefined): boolean {
  return reason !== "unsupported_by_agent" && reason !== "modes_unknown";
}

/** Why a held prompt was not sent — caller-neutral; the send route adds how to retry. */
function approvalModeHeldError(mode: ApprovalMode, reason: ApprovalNotAppliedReason | undefined): string {
  const label = APPROVAL_MODE_LABELS[mode];
  if (reason === "unsupported_by_agent") {
    return `The agent doesn't offer '${label}' in this chat, so the message wasn't sent — pick another approval mode, or start a new chat.`;
  }
  if (reason === "modes_unknown") {
    return `libi doesn't know which approval modes this agent offers, so the message wasn't sent — start a new chat.`;
  }
  if (reason === "set_timeout") {
    return `libi couldn't apply '${label}' to this chat in time, so the message wasn't sent — if it keeps happening, use Restart session.`;
  }
  return `libi couldn't apply '${label}' to this chat, so the message wasn't sent.`;
}

/** Why `restartIdleAgentForLauncher` kept the process. */
export type LauncherRestartKept = "no_process" | "launcher_not_reached" | "standby_creating" | "active_sessions" | "opening_sessions";

/** The gate's answer (`SessionManager.awaitApprovalMode`). */
export type ApprovalGate =
  | { ok: true }
  | { ok: false; mode: ApprovalMode; error: string; retryable: boolean };

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
        /** Whether its agent process was spawned with the user's shell environment. */
        shellEnvLoaded: boolean;
        /** What its MCP servers were read from, just before it was created (`discardStaleStandby`). */
        freshness: StandbyFreshness;
        /** Its approval-mode push, while still unanswered past the bound. The claim adopts it
         *  (`adoptStandbyModePush`): landing after the claim's own push, it would leave the chat in
         *  the mode saved when the standby was made. */
        approvalModePush?: Promise<boolean>;
        /** Its model push, while still unanswered past the bound — adopted by the claim the same
         *  way (`adoptStandbyModelPush`), so the model chosen at claim is the one that stays. */
        modelPush?: Promise<void>;
      }
    | null = null;
  private standbyCreating = false;
  /** The agent whose last standby attempt failed — cleared when one is made. See `openNewSession`. */
  private standbyFailedFor: string | null = null;

  /**
   * agentId -> the ACP mode ids its adapter last advertised (`session/new`, standby or
   * `session/load`), for the life of this process. The last-but-one source of truth for
   * `pushApprovalModeToSession`: a chat rebuilt from `listSessions` after a restart has no modes
   * of its own until it is loaded, and the standby libi pre-creates at boot fills this before any
   * resume. Full-verification F5.
   */
  private advertisedModesByAgent = new Map<string, { id: string }[]>();

  /** Agents whose `session/load` response keys were logged once (debug) — what an adapter
   *  returns there decides whether a resume can learn its modes from the load itself. */
  private loadResponseShapeLogged = new Set<string>();

  /** The shell-environment seam watcher; null when not watching. */
  private shellEnvWatch: ReturnType<typeof setInterval> | null = null;

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

  /** How long a prompt waits for its chat's approval-mode push in flight (`settleApprovalModePush`). */
  private approvalModePushWaitMs = 10_000;

  /** sessionId -> the user's restart of it in progress; a second request shares it. */
  private restartingSessions = new Map<string, Promise<SessionRestartResult>>();

  /** sessionId -> its restart RUN until the run has really ended. Outlives the entry above when the
   *  deadline abandoned the run: an abandoned run stops only at its next step, and the next Restart
   *  of the chat waits for that (`restartSession`). */
  private restartRuns = new Map<string, Promise<unknown>>();

  /**
   * agentId -> how many chats are being opened on that agent's process right now (a
   * `createSession` or an `activateSession` in progress). Such a chat is not `active` yet, but
   * killing its process would still break it, so the shell-environment refresh counts it as running.
   */
  private openingSessions = new Map<string, number>();

  /** The currently active agent ID (set by switchAgent / startup) */
  private _activeAgentId: string | null = null;

  /** Bumped when a shell-environment restart begins and when an agent is picked. The one background
   *  start after a failed restart goes ahead only while this still holds the value that restart
   *  took, so it never acts on behalf of a restart or pick that has since superseded it. */
  private agentStartEpoch = 0;

  /** Per agent, the last reason a launcher restart was declined, so a hint polled every few seconds logs once per change. */
  private launcherRestartKeptLogged = new Map<string, string>();

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
    /** Absent (a test double) ⇒ loaded / no restart. */
    spawnedWithShellEnv?(agentId: string): boolean;
    restartProcess?(agentId: string): Promise<void>;
    /** The in-progress restart of `agentId`, settling (never rejecting) once it is over; null when none. */
    pendingRestart?(agentId: string): Promise<void> | null;
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
    /** Absent (a test double) ⇒ loaded / no restart. */
    spawnedWithShellEnv?(agentId: string): boolean;
    restartProcess?(agentId: string): Promise<void>;
    /** The in-progress restart of `agentId`, settling (never rejecting) once it is over; null when none. */
    pendingRestart?(agentId: string): Promise<void> | null;
  }): void {
    this.pm = pm;
  }

  /** libi's own index of the chats it has shown (`lib/sessions/session-index.ts`). Null — a test
   *  double, or before startup wires it — means no index: the list is the agent's listing alone. */
  private sessionIndex: SessionIndex | null = null;

  /** Inject the chat index. Called once during startup (`getSessionManager`). */
  setSessionIndex(index: SessionIndex | null): void {
    this.sessionIndex = index;
  }

  /** Run an index read or write. The index is a convenience over the agent's own listing: a file
   *  that can't be read or written is logged and never breaks a list, a load or a new chat. */
  private withSessionIndex<T>(op: string, fn: (index: SessionIndex) => T): T | undefined {
    if (!this.sessionIndex) return undefined;
    try {
      return fn(this.sessionIndex);
    } catch (err) {
      logger.warn(
        { tag: "session-manager", op: "session_index_failed", step: op, err },
        `The chat index could not be ${op === "list" ? "read" : "written"} — the list is the agent's own`,
      );
      return undefined;
    }
  }

  /** Record chats in the index. `hasTranscript`: the agent listed or loaded them — and then the chat
   *  is not missing (`missingSince` cleared). */
  private indexSessions(entries: SessionEntry[], hasTranscript: boolean): void {
    if (entries.length === 0) return;
    this.withSessionIndex("record", (index) =>
      index.record(
        entries.map((e) => ({
          sessionId: e.sessionId,
          agentId: e.agentId,
          title: e.title,
          updatedAt: e.updatedAt,
          hasTranscript,
          ...(hasTranscript ? { missingSince: null } : {}),
        })),
      ),
    );
  }

  /**
   * After a SUCCESSFUL, NON-EMPTY listing of `agentId`'s chats: every listed chat is recorded (it
   * has a transcript), and every indexed chat of that agent the listing no longer has is kept in the
   * list as an UNLISTED entry (`historyUnlisted`), instead of silently disappearing
   * (full-verification F10). Unlisted is not "history missing": Codex's listing filters by model
   * provider and leaves archived threads out, so opening the row still tries the load, and only the
   * agent's own rejection sets `historyMissing` (review I1). An unlisted chat stays for
   * `MISSING_WINDOW_MS` from when it first went unlisted, then its entry is dropped, so transcripts
   * the agent cleans up don't pile up (review I2). An indexed chat that never had a transcript
   * (created, never used) is pruned. A failed listing never comes here, and an empty one proves
   * nothing — it is not read as "every chat is gone".
   */
  private mergeSessionIndex(agentId: string, listed: SessionInfo[]): void {
    const listedEntries = listed.flatMap((s) => {
      const e = this.sessions.get(s.sessionId);
      return e ? [e] : [];
    });
    this.indexSessions(listedEntries, true);
    if (listed.length === 0) return;

    const indexed = this.withSessionIndex("list", (index) => index.list()) ?? [];
    const listedIds = new Set(listed.map((s) => s.sessionId));
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const unlisted: SessionIndexEntry[] = [];
    const firstMissed: SessionIndexEntry[] = [];
    const drop: string[] = [];
    for (const e of indexed) {
      if (e.agentId !== agentId || listedIds.has(e.sessionId) || this.sessions.has(e.sessionId)) continue;
      if (!e.hasTranscript) {
        drop.push(e.sessionId);
        continue;
      }
      const since = e.missingSince ? Date.parse(e.missingSince) : now;
      if (Number.isFinite(since) && now - since > MISSING_WINDOW_MS) {
        drop.push(e.sessionId);
        continue;
      }
      unlisted.push(e);
      if (!e.missingSince) firstMissed.push(e);
    }
    if (drop.length > 0) this.withSessionIndex("remove", (index) => index.remove(drop));
    if (firstMissed.length > 0) {
      this.withSessionIndex("record", (index) =>
        index.record(firstMissed.map((e) => ({ ...e, missingSince: nowIso }))),
      );
    }
    for (const e of unlisted) {
      this.sessions.set(e.sessionId, {
        sessionId: e.sessionId,
        agentId,
        title: e.title,
        updatedAt: e.updatedAt,
        active: false,
        lastUsed: e.updatedAt ? new Date(e.updatedAt).getTime() : 0,
        messageCache: [],
        currentAgentMessage: null,
        currentUserMessage: null,
        promptsInFlight: 0,
        listeners: new Set(),
        pendingApprovals: new Map(),
        configOptions: [],
        latestUsage: null,
        availableCommands: [],
        historyUnlisted: true,
      });
    }
    if (unlisted.length > 0 || drop.length > 0) {
      logger.info(
        { tag: "session-manager", op: "session_index_unlisted", agentId, count: unlisted.length, dropped: drop.length },
        `${unlisted.length} chat(s) libi showed before are no longer listed by ${agentId} — kept until opening one says whether its history is there; ${drop.length} old or never-used entr(ies) dropped`,
      );
    }
  }

  /**
   * "Remove from list" on a chat whose history is gone, or that the agent no longer lists: its index
   * entry is deleted and it leaves the list. Refused for any other chat (the agent lists it again on
   * the next start, so removing it would only be undone) and for an active one. A chat libi does not
   * hold in memory is `not_found`: without its entry there is nothing to vouch that its history is
   * gone, so its index entry is left alone (review M8a).
   */
  forgetSession(sessionId: string): "forgotten" | "refused" | "not_found" {
    const entry = this.sessions.get(sessionId);
    if (!entry) return "not_found";
    if (entry.active || (entry.historyMissing !== true && entry.historyUnlisted !== true)) return "refused";
    this.withSessionIndex("remove", (index) => index.remove([sessionId]));
    this.sessions.delete(sessionId);
    logger.info(
      { tag: "session-manager", op: "session_forgotten", agentId: entry.agentId, sessionId },
      `Removed chat ${sessionId} from the list (${entry.historyMissing ? "its history is gone" : "the agent no longer lists it"})`,
    );
    return "forgotten";
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
    let listedAll = false;

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
      listedAll = true;
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
        promptsInFlight: 0,
        listeners: new Set(),
        pendingApprovals: new Map(),
        configOptions: [],
        latestUsage: null,
        availableCommands: [],
      };

      this.sessions.set(info.sessionId, entry);
    }

    if (listedAll) this.mergeSessionIndex(agentId, allSessions);

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
        // Listed again: not an unlisted row any more (the index write below clears `missingSince`).
        if (existing.historyUnlisted) existing.historyUnlisted = false;
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
          promptsInFlight: 0,
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

    // A title the agent gave a chat since (its rename) goes into libi's index too.
    this.indexSessions(
      allSessions.flatMap((s) => {
        const e = this.sessions.get(s.sessionId);
        return e ? [e] : [];
      }),
      true,
    );
  }

  // -------------------------------------------------------------------------
  // 5. createSession()
  // -------------------------------------------------------------------------

  /** Whether a session running on `agentId`'s process right now has the user's shell environment. */
  private shellEnvLoadedFor(agentId: string): boolean {
    return this.pm?.spawnedWithShellEnv?.(agentId) ?? true;
  }

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
    shellEnvLoaded: boolean = this.shellEnvLoadedFor(agentId),
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
      promptsInFlight: 0,
      listeners: new Set(),
      pendingApprovals: new Map(),
      configOptions,
      latestUsage: null,
      availableCommands,
      shellEnvLoaded,
    };
    this.sessions.set(sessionId, entry);
    // Indexed from the start; it counts as a chat with history once the agent lists or loads it.
    this.indexSessions([entry], false);
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
   * `conn.newSession(...)`, with a ONE-SHOT recovery for the single failure
   * that libi's own entry name can cause.
   *
   * libi names its ACP MCP entry `libi` on purpose, so that on a machine which
   * has run `libi connect` the entry REPLACES the config one instead of
   * mounting libi twice (`lib/mcp/agent-surface.ts#LIBI_MCP_ENTRY_NAME`). On
   * Codex the replacement is a field-by-field merge, so a user whose
   * `[mcp_servers.libi]` is a hand-written STDIO entry ends up with a table
   * holding both `command` and `url`, and codex refuses the entire config —
   * the in-app chat cannot start at all. That shape is reachable in the wild
   * without anyone hand-editing anything: older libi versions wrote stdio
   * entries, so a machine that ran `libi connect` once long ago and never
   * re-ran it has exactly it.
   *
   * A dead session is worse than a duplicated tool surface, so this retries
   * once under `LIBI_MCP_FALLBACK_ENTRY_NAME`, which no longer collides. The
   * chat then carries libi twice — knowingly, for that session only.
   *
   * THREE THINGS THIS DELIBERATELY DOES NOT DO:
   *
   *  - It does not pre-detect. `isLibiMcpEntryConfigError` reads the rejection
   *    codex actually returned; nothing here parses the user's `config.toml`,
   *    which is the heuristic `LIBI_MCP_ENTRY_NAME` argues against.
   *  - It does not widen. Only that error retries. An auth rejection, a missing
   *    binary, a crashed adapter and the user's own unrelated config mistakes
   *    all propagate as themselves — see the measured non-matches on
   *    `isLibiMcpEntryConfigError`.
   *  - It does not loop. The retry calls `conn.newSession` directly, so there
   *    is exactly one extra attempt no matter what it does; and if the retry
   *    fails too, the ORIGINAL error is what propagates, because it is the one
   *    naming `mcp_servers.libi` — the thing the user has to fix.
   */
  private async newAcpSession(
    conn: ClientSideConnection,
    agentId: string,
    reason: "fresh" | "standby" | "load",
  ): Promise<Awaited<ReturnType<ClientSideConnection["newSession"]>>> {
    // Windows: the registry's PATH, read now (bounded), so a Claude chat gets a launcher installed since the adapter
    // started (`lib/agents/agent-path.ts`). Elsewhere a no-op.
    const pathRefresh = refreshFreshPathDirs();
    if (pathRefresh) await pathRefresh;
    const params = { cwd: this.getAgentDir(), _meta: sessionMetaFor(agentId) };
    try {
      return await conn.newSession({ ...params, mcpServers: getMcpServersForAcp(agentId) });
    } catch (err) {
      if (!isLibiMcpEntryConfigError(err)) throw this.testModeEntryCollision(agentId, reason, err) ?? this.agentConfigError(agentId, reason, err) ?? err;
      const mcpServers = getMcpServersForAcpFallback(agentId);
      logger.warn(
        {
          tag: "session-manager",
          op: "mcp_entry_collision_retry",
          agentId,
          reason,
          fallbackNames: mcpServers.map((m) => m.name),
          err,
        },
        `${agentId} rejected the session config because libi's MCP entry collided with an incompatible [mcp_servers.libi] in the user's own config — retrying once under a non-colliding name. libi's tools will appear twice in this session.`,
      );
      try {
        return await conn.newSession({ ...params, mcpServers });
      } catch (retryErr) {
        logger.error(
          {
            tag: "session-manager",
            op: "mcp_entry_collision_retry_failed",
            agentId,
            reason,
            err: retryErr,
          },
          `Retry under a non-colliding MCP entry name also failed for ${agentId} — surfacing the original config error`,
        );
        throw this.agentConfigError(agentId, reason, err) ?? err;
      }
    }
  }

  /**
   * The agent refused its OWN configuration — codex's "failed to load configuration", which
   * codex-acp hands back as a bare `-32603 Internal error` with the diagnosis in `data`. Reached
   * when libi's one-shot entry rename could not help (the retry failed too), or for a config
   * error that never named libi's entry. Every session/new and session/load then fails the same
   * way, so it is recorded as readiness (`config-error`: the sidebar and the chat say it, and New
   * chat retries instead of waiting on a standby that will never come) and thrown in words the
   * user can act on. Null for anything else.
   *
   * The one shape named specifically is the one found in the wild (2026-09-29): libi's agent
   * folder still holding a PROJECT `.codex/config.toml` written by libi ≤ 0.1.13, whose stdio
   * `[mcp_servers.libi]` codex merges with the url entry `libi connect` / `codex mcp add` puts in
   * the user's own config. Only the file's EXISTENCE is checked — nothing here parses the user's
   * TOML — and libi does not touch it: removing a section from an agent's config is the user's.
   */
  private agentConfigError(agentId: string, reason: "fresh" | "standby" | "load", err: unknown): Error | null {
    const detail = agentConfigLoadErrorDetail(err);
    if (!detail) return null;
    const setup = getAgentSetup(agentId);
    const name = setup?.name ?? agentId;
    const files = setup?.configFiles;
    const projectConfig = files ? joinPath(this.getAgentDir(), files.project) : null;
    const legacyProjectConfig = !!projectConfig && isLibiMcpEntryConfigError(err) && existsSync(projectConfig);
    const message =
      `${name} couldn't load its configuration, so it can't start or open a chat. ${name} says: ${detail}.` +
      (legacyProjectConfig && files
        ? ` libi's agent folder still has a ${name} config written by an older libi version (${projectConfig}), and ${name} reads it on top of ${files.user}. Remove the [mcp_servers.${LIBI_MCP_ENTRY_NAME}] section from that older file (the entry in ${files.user} is the current one), then start a new chat.`
        : files
          ? ` Fix it in ${files.user} (or a project ${files.project}), then start a new chat.`
          : " Fix the agent's config, then start a new chat.");
    logger.error(
      { tag: "session-manager", op: "agent_config_error", agentId, reason, legacyProjectConfig, err },
      `${agentId} refused its own configuration — no session can start or load until it is fixed`,
    );
    this.setReadiness(agentId, { state: "config-error", agentId, message });
    return new Error(message, { cause: err });
  }

  /**
   * Test mode on Codex: libi hands Codex its stdio fakes under the names the real servers are added under
   * (`TEST_MODE_STDIO_FAKE_NAMES`), and codex MERGES a session entry into a config entry of the same name field by
   * field. A real HTTP entry the user added under one of those names themselves (`codex mcp add` in their own
   * terminal — the Providers tab refuses to) merges into a table with both `url` and `command`, and codex refuses
   * its whole config, so no chat starts. That rejection is named here — which entry, and what to do — instead of
   * codex's bare "Internal error": logged as `test_mode_entry_collision`, and the error the chat shows. Null for
   * anything else, and always outside test mode, where libi attaches no fakes. Nothing is retried: without the fake
   * the real, paid server would answer.
   */
  private testModeEntryCollision(agentId: string, reason: "fresh" | "standby" | "load", err: unknown): Error | null {
    if (agentId !== "codex" || !isTestMode() || !testModeFakesEnabled()) return null;
    const entry = mcpEntryConfigErrorName(err, TEST_MODE_STDIO_FAKE_NAMES);
    if (!entry) return null;
    logger.error(
      { tag: "session-manager", op: "test_mode_entry_collision", agentId, reason, entry, err },
      `Codex refused its config in test mode: the user's own "${entry}" MCP entry collides with libi's test-mode fake of that name`,
    );
    const outcome = reason === "load" ? "this chat can't be opened" : "this chat can't start";
    return new Error(
      `Test mode: Codex's config has its own "${entry}" MCP server, and libi gives Codex a fake under that same name, ` +
        `so Codex refused its whole config and ${outcome}. Remove that "${entry}" entry ` +
        "(Agents → Providers), or run libi outside test mode.",
      { cause: err },
    );
  }

  /**
   * `conn.loadSession(...)`, with the same ONE-SHOT recovery `newAcpSession` has: a Codex chat
   * created under `LIBI_MCP_FALLBACK_ENTRY_NAME` (the user's `[mcp_servers.libi]` is a stdio entry
   * that libi's `libi` entry cannot merge into) is refused under `libi` on every resume too — so
   * without this such a chat could never be opened again after an eviction, a crash or a restart.
   * Same boundaries: only that error retries, once, calling the connection directly; if the retry
   * fails too, the ORIGINAL error (the one naming `mcp_servers.libi`) propagates. History the
   * refused attempt may have replayed is dropped before the retry replays it again.
   */
  private async loadAcpSession(
    conn: ClientSideConnection,
    agentId: string,
    sessionId: string,
    mcpServers: AcpMcpEntry[],
  ): Promise<Awaited<ReturnType<ClientSideConnection["loadSession"]>>> {
    const params = { sessionId, cwd: this.getAgentDir(), _meta: sessionMetaFor(agentId) };
    try {
      return await conn.loadSession({ ...params, mcpServers });
    } catch (err) {
      if (!isLibiMcpEntryConfigError(err)) throw this.testModeEntryCollision(agentId, "load", err) ?? this.agentConfigError(agentId, "load", err) ?? err;
      const fallback = getMcpServersForAcpFallback(agentId);
      logger.warn(
        {
          tag: "session-manager",
          op: "mcp_entry_collision_retry",
          agentId,
          sessionId,
          reason: "load",
          fallbackNames: fallback.map((m) => m.name),
          err,
        },
        `${agentId} refused to load ${sessionId} because libi's MCP entry collided with an incompatible [mcp_servers.libi] in the user's own config — retrying once under a non-colliding name. libi's tools will appear twice in this session.`,
      );
      const entry = this.sessions.get(sessionId);
      if (entry) {
        entry.messageCache = [];
        entry.currentAgentMessage = null;
        entry.currentUserMessage = null;
      }
      try {
        return await conn.loadSession({ ...params, mcpServers: fallback });
      } catch (retryErr) {
        logger.error(
          { tag: "session-manager", op: "mcp_entry_collision_retry_failed", agentId, sessionId, reason: "load", err: retryErr },
          `Retry under a non-colliding MCP entry name also failed for ${agentId} — surfacing the original config error`,
        );
        throw this.agentConfigError(agentId, "load", err) ?? err;
      }
    }
  }

  /**
   * Put a CAUSE in the log for the silent half of the Codex edge.
   *
   * `enabled = false` on the user's `[mcp_servers.libi]` survives the merge, so
   * the in-app session starts perfectly and simply has no libi tools — nothing
   * throws, nothing is missing from libi's point of view, and the user
   * experiences it as the app quietly not working. There is no rejection to
   * react to, so the only honest move is to say so once, next to the
   * `new_session_done` line that would otherwise look like success.
   *
   * Best-effort and non-blocking on purpose: it asks codex's OWN reader, not a
   * TOML parse (see `libiCodexEntryShape`), through the listing libi's other
   * Codex readers share (`readLibiCodexEntryShape`). A memoised or recent last
   * good listing answers at no cost; otherwise it joins or starts that one run,
   * under its 15 s bound, rather than a 2 s spawn of its own that an
   * unauthenticated HTTP entry's OAuth discovery always outlasted. It is fired
   * and forgotten rather than added to session-creation latency, runs only on
   * the codex lane, and every failure is swallowed. Nothing branches on the
   * result.
   */
  private async logCodexEntryShape(agentId: string, sessionId: string): Promise<void> {
    if (agentId !== "codex") return;
    try {
      const shape = await readLibiCodexEntryShape();
      if (shape !== "disabled") return;
      logger.warn(
        {
          tag: "session-manager",
          op: "libi_mcp_entry_disabled",
          agentId,
          sessionId,
          codexHome: resolveCodexHome(),
        },
        "This Codex session has NO libi tools: the user's own [mcp_servers.libi] is disabled (enabled = false), and codex keeps that flag when it merges libi's session entry over it. Re-enable that entry (or delete it and re-run `libi connect`) to restore libi's tools.",
      );
    } catch {
      // A diagnostic that cannot answer says nothing. Never let it affect the
      // session it is describing.
    }
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
    const done = this.beginOpening(agentId);
    try {
      return await this.openNewSession(agentId);
    } finally {
      done();
    }
  }

  /** Count a chat being opened on `agentId`'s process; call the returned function once it settles. */
  private beginOpening(agentId: string): () => void {
    this.openingSessions.set(agentId, (this.openingSessions.get(agentId) ?? 0) + 1);
    let settled = false;
    return () => {
      if (settled) return;
      settled = true;
      const left = (this.openingSessions.get(agentId) ?? 1) - 1;
      if (left > 0) this.openingSessions.set(agentId, left);
      else this.openingSessions.delete(agentId);
    };
  }

  private async openNewSession(agentId: string): Promise<string> {
    if (!this.pm) throw new Error("No process manager set");
    // A new chat that lands while the process restarts waits for the new connection. Awaited only
    // when there is a restart: an unconditional await would let an in-flight standby land first and
    // change which path this chat takes.
    const restart = this.pm.pendingRestart?.(agentId);
    if (restart) await restart;

    // Try to claim standby — zero-latency new chat. If the standby was
    // spawned with a cold MCP cache (Category B prewarm still running),
    // Category B's post-prewarm `invalidateMcpConfig` will refresh both
    // the standby and any active sessions so subsequent interactions hit
    // a warm cache. The user therefore gets an instant "New chat" the
    // moment the UI opens, at the cost of one refresh per active session
    // when Category B finishes (see session 6823b191 investigation).
    this.discardStaleStandby(agentId);
    const standbyConfigOptions = this.standbySession?.configOptions ?? [];
    const standbyCommands = this.standbySession?.availableCommands ?? [];
    const standbyModes = this.standbySession?.availableModes;
    // A claimed chat keeps the standby's spawn-time answer.
    const standbyShellEnvLoaded = this.standbySession?.shellEnvLoaded ?? true;
    const standbyModePush = this.standbySession?.approvalModePush;
    const standbyModelPush = this.standbySession?.modelPush;
    const standbyId = this.claimStandbySession(agentId);
    if (standbyId) {
      const claimedEntry = this.registerActiveSession(
        standbyId,
        agentId,
        standbyConfigOptions,
        standbyCommands,
        standbyShellEnvLoaded,
      );
      // Carry the advertised mode vocabulary captured at standby creation onto
      // the claimed entry so this (and later) mode pushes gate on the real
      // advertised set instead of pushing an unadvertised id blind.
      claimedEntry.availableModes = standbyModes;
      // The standby was created earlier with whatever mode was saved at
      // standby-creation time. Re-push the current mode so it reflects any
      // changes the user made between standby creation and claim.
      if (standbyModePush) this.adoptStandbyModePush(claimedEntry, standbyModePush);
      await this.pushApprovalModeBounded(standbyId, agentId, standbyModes, "new");
      if (standbyModelPush) this.adoptStandbyModelPush(claimedEntry, standbyModelPush);
      await this.pushModelBounded(standbyId, agentId, standbyConfigOptions);
      return standbyId;
    }

    // Create fresh via ACP. No process at all (a restart that failed, say) is started again here
    // rather than failing the chat, and the standby comes back once the chat is open.
    let conn = this.pm.getConnection(agentId);
    let warmed = false;
    if (!conn) {
      try {
        await this.pm.warmProcess(agentId);
      } catch (err) {
        this.markAgentSpawnRefused(agentId, err);
        throw err;
      }
      conn = this.pm.getConnection(agentId);
      if (!conn) throw new Error(`No connection for agent ${agentId}`);
      warmed = true;
    }

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
      result = await this.newAcpSession(conn, agentId, "fresh");
      this.markAgentReady(agentId, "session-new");
    } catch (err) {
      this.markAgentAuthFailure(agentId, err);
      throw err;
    }
    void this.logCodexEntryShape(agentId, result.sessionId);
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
    this.rememberAdvertisedModes(agentId, result.modes?.availableModes);
    await this.pushApprovalModeBounded(
      result.sessionId,
      agentId,
      result.modes?.availableModes,
      "new",
    );
    await this.pushModelBounded(result.sessionId, agentId, result.configOptions ?? []);
    // The standby comes back when this chat warmed the process, or when the last standby for this
    // agent FAILED (a config the agent refused, since fixed): this session is the proof the agent
    // works again, and nothing else would make one — New chat stayed on "Preparing…" for good after
    // recovering (found 2026-09-29). A no-op while one exists or is being made.
    if (warmed || this.standbyFailedFor === agentId) this.createStandbySession().catch(() => {});
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

    const opened = this.beginOpening(entry.agentId);
    // The map holds the WHOLE activation, bookkeeping included, so a caller that waits on it (a
    // restart waiting out a stale load) sees it settle only once it has left the map — a new
    // activation started after that is its own, never a join of the finished one.
    const promise = this.runActivation(sessionId, entry, opened, () => promise);
    this.activatingSessions.set(sessionId, promise);
    return promise;
  }

  private async runActivation(
    sessionId: string,
    entry: SessionEntry,
    opened: () => void,
    self: () => Promise<AgentMessage[]>,
  ): Promise<AgentMessage[]> {
    try {
      return await this.performActivation(sessionId, entry);
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
      if (this.activatingSessions.get(sessionId) === self()) this.activatingSessions.delete(sessionId);
      opened();
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
    // The agent already said it has no transcript for this chat. Asking again would spawn another
    // resume that can only fail the same way — each chat open, and each send, would pay for it.
    if (entry.historyMissing) {
      this.emitForSession(sessionId, { type: "agent-status", status: "disconnected" });
      throw new AgentHistoryMissingError(sessionId);
    }
    if (!this.pm) throw new Error("No process manager set");

    // A resume that lands while the process restarts waits for the new connection; otherwise it
    // would fail on the missing one and the chat would render with no history.
    const restart = this.pm.pendingRestart?.(agentId);
    if (restart) await restart;
    // No process at all (a restart that failed, an adapter that crashed) is started again here, the
    // same as for a new chat, rather than failing the resume and rendering the chat empty. A spawn
    // refused for a missing or outdated CLI is recorded as readiness, then thrown.
    let conn = this.pm.getConnection(agentId);
    let warmed = false;
    if (!conn) {
      try {
        await this.pm.warmProcess(agentId);
      } catch (err) {
        this.markAgentSpawnRefused(agentId, err);
        throw err;
      }
      conn = this.pm.getConnection(agentId);
      if (!conn) throw new Error(`No connection for agent ${agentId}`);
      warmed = true;
    }

    await this.evictIfNeeded(sessionId);

    // Reset cache for the replay.
    entry.messageCache = [];
    entry.currentAgentMessage = null;
    entry.currentUserMessage = null;
    this.retirePrompts(entry);
    entry.lastUsed = Date.now();

    this.pm.registerSessionId(agentId, sessionId);
    // A resumed session runs on the process it is activated on.
    entry.shellEnvLoaded = this.shellEnvLoadedFor(agentId);
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
    // (bogus tool-call timers after session re-activation) — and builds it into the cache
    // WITHOUT broadcasting it: the replay is not a turn, and an open chat shown it over the SSE
    // was left with a streaming message nothing ends (`SessionEventHandler.handleSessionUpdate`).
    const replayEntry = this.sessions.get(sessionId);
    if (replayEntry) replayEntry.isReplaying = true;
    try {
      const loadResult = await this.loadAcpSession(conn, agentId, sessionId, mcpServers);
      const resumedEntry = this.sessions.get(sessionId);
      if (resumedEntry && loadResult?.configOptions) {
        resumedEntry.configOptions = loadResult.configOptions;
      }
      this.logLoadResponseShape(agentId, loadResult);
      // Both adapters answer `session/load` with the session's `modes` (claude-agent-acp
      // `getOrCreateSession`, codex-acp `loadSession`). An entry rebuilt from `listSessions` after
      // a restart has no other source for them — without this the resume push below was skipped
      // and the chat ran in the agent's own mode (full-verification F5).
      const loadedModes = loadResult?.modes?.availableModes;
      if (loadedModes) {
        if (resumedEntry) resumedEntry.availableModes = loadedModes;
        this.rememberAdvertisedModes(agentId, loadedModes);
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
      if (isAgentHistoryMissingError(err)) {
        // Not a failure to retry: the transcript is gone (deleted, cleaned, or metadata only), and
        // nothing libi does brings it back. Remembered on the entry so later opens and sends answer
        // at once, and logged here, once. No `error` text on the status — that text rendered as a
        // chat note ("Resource not found: <id>"); the chat renders its own explanation instead.
        entry.historyMissing = true;
        entry.messageCache = [];
        // An unlisted row the agent has now confirmed gone: the sidebar offers Remove, not Restart.
        if (entry.historyUnlisted) this.emitForSession(sessionId, { type: "sessions-changed" });
        logger.info(
          {
            tag: "session-manager",
            op: "load_session_history_missing",
            agentId,
            sessionId,
            durationMs: Date.now() - loadStart,
            err,
          },
          `${agentId} has no history for ${sessionId} — the chat can't be continued`,
        );
        this.emitForSession(sessionId, { type: "agent-status", status: "disconnected" });
        throw new AgentHistoryMissingError(sessionId, { cause: err });
      }
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
      // The standby went with the old process, and "New chat" stays disabled until one is ready.
      // Started once the replay is over, so its `session/new` never competes with the load on a
      // process that has only just come up — and started even when the replay failed.
      if (warmed) this.createStandbySession().catch(() => {});
    }

    // Clean dangling user message after replay.
    if (entry.currentUserMessage) {
      this.getEventHandler().cleanUserMessageParts(entry.currentUserMessage);
    }
    entry.currentAgentMessage = null;
    entry.currentUserMessage = null;

    // The agent loaded it, so it has a transcript and is not missing: indexed as such, and an
    // unlisted row (Codex filtered it out of its listing) is an ordinary chat again. Before `active`
    // flips, never between it and the approval-mode push below (review M7).
    this.indexSessions([entry], true);
    if (entry.historyUnlisted) {
      entry.historyUnlisted = false;
      this.emitForSession(sessionId, { type: "sessions-changed" });
    }

    // Only flip `active` true AFTER the replay has populated the cache. This
    // ensures every other API route that observes `active === true` also sees
    // a populated messageCache — no partial-cache windows.
    entry.active = true;

    // Re-push the saved approval mode now that the session is reattached.
    // Without this, a resumed session (after an LRU eviction, or a libi
    // restart) runs in the agent's OWN mode — for Claude the user's
    // `permissions.defaultMode` — rather than the user's saved policy.
    // Pass undefined so the push resolves the advertised set itself: the
    // entry's (captured from the load response above, or at newSession /
    // standby), then the agent's, then — for Claude only — its stable ids.
    await this.pushApprovalModeBounded(sessionId, agentId, undefined, "resume");
    await this.pushModelBounded(sessionId, agentId, entry.configOptions);

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
  async deactivateSession(
    sessionId: string,
    opts: { closeTimeoutMs?: number } = {},
  ): Promise<AcpCloseOutcome | "not_active"> {
    const entry = this.sessions.get(sessionId);
    if (!entry || !entry.active) return "not_active";

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
    this.preserveListeners(entry);

    // Close ACP connection
    let closed: AcpCloseOutcome = "no_connection";
    if (this.pm) {
      closed = await this.closeAcpSession(agentId, sessionId, opts.closeTimeoutMs);
      this.pm.unregisterSessionId(agentId, sessionId);
    }

    // Clear cache but keep the entry
    this.clearEntry(entry);
    return closed;
  }

  /** Copy a session's listeners to the pending set, so they survive until it is active again. */
  private preserveListeners(entry: SessionEntry): void {
    if (entry.listeners.size === 0) return;
    let pending = this.pendingListeners.get(entry.sessionId);
    if (!pending) {
      pending = new Set();
      this.pendingListeners.set(entry.sessionId, pending);
    }
    for (const cb of entry.listeners) pending.add(cb);
  }

  /** Mark an entry inactive and drop what its ACP session had in memory; the entry itself stays. */
  private clearEntry(entry: SessionEntry): void {
    entry.active = false;
    entry.messageCache = [];
    entry.currentAgentMessage = null;
    entry.currentUserMessage = null;
    this.retirePrompts(entry);
    entry.listeners = new Set();
  }

  /**
   * The ACP session is being dropped: every prompt still in flight on it is retired (it no longer
   * counts, and its late answer can end nothing newer — `isStalePrompt`). If any of them had not
   * settled — a cancelled one the silence bound stopped counting included — the chat is owed ONE
   * `agent-complete` for that turn, or its message stays "streaming" until the next turn. It is
   * sent (`endOwedTurn`) with the stop reason of the first retired prompt that still answers, so a
   * turn that really finished reads as finished (the unviewed dot, readiness); as `cancelled` if
   * none has by `RETIRED_TURN_GRACE_MS`, or before a new prompt starts, a restart reports its end,
   * or — `now`, for a crash, whose prompts can never answer — right away.
   * A prompt the adapter settled before the drop already sent its own and is in neither set.
   * Every drop goes through here: deactivate (eviction, reload, restart, agent switch,
   * /api/agent/stop), a crash, and the reset before a history replay.
   */
  private retirePrompts(entry: SessionEntry, opts: { now?: boolean } = {}): void {
    const unsettled = [...(openPrompts.get(entry) ?? []), ...(releasedPrompts.get(entry) ?? [])].filter(
      (t) => !t.settled,
    );
    resetPromptsInFlight(entry);
    if (unsettled.length > 0) {
      let owed = owedTurnEnds.get(entry);
      if (!owed) {
        const timer = setTimeout(() => this.endOwedTurn(entry, "cancelled"), RETIRED_TURN_GRACE_MS);
        timer.unref?.();
        owed = { tickets: new Set(), timer };
        owedTurnEnds.set(entry, owed);
      }
      for (const ticket of unsettled) owed.tickets.add(ticket);
    }
    if (opts.now) this.endOwedTurn(entry, "cancelled");
  }

  /** Send the `agent-complete` a retirement owes the chat, once. False when none is owed. */
  private endOwedTurn(entry: SessionEntry, stopReason: string): boolean {
    const owed = owedTurnEnds.get(entry);
    if (!owed) return false;
    owedTurnEnds.delete(entry);
    clearTimeout(owed.timer);
    this.emitForSession(entry.sessionId, { type: "agent-complete", stopReason });
    return true;
  }

  /**
   * `session/close` for `sessionId` on `agentId`'s current connection. Without a bound it waits as
   * long as the adapter takes (every caller but a restart); with one, an adapter that has not
   * answered by then is reported `timed_out` and left to answer (or not) on its own — the pending
   * request settles, harmlessly, when its connection closes. A rejection is `failed`: an adapter
   * that does not hold the session (or does not support close) says so that way.
   */
  private async closeAcpSession(
    agentId: string,
    sessionId: string,
    timeoutMs?: number,
  ): Promise<AcpCloseOutcome> {
    const conn = this.pm?.getConnection(agentId);
    if (!conn) return "no_connection";
    // A close that throws synchronously is a rejection like any other.
    let closing: Promise<unknown>;
    try {
      closing = Promise.resolve(conn.closeSession({ sessionId }));
    } catch (err) {
      closing = Promise.reject(err);
    }
    const outcome =
      timeoutMs === undefined
        ? await closing.then(
            (): Settled<unknown> => ({ kind: "ok", value: undefined }),
            (error): Settled<unknown> => ({ kind: "error", error }),
          )
        : await settleWithin(closing, timeoutMs);
    if (outcome.kind === "timed_out") return "timed_out";
    return outcome.kind === "ok" ? "closed" : "failed";
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
      markPermissionResolvedInCache(entry, pendingId, { kind: "cancelled" });
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

    // The prompts running NOW — a prompt sent after the cancel (the steer) is
    // never released by it.
    const cancelled = [...(openPrompts.get(entry) ?? [])];
    // The ACP session this cancel is for. A cancel the adapter answers only after that session
    // was dropped and loaded again (a restart gives up waiting on it) must not drain the
    // approval cards of the reloaded one.
    const epoch = entry.promptEpoch ?? 0;

    try {
      await conn.cancel({ sessionId });
      logger.info({ sessionId }, "Sent ACP session/cancel");
      // Only a cancel the agent ACCEPTED starts the bound: after a failed one
      // the prompt keeps running normally and must keep the chat busy.
      if (cancelled.length > 0) this.boundCancelledPrompts(entry, cancelled, Date.now());
    } catch (err) {
      logger.warn({ sessionId, err }, "Failed to send session/cancel");
    } finally {
      // Post-drain: catches any `requestPermission` that arrived during the
      // cancel round-trip. Without this, a permission request that lands
      // mid-await would never resolve (it'd sit in `pendingApprovals` after
      // cancelTurn returns). Runs on both success and failure paths — for the
      // session it was sent to only.
      if ((entry.promptEpoch ?? 0) === epoch) this.resolveAllPendingAsCancelled(entry);
    }
  }

  /**
   * Stop counting cancelled prompts the adapter never settles — a hung adapter
   * (process alive, prompt never answered) would otherwise pin the chat busy
   * until teardown. Released only once the session has been SILENT (no agent
   * update, `lastAgentActivityAt`) for CANCEL_SETTLE_TIMEOUT_MS since the
   * cancel was accepted: an adapter still finishing a tool it could not
   * interrupt keeps talking, and stays busy. Re-arms itself until the tickets
   * settle, are reset, or are released; each release is exactly-once.
   */
  private boundCancelledPrompts(
    entry: SessionEntry,
    tickets: PromptTicket[],
    cancelAcceptedAt: number,
  ): void {
    const check = () => {
      if (!tickets.some((t) => t.counted)) return; // settled or reset meanwhile
      const lastHeard = Math.max(cancelAcceptedAt, entry.lastAgentActivityAt ?? 0);
      const silentFor = Date.now() - lastHeard;
      if (silentFor < CANCEL_SETTLE_TIMEOUT_MS) {
        const timer = setTimeout(check, CANCEL_SETTLE_TIMEOUT_MS - silentFor);
        timer.unref?.();
        return;
      }
      let released = 0;
      for (const ticket of tickets) {
        if (!releasePrompt(entry, ticket)) continue;
        released++;
        // Its turn is still open for the client until it answers — or a drop retires it.
        let set = releasedPrompts.get(entry);
        if (!set) releasedPrompts.set(entry, (set = new Set()));
        set.add(ticket);
      }
      if (released === 0) return;
      logger.warn(
        {
          tag: "session-manager",
          op: "prompt_cancel_unsettled",
          sessionId: entry.sessionId,
          agentId: entry.agentId,
          released,
          silentMs: silentFor,
        },
        "a cancelled prompt did not settle; no longer counting it as in flight",
      );
      if (!isSessionMidTurn(entry)) {
        this.emitForSession(entry.sessionId, { type: "agent-status", status: "connected" });
      }
    };
    const timer = setTimeout(check, CANCEL_SETTLE_TIMEOUT_MS);
    timer.unref?.();
  }

  // -------------------------------------------------------------------------
  // 9. sendMessage(sessionId, text)
  // -------------------------------------------------------------------------

  /**
   * Send a message to the agent for a specific session.
   * Builds user + agent messages in cache. Calls conn.prompt().
   * Syncs sessions after completion.
   */
  /** The user sent (or tried to send) something in this chat (`SessionEntry.userSent`). */
  markUserSent(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) entry.userSent = true;
  }

  async sendMessage(sessionId: string, text: string): Promise<void> {
    this.markUserSent(sessionId);
    // A resumed chat reads active before its approval-mode push has landed — so the prompt waits
    // for the push, never overtaking the mode — and a chat whose mode could not be applied is held
    // (Ask / Auto). The send route runs the same gate first so it can fail the send retryably; this
    // covers every other caller.
    const pending = this.sessions.get(sessionId);
    if (pending?.approvalModePush || pending?.approvalModeNotApplied !== undefined) {
      const gate = await this.awaitApprovalMode(sessionId);
      if (!gate.ok) {
        this.emitForSession(sessionId, {
          type: "agent-status",
          status: "error",
          error: gate.error,
        });
        return;
      }
    }
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
    // A turn a drop retired and still owes its end is ended now, as cancelled — before this one
    // starts, so its late answer cannot end this turn instead.
    this.endOwedTurn(entry, "cancelled");

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

    // In flight from here until `conn.prompt` settles (the `finally` below).
    // Nothing awaits between this and the prompt going out.
    const promptTicket = beginPrompt(entry);
    this.emitForSession(sessionId, {
      type: "agent-status",
      status: "thinking",
    });

    try {
      this.authRejectedByTextTurn.delete(sessionId);
      const result = await conn.prompt({
        sessionId,
        prompt: [{ type: "text", text }],
      });
      // The ACP session this prompt ran on was dropped before it answered (a restart, an
      // eviction, a crash). Nothing here may touch the chat's state — a newer turn may be running on
      // the reloaded session — except ending the retired turn, if that is still owed, with the
      // reason it really ended (`retirePrompts`).
      if (isStalePrompt(entry, promptTicket)) {
        if (owedTurnEnds.get(entry)?.tickets.has(promptTicket)) {
          const authRejected = this.authRejectedByTextTurn.delete(sessionId);
          this.endOwedTurn(entry, result.stopReason);
          if (!authRejected && result.stopReason !== "cancelled") this.markAgentReady(entry.agentId, "prompt");
        }
        return;
      }
      entry.currentAgentMessage = null;
      // A turn that came back is proof the agent is signed in. A cancelled turn
      // may never have reached the model, so it proves nothing — and neither does
      // a turn that opened with Claude's auth-failure text.
      if (!this.authRejectedByTextTurn.delete(sessionId) && result.stopReason !== "cancelled") {
        this.markAgentReady(entry.agentId, "prompt");
      }
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
      if (isStalePrompt(entry, promptTicket)) {
        // A retired prompt failing (its connection closed under it) ended no differently than cancelled.
        if (owedTurnEnds.get(entry)?.tickets.has(promptTicket)) this.endOwedTurn(entry, "cancelled");
        return;
      }
      this.authRejectedByTextTurn.delete(sessionId);
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
    } finally {
      promptTicket.settled = true;
      releasePrompt(entry, promptTicket);
      releasedPrompts.get(entry)?.delete(promptTicket);
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
   * `bypassPermissions` to codex (codex-acp 1.10.0 advertises
   * `read-only|agent|agent-full-access`; ≤ 1.6.x `read-only|auto|full-access`)
   * yields ACP -32602 `approval.mode.set_failed`. `acpModeFor` maps + gates on
   * the advertised set, returning `null` when the target isn't advertised.
   *
   * The advertised set, first known wins:
   *   1. `availableModes` — the fresh `newSession` / standby response;
   *   2. the entry's cached set (newSession, standby claim, or the
   *      `session/load` response of a resume);
   *   3. the set this agent last advertised in this process
   *      (`advertisedModesByAgent` — the boot standby fills it before any resume);
   *   4. nothing known: Claude's ids are stable, so its mapped id is pushed
   *      anyway (`stableAcpModeFor`) and a refusal is a failure. Codex's are
   *      not, and a blind push to it was the -32602 bug, so nothing is pushed.
   *
   * Best-effort toward the SESSION: errors are logged and swallowed so a flaky
   * agent never breaks session creation or a resume. Never silent toward the
   * USER: a mode a chat could not be given is logged at error level
   * (`approval_mode_not_applied`) and the chat carries a note saying so
   * (`reportApprovalModeNotApplied`). The one quiet skip is "Auto, no
   * extension prompts" against a KNOWN set that lacks every candidate id —
   * the documented degrade in approval-mode-map.ts, quiet because no mode the
   * chat is left in is more permissive than the one asked for. Any other mode
   * is never dropped quietly: a resumed chat that silently ran in Claude's own
   * `auto` was full-verification F5, and a dropped `auto` loses the extension
   * gate the picker promises.
   *
   * The push in flight is kept on the entry (`approvalModePush`) so a prompt
   * sent meanwhile waits for it — a resumed chat reads active before its push
   * lands (`settleApprovalModePush`).
   *
   * Returns whether the mode was applied.
   */
  private pushApprovalModeToSession(
    sessionId: string,
    agentId: string,
    availableModes: { id: string }[] | undefined,
    context: ApprovalPushContext,
  ): Promise<boolean> {
    const entry = this.sessions.get(sessionId);
    const generation = entry ? (entry.approvalModePushGeneration ?? 0) + 1 : 0;
    if (entry) entry.approvalModePushGeneration = generation;
    const promise = this.applyApprovalMode(sessionId, agentId, availableModes, context, generation);
    if (entry) {
      const ownSettle = promise.then(
        () => {},
        () => {},
      );
      const prev = entry.approvalModePush;
      const all = prev ? Promise.all([prev.all, ownSettle]).then(() => {}) : ownSettle;
      const push = { promise, context, all };
      entry.approvalModePush = push;
      void all.then(() => {
        if (entry.approvalModePush === push) entry.approvalModePush = undefined;
      });
    }
    return promise;
  }

  /**
   * The gate before a prompt: is this chat's saved approval mode in force?
   *
   * 1. A push in flight is waited for (bounded, `approvalModePushWaitMs`) — with every push still
   *    in flight before it, a waived one included. Only under "Auto, no extension prompts" is a push
   *    the gate already waived skipped (`approvalModePushTimedOut`).
   * 2. `{ ok: true }` when the chat's mode is applied, or when its mode is "Auto, no extension
   *    prompts" (`approvalModeHoldsPrompts`) — nothing the chat can be left in exceeds it.
   * 3. Under "Ask each time" and "Auto", a chat whose mode is NOT applied — the push timed out,
   *    failed, or found nothing to push — is held: `{ ok: false }`, and the caller must not send.
   *    The chat may be in the agent's own mode (for Claude the user's `permissions.defaultMode`,
   *    possibly `auto`), where tools run with no card — F5. Unless it just waited on a push, the
   *    gate first RE-ATTEMPTS the push, so Retry is a real retry: a push that now lands clears
   *    the state and the prompt goes out. The send route answers non-OK so the message offers
   *    Retry (`retryable`), or names the way out when a retry can't help (a mode the agent doesn't
   *    offer).
   *
   * Every not-applied outcome is reported by `reportApprovalModeNotApplied` (error line + note).
   */
  async awaitApprovalMode(sessionId: string): Promise<ApprovalGate> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return { ok: true };
    let waited = false;
    if (
      entry.approvalModePush?.waived &&
      !approvalModeHoldsPrompts(getApprovalMode(entry.agentId))
    ) {
      // Still the never-prompt mode, and its push was already waived: nothing to wait for.
      return { ok: true };
    }
    if (entry.approvalModePush) {
      waited = true;
      const outcome = await this.settleApprovalModePush(entry);
      if (!outcome.settled) return this.approvalModePushTimedOut(entry, outcome);
    }
    if (entry.approvalModeNotApplied === undefined) return { ok: true };
    const mode = getApprovalMode(entry.agentId);
    if (!approvalModeHoldsPrompts(mode)) return { ok: true };
    if (!waited) {
      void this.pushApprovalModeToSession(sessionId, entry.agentId, undefined, "retry");
      const again = await this.settleApprovalModePush(entry);
      if (!again.settled) return this.approvalModePushTimedOut(entry, again);
      if (entry.approvalModeNotApplied === undefined) return { ok: true };
    }
    const reason = entry.approvalModeNotAppliedReason;
    return {
      ok: false,
      mode,
      error: approvalModeHeldError(mode, reason),
      retryable: approvalModeRetryable(reason),
    };
  }

  /** The gate's bound ran out with the push still unanswered. */
  private approvalModePushTimedOut(
    entry: SessionEntry,
    outcome: { push: NonNullable<SessionEntry["approvalModePush"]>; waitedMs: number },
  ): ApprovalGate {
    const mode = getApprovalMode(entry.agentId);
    if (!approvalModeHoldsPrompts(mode)) {
      logger.warn(
        {
          tag: "session-manager",
          op: "approval_mode_push_wait_timeout",
          agentId: entry.agentId,
          sessionId: entry.sessionId,
          mode,
          waitedMs: outcome.waitedMs,
        },
        `Sending to ${entry.sessionId} before its approval-mode push answered (never-prompt mode)`,
      );
      // Waived for this push: a second never-prompt gate on it (the route's, then sendMessage's)
      // must not sit out the bound again. It stays in the chain, though: a later push chains on it,
      // so a stricter mode picked meanwhile can't pass its gate while this looser push is still
      // outstanding and could land after it (NQ-7 review).
      if (entry.approvalModePush === outcome.push) outcome.push.waived = true;
      return { ok: true };
    }
    this.reportApprovalModeNotApplied(entry, mode, outcome.push.context, {
      reason: "set_timeout",
      waitedMs: outcome.waitedMs,
    });
    return {
      ok: false,
      mode,
      error: approvalModeHeldError(mode, "set_timeout"),
      retryable: true,
    };
  }

  /**
   * An approval-mode push settled that no longer speaks for the chat: a newer push started after
   * it, or the saved mode moved on. Nothing here may clear (or set) the not-applied state — the
   * older push may have LANDED OVER a newer mode (two concurrent `set_mode` calls answered out of
   * order), which for Codex could leave `agent` running under "Ask each time" with no card.
   *
   * - It failed and a newer push exists: that push decides; this one changed nothing.
   * - Otherwise (it landed, so it may have overwritten whatever came after it; or the mode moved
   *   on with no push of its own): push the CURRENT mode again. That push is the latest, so its
   *   outcome decides — and a still-newer one supersedes it the same way, so this converges.
   */
  private supersededApprovalPush(
    entry: SessionEntry,
    mode: ApprovalMode,
    target: string,
    landed: boolean,
    context: ApprovalPushContext,
    generation: number,
  ): Promise<boolean> {
    const newer = entry.approvalModePushGeneration !== generation;
    logger.info(
      {
        tag: "session-manager",
        op: "approval_mode_push_superseded",
        agentId: entry.agentId,
        sessionId: entry.sessionId,
        mode,
        target,
        landed,
        newer,
        current: getApprovalMode(entry.agentId),
        context,
      },
      `A superseded approval-mode push (${target}) ${landed ? "landed" : "failed"} on ${entry.sessionId}`,
    );
    if (!landed && newer) return Promise.resolve(false);
    // A chat that isn't loaded has no ACP session to push to (its process may be gone): its next
    // activation pushes the current mode itself, and a push now would only fail and note it.
    if (!entry.active) return Promise.resolve(false);
    return this.pushApprovalModeToSession(entry.sessionId, entry.agentId, undefined, context);
  }

  /** Race `work` against `ms`; true when the bound ran out first. `work` carries on either way. */
  private async outlasts(work: Promise<unknown>, ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slow = await Promise.race([
      work.then(
        () => false,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), ms);
      }),
    ]);
    clearTimeout(timer);
    return slow;
  }

  /**
   * `pushModelToSession`, bounded like `pushApprovalModeBounded`: `session/set_config_option` has
   * no SDK timeout either, and one that never answers must not hang activation or a new chat. The
   * push carries on; when it lands late, the session's model snapshot is published again so the
   * picker shows the re-applied model. Returns `{ slow }` when it outlasted the bound.
   */
  private async pushModelBounded(
    sessionId: string,
    agentId: string,
    configOptions: SessionConfigOption[],
  ): Promise<{ slow: Promise<void> } | undefined> {
    const started = Date.now();
    const push = this.pushModelToSession(sessionId, agentId, configOptions);
    if (!(await this.outlasts(push, this.approvalModePushWaitMs))) return undefined;
    logger.warn(
      {
        tag: "session-manager",
        op: "push_model_slow",
        agentId,
        sessionId,
        waitedMs: Date.now() - started,
      },
      `${agentId} hasn't answered set_config_option(model) for ${sessionId} — going on`,
    );
    push.then(
      () => {
        const entry = this.sessions.get(sessionId);
        if (entry?.active) this.emitTerminalModelSnapshot(sessionId, entry.configOptions);
      },
      () => {},
    );
    return { slow: push };
  }

  /**
   * A claimed standby whose own approval-mode push is still unanswered (`createStandbySession`
   * went on after the bound). That push knows nothing of the chat — it started before there was an
   * entry — so it can't be superseded the usual way (`supersededApprovalPush`), yet it can land
   * AFTER the claim's push and leave the chat in the mode saved when the standby was made, which may
   * be looser than the current one. So it is tracked as the chat's push in flight — the claim's
   * push chains after it and the prompt gate waits for both — and once it lands the current mode is
   * pushed again, before the gate can see the chain settle. One that fails changed nothing.
   */
  private adoptStandbyModePush(entry: SessionEntry, standbyPush: Promise<boolean>): void {
    const all = standbyPush.then(
      (landed) => {
        if (!landed || this.sessions.get(entry.sessionId) !== entry) return;
        logger.info(
          {
            tag: "session-manager",
            op: "approval_mode_standby_push_landed_late",
            agentId: entry.agentId,
            sessionId: entry.sessionId,
            mode: getApprovalMode(entry.agentId),
          },
          `The standby's approval-mode push landed after ${entry.sessionId} was claimed — pushing the current mode again`,
        );
        void this.pushApprovalModeToSession(entry.sessionId, entry.agentId, undefined, "new");
      },
      () => {},
    );
    const push = { promise: standbyPush, context: "standby" as const, all };
    entry.approvalModePush = push;
    void all.then(() => {
      if (entry.approvalModePush === push) entry.approvalModePush = undefined;
    });
  }

  /**
   * A claimed standby whose model push is still unanswered. Landing after the claim's own push, it
   * would leave the chat on the model saved when the standby was made — so once it settles, the
   * model saved NOW is pushed again (a no-op when the chat already has it). Latest intent wins.
   */
  private adoptStandbyModelPush(entry: SessionEntry, standbyPush: Promise<void>): void {
    void standbyPush.then(() => {
      if (this.sessions.get(entry.sessionId) !== entry) return;
      void this.pushModelBounded(entry.sessionId, entry.agentId, entry.configOptions);
    });
  }

  /**
   * Push the saved approval mode, but let the caller (activation, a new chat) go on after
   * `approvalModePushWaitMs`: the ACP SDK puts no timeout on `set_mode`, and one that never
   * answers must not hang activation — every later history GET joins that activation. The push
   * carries on in the background, tracked on the entry, and the prompt gate (`awaitApprovalMode`)
   * is what enforces the mode. Returns `{ slow }`, that push, when it outlasted the bound (a standby
   * has no entry to track it on, so it keeps it itself); undefined when it settled in time.
   */
  private async pushApprovalModeBounded(
    sessionId: string,
    agentId: string,
    availableModes: { id: string }[] | undefined,
    context: ApprovalPushContext,
  ): Promise<{ slow: Promise<boolean> } | undefined> {
    const started = Date.now();
    const push = this.pushApprovalModeToSession(sessionId, agentId, availableModes, context);
    if (!(await this.outlasts(push, this.approvalModePushWaitMs))) return undefined;
    logger.warn(
      {
        tag: "session-manager",
        op: "approval_mode_push_slow",
        agentId,
        sessionId,
        context,
        waitedMs: Date.now() - started,
      },
      `${agentId} hasn't answered set_mode for ${sessionId} — going on; its prompts wait for it`,
    );
    // Wrapped: an async function returning the bare promise would wait for it.
    return { slow: push };
  }

  /**
   * Wait until `entry`'s approval-mode push in flight has settled, so `session/prompt` never runs
   * ahead of the mode it must run under — and so a push that fails has posted its note before the
   * user's message. Follows a newer push that replaced it (the picker changed meanwhile). Bounded
   * by `approvalModePushWaitMs`, shared across the loop; what a timeout means is decided by
   * `awaitApprovalMode`.
   */
  private async settleApprovalModePush(
    entry: SessionEntry,
  ): Promise<
    | { settled: true }
    | { settled: false; push: NonNullable<SessionEntry["approvalModePush"]>; waitedMs: number }
  > {
    const started = Date.now();
    let push = entry.approvalModePush;
    while (push) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = await Promise.race([
        push.all.then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(
            () => resolve(true),
            Math.max(0, started + this.approvalModePushWaitMs - Date.now()),
          );
        }),
      ]);
      clearTimeout(timer);
      if (timedOut) return { settled: false, push, waitedMs: Date.now() - started };
      push = entry.approvalModePush === push ? undefined : entry.approvalModePush;
    }
    return { settled: true };
  }

  private async applyApprovalMode(
    sessionId: string,
    agentId: string,
    availableModes: { id: string }[] | undefined,
    context: ApprovalPushContext,
    generation: number,
  ): Promise<boolean> {
    const mode = getApprovalMode(agentId);
    const entry = this.sessions.get(sessionId);
    const modes =
      availableModes ??
      entry?.availableModes ??
      this.advertisedModesByAgent.get(agentId);
    const known = acpModeFor(agentId, mode, modes);
    const unverified = known === null && !modes;
    // Blind (nothing known): Claude's stable candidates in order, so a root refusal of
    // `bypassPermissions` falls through to `default` exactly as a known set would.
    const targets: readonly string[] =
      known !== null ? [known] : unverified ? stableAcpModeCandidates(agentId, mode) : [];
    if (targets.length === 0) {
      if (!entry || (modes && mode === "auto-with-generations")) {
        // No chat to tell (a standby — its claim pushes again), or the documented degrade: the
        // never-prompt mode against a known vocabulary that has none of its ids. Nothing the chat
        // is left in is more permissive than what was asked for, so it is a warning, not a note.
        logger.warn(
          {
            tag: "session-manager",
            op: "approval_mode_unsupported_by_agent",
            agentId,
            sessionId,
            mode,
            context,
            availableModes: modes?.map((m) => m.id),
          },
          "approval.mode.unsupported_by_agent",
        );
        return false;
      }
      this.reportApprovalModeNotApplied(entry, mode, context, {
        reason: modes ? "unsupported_by_agent" : "modes_unknown",
        availableModes: modes?.map((m) => m.id),
      });
      return false;
    }
    // No process to push to (FINAL #4: this used to return silently). Logged so a push that did
    // nothing is visible next to whatever later push or gate decides the chat.
    const conn = this.pm?.getConnection(agentId);
    if (!conn) {
      logger.debug(
        {
          tag: "session-manager",
          op: "approval_mode_no_connection",
          agentId,
          sessionId,
          mode,
          context,
          hasPm: !!this.pm,
        },
        `No ${agentId} connection to push approval mode "${mode}" to ${sessionId}`,
      );
      // A chat whose mode could not be pushed is not in that mode: held under Ask / Auto like any
      // failed push, and a later push that lands clears it. Only when this push still speaks for
      // the chat — a newer push, or a mode that moved on, decides instead.
      if (
        entry &&
        entry.approvalModePushGeneration === generation &&
        getApprovalMode(agentId) === mode
      ) {
        this.reportApprovalModeNotApplied(entry, mode, context, { reason: "set_failed", target: targets[0] });
      }
      return false;
    }
    let target = targets[0];
    let applied = false;
    let err: unknown;
    for (const candidate of targets) {
      target = candidate;
      try {
        await conn.setSessionMode({ sessionId, modeId: candidate });
        applied = true;
        break;
      } catch (e) {
        err = e;
        if (candidate !== targets[targets.length - 1]) {
          logger.info(
            {
              tag: "session-manager",
              op: "approval_mode_candidate_refused",
              agentId,
              sessionId,
              mode,
              target: candidate,
              context,
              err: e,
            },
            `${agentId} refused mode id "${candidate}" — trying the next candidate`,
          );
        }
      }
    }
    // Settled after a newer push started on this chat, or after the saved mode moved on: this push
    // must not decide the chat's state — see `supersededApprovalPush`.
    if (
      entry &&
      (entry.approvalModePushGeneration !== generation || getApprovalMode(agentId) !== mode)
    ) {
      return this.supersededApprovalPush(entry, mode, target, applied, context, generation);
    }
    if (!applied) {
      if (!entry) {
        logger.warn(
          {
            tag: "session-manager",
            op: "approval_mode_set_failed",
            err,
            agentId,
            sessionId,
            target,
            context,
          },
          "approval.mode.set_failed",
        );
        return false;
      }
      this.reportApprovalModeNotApplied(entry, mode, context, {
        reason: "set_failed",
        target,
        unverified,
        err,
      });
      return false;
    }
    if (unverified) {
      logger.info(
        {
          tag: "session-manager",
          op: "approval_mode_pushed_unverified",
          agentId,
          sessionId,
          mode,
          target,
          context,
        },
        `Pushed ${agentId}'s stable mode id "${target}" without an advertised mode set`,
      );
    }
    if (entry && entry.approvalModeNotApplied !== undefined) {
      entry.approvalModeNotApplied = undefined;
      entry.approvalModeNotAppliedReason = undefined;
      this.reportApprovalModeApplied(entry, mode);
    }
    return true;
  }

  /** Remember the mode ids `agentId`'s adapter advertised, for chats that have none of their own. */
  private rememberAdvertisedModes(
    agentId: string,
    modes: { id: string }[] | undefined,
  ): void {
    if (modes && modes.length > 0) this.advertisedModesByAgent.set(agentId, modes);
  }

  /** Log, once per agent per process and at debug level, which keys its `session/load` answers with. */
  private logLoadResponseShape(agentId: string, loadResult: unknown): void {
    if (this.loadResponseShapeLogged.has(agentId)) return;
    this.loadResponseShapeLogged.add(agentId);
    const keys =
      loadResult && typeof loadResult === "object" ? Object.keys(loadResult).sort() : [];
    const modes = (loadResult as { modes?: { availableModes?: { id: string }[] } } | null)?.modes;
    logger.debug(
      {
        tag: "session-manager",
        op: "load_session_response_shape",
        agentId,
        keys,
        modeIds: modes?.availableModes?.map((m) => m.id),
      },
      `${agentId} session/load answered with: ${keys.join(", ") || "(nothing)"}`,
    );
  }

  /**
   * A chat's saved approval mode could not be applied: say so, loudly and in the chat.
   *
   * The session keeps running in whatever mode the agent chose itself — for Claude the user's own
   * `permissions.defaultMode`, which can be `auto` — while the picker still shows the saved one.
   * That silent gap is full-verification F5, so it is logged at ERROR level and the chat gets a
   * note, both in its history (a reload keeps it) and live. The note's id is stable per session,
   * mode and note epoch, so a repeat never double-posts. Cleared from the entry by the next push
   * that lands, which posts an "applied" note and starts a new epoch (`reportApprovalModeApplied`).
   */
  private reportApprovalModeNotApplied(
    entry: SessionEntry,
    mode: ApprovalMode,
    context: ApprovalPushContext,
    details: {
      reason: ApprovalNotAppliedReason;
      availableModes?: string[];
      waitedMs?: number;
      target?: string;
      unverified?: boolean;
      err?: unknown;
    },
  ): void {
    const { sessionId, agentId } = entry;
    logger.error(
      {
        tag: "session-manager",
        op: "approval_mode_not_applied",
        agentId,
        sessionId,
        mode,
        context,
        ...details,
      },
      `libi could not apply approval mode "${mode}" to ${agentId} session ${sessionId} (${details.reason}) — it runs in the agent's own mode`,
    );
    entry.approvalModeNotApplied = mode;
    entry.approvalModeNotAppliedReason = details.reason;
    const text = approvalModeNotAppliedNote(agentId, mode, context, details.reason);
    // Epoch 0 keeps the original id; after an "applied" note, a new failure is a new note.
    const epoch = entry.approvalModeNoteEpoch ?? 0;
    const noteId = `note_approval_mode_${sessionId}_${mode}${epoch > 0 ? `_${epoch}` : ""}`;
    this.postApprovalModeNote(entry, noteId, text);
  }

  /**
   * A push landed on a chat that carried a not-applied note: retract it in the chat, so the user
   * isn't left reading "libi won't send messages here" after it does. Bumps the chat's note epoch,
   * so a later failure posts a fresh note rather than deduping into the first.
   */
  private reportApprovalModeApplied(entry: SessionEntry, mode: ApprovalMode): void {
    const epoch = (entry.approvalModeNoteEpoch ?? 0) + 1;
    entry.approvalModeNoteEpoch = epoch;
    logger.info(
      {
        tag: "session-manager",
        op: "approval_mode_applied_after_failure",
        agentId: entry.agentId,
        sessionId: entry.sessionId,
        mode,
        epoch,
      },
      `Approval mode "${mode}" now applied to ${entry.sessionId}`,
    );
    this.postApprovalModeNote(
      entry,
      `note_approval_mode_applied_${entry.sessionId}_${epoch}`,
      `'${APPROVAL_MODE_LABELS[mode]}' is now applied to this chat.`,
    );
  }

  /** Put an approval-mode note in the chat's history (once per id) and send it live. */
  private postApprovalModeNote(entry: SessionEntry, noteId: string, text: string): void {
    if (!entry.messageCache.some((m) => m.id === noteId)) {
      const note: AgentMessage = {
        id: noteId,
        role: "agent",
        parts: [{ type: "text", text }],
        timestamp: Date.now(),
      };
      // Mid-turn (the picker changed while a reply streams), the note goes BEFORE the streaming
      // reply: a history refetch adopts the last fetched agent message as the live one
      // (`applyHistory`), and the rest of the reply would otherwise stream onto the note.
      const streaming = entry.currentAgentMessage
        ? entry.messageCache.indexOf(entry.currentAgentMessage)
        : -1;
      if (streaming >= 0) entry.messageCache.splice(streaming, 0, note);
      else entry.messageCache.push(note);
    }
    this.emitForSession(entry.sessionId, { type: "chat-note", text, noteId });
  }

  /**
   * Re-push the saved approval mode to every active session belonging to
   * `agentId`. Called from the PATCH endpoint when the user changes their
   * mode for an agent so all currently-running sessions adopt the new policy
   * immediately. Inactive sessions get the new mode the next time they're
   * activated — `performActivation` re-pushes after `loadSession` succeeds.
   * Pushes run in parallel; each is independent and error-swallowing, and each
   * is bounded (`pushApprovalModeBounded`): a `set_mode` that never answers must
   * not hold the PATCH (33.9 s in APR-1's live repro). A push still in flight
   * past the bound carries on, tracked on its entry, and the prompt gate
   * (`awaitApprovalMode`) holds that chat's prompts until it lands.
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
        this.pushApprovalModeBounded(sessionId, agentId, undefined, "change"),
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
   * Used by `libi.extension({ action: "restart_session" })` from `mcp/bundled-mcps/install-tools.ts`.
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
        // The turn the deactivate retired is ended NOW, before the load's replay starts — not by
        // the grace timer, which could otherwise fire in the middle of it. A prompt that answered
        // the close already ended it with its own stop reason; a late answer adds nothing.
        this.endOwedTurn(entry, "cancelled");
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
  // 8c. restartSession(sessionId) — the user's "Restart session"
  // -------------------------------------------------------------------------

  /**
   * Restart a chat for the user (the session's right-click menu, `POST /api/sessions/:id/restart`):
   * the conversation is kept, and the adapter builds the session again, so an MCP server added to
   * the agent's config after the chat was created (`claude mcp add`, `codex mcp add`, the Providers
   * tab) is in it afterwards, and a chat stuck on a dead or hung adapter comes back.
   *
   * CLOSE, then load — both are needed, for both adapters. A `session/load` of a session the
   * adapter still holds does not re-read anything: claude-agent-acp returns early when the
   * session's fingerprint (cwd + mcpServers) is unchanged, keeping its `claude` child and the MCP
   * servers that child started with; codex-acp re-attaches to the live thread in its app-server.
   * After `session/close` (claude: the session's child is killed; codex: `thread/unsubscribe`
   * unloads the thread) the load starts a new `claude` child / resumes the thread from its
   * rollout, and each reads the agent's config as it is now. Measured on 2026-09-25 (claude-agent-acp
   * 0.75.1, codex-acp 1.10.0 driving codex-cli 0.155): a server added to the config after the
   * session was created started on close + load and did not on load alone. Neither needs the
   * adapter PROCESS restarted, so other chats on it are untouched. The in-app `mcpServers` are
   * computed exactly as for a new chat (`getMcpServersForAcp`, via `activateSession`), and a
   * standby the config change made stale is replaced, as when a chat is opened.
   *
   * Kept across the restart: the history (the adapter replays its own transcript, and the agent
   * resumes from it), the piece the chat works on (libi's opened piece, `lib/editor-state`, plus
   * what the transcript says — neither is part of the ACP session), and the model and approval
   * mode (`activateSession` pushes both again). The permission mode is the approval mode's ACP
   * half, pushed with it.
   *
   * A running turn is cancelled first, exactly as Stop does (approval cards resolve as
   * cancelled); a turn the adapter has not settled by the time the session is closed is ended for
   * the chat here, so its Stop button always goes away.
   *
   * Bounded: the close waits `RESTART_CLOSE_TIMEOUT_MS`, the load `RESTART_LOAD_TIMEOUT_MS`. An
   * adapter that answers neither is not answering at all; its process is then replaced and the
   * chat loaded on the new one — but only while no other chat on that process is working or
   * being opened, since replacing it would kill that work. Idle chats that shared it lose only
   * their ACP session and load again on their next message, as after an eviction.
   *
   * The chat learns all of it over the one SSE connection: `session-restart` started / done /
   * failed (with the reason in plain words), around the usual status and history events.
   */
  restartSession(sessionId: string): Promise<SessionRestartResult> {
    const inflight = this.restartingSessions.get(sessionId);
    if (inflight) return inflight;
    const run = { abandoned: false };
    const restart = (async () => {
      // A run the deadline abandoned may still be inside a step — a process replacement, a load.
      // Running alongside it would close and load the chat on a process it is about to kill, or
      // replace the process a second time; so this one starts only once that one has stopped. Each
      // of its steps is bounded today; the wait has its own bound anyway, so a step that ever hangs
      // fails this Restart (and the next) instead of wedging every later one. The deadline below is
      // this run's own.
      const unwinding = this.restartRuns.get(sessionId);
      if (unwinding) {
        const agentId = this.sessions.get(sessionId)?.agentId;
        logger.info(
          { tag: "session-manager", op: "session_restart_waits", agentId, sessionId },
          `Restart of session ${sessionId} waits for the previous one to stop`,
        );
        if ((await settleWithin(unwinding, RESTART_DEADLINE_MS)).kind === "timed_out") {
          const failure = new SessionRestartError(
            "timed_out",
            "The previous restart of this chat is still stuck, so libi didn't start another. Quit and reopen libi, then try again.",
          );
          logger.warn(
            { tag: "session-manager", op: "session_restart_failed", agentId, sessionId, code: failure.code, reason: "previous_run_stuck" },
            `Restart of session ${sessionId} failed: ${failure.message}`,
          );
          this.emitForSession(sessionId, { type: "session-restart", phase: "failed", error: failure.message });
          throw failure;
        }
      }
      const performing = this.performRestart(sessionId, run);
      const ended: Promise<unknown> = performing
        .catch(() => {})
        .finally(() => {
          if (this.restartRuns.get(sessionId) === ended) this.restartRuns.delete(sessionId);
        });
      this.restartRuns.set(sessionId, ended);
      const outcome = await settleWithin(performing, RESTART_DEADLINE_MS);
      if (outcome.kind === "ok") return outcome.value;
      if (outcome.kind === "error") throw outcome.error;
      // Past the deadline: say so and let go. Whatever the run is still waiting on keeps going and
      // is harmless — the run stops at its next step and says nothing more. The chat is left as a
      // later Restart or message expects it: inactive (loaded again on demand) or, if the load it
      // was waiting on finishes after all, active.
      run.abandoned = true;
      const failure = new SessionRestartError(
        "timed_out",
        "The restart took longer than 90 seconds, so libi stopped waiting. Try Restart again; if it happens again, quit and reopen libi.",
      );
      logger.warn(
        {
          tag: "session-manager",
          op: "session_restart_failed",
          agentId: this.sessions.get(sessionId)?.agentId,
          sessionId,
          code: failure.code,
          durationMs: RESTART_DEADLINE_MS,
        },
        `Restart of session ${sessionId} failed: ${failure.message}`,
      );
      const entry = this.sessions.get(sessionId);
      if (entry) this.endOwedTurn(entry, "cancelled");
      this.emitForSession(sessionId, { type: "session-restart", phase: "failed", error: failure.message });
      throw failure;
    })().finally(() => {
      if (this.restartingSessions.get(sessionId) === restart) this.restartingSessions.delete(sessionId);
    });
    this.restartingSessions.set(sessionId, restart);
    return restart;
  }

  /** Whether a restart of `sessionId` is under way — asked by a window whose SSE connection came
   *  back mid-restart, to learn whether the `done` it may have missed is still to come. */
  isRestarting(sessionId: string): boolean {
    return this.restartingSessions.has(sessionId);
  }

  private async performRestart(
    sessionId: string,
    run: { abandoned: boolean },
  ): Promise<SessionRestartResult> {
    /** Stop here if the deadline already gave this run up. */
    const checkpoint = () => {
      if (run.abandoned) throw new RestartAbandoned();
    };
    const entry = this.sessions.get(sessionId);
    if (!entry || !this.pm) {
      logger.warn(
        { tag: "session-manager", op: "session_restart_failed", sessionId, code: "not_found" },
        `Restart of unknown session ${sessionId} refused`,
      );
      throw new SessionRestartError(
        "not_found",
        "libi doesn't have this chat open any more. Reload the page, then try again.",
      );
    }
    const agentId = entry.agentId;
    const start = Date.now();
    logger.info(
      {
        tag: "session-manager",
        op: "session_restart",
        agentId,
        sessionId,
        active: entry.active,
        midTurn: isSessionMidTurn(entry),
        pendingApprovals: entry.pendingApprovals.size,
      },
      `Restarting session ${sessionId}`,
    );
    this.emitForSession(sessionId, { type: "session-restart", phase: "started" });
    this.discardStaleStandby(agentId);

    try {
      let stuck: "close" | "load" | "mode_push" | null = await this.closeForRestart(entry);
      checkpoint();
      // Close answered, but the chat's approval-mode push still hasn't: a `set_mode` the adapter
      // never answers keeps the chat held (and every later push chained behind it), and a load on
      // the same process can't clear it. Only replacing the process lets go of it.
      if (!stuck && (await this.modePushStillOutstanding(entry))) stuck = "mode_push";
      checkpoint();
      if (!stuck) {
        const loaded = await settleWithin(this.activateSession(sessionId), RESTART_LOAD_TIMEOUT_MS);
        checkpoint();
        if (loaded.kind === "error") throw this.restartLoadFailure(loaded.error);
        if (loaded.kind === "timed_out") stuck = "load";
      }
      let processRestarted = false;
      if (stuck) {
        // Throws before a new process exists (refused, or restartProcess failed — see there).
        const { stale } = await this.replaceUnresponsiveProcess(entry, stuck);
        processRestarted = true;
        try {
          checkpoint();
          await this.dropStaleActivation(entry, stale);
          checkpoint();
          const loaded = await settleWithin(this.activateSession(sessionId), RESTART_LOAD_TIMEOUT_MS);
          checkpoint();
          if (loaded.kind === "error") throw this.restartLoadFailure(loaded.error);
          if (loaded.kind === "timed_out") {
            throw new SessionRestartError(
              "agent_unresponsive",
              "The agent still isn't responding, even after libi restarted it. Quit and reopen libi, then try again.",
            );
          }
        } finally {
          // The standby went with the old process. It comes back on the new one however this chat's
          // load ended — failed, timed out, or abandoned at the deadline — or "New chat" would stay
          // on "Preparing a new chat session…" until something else started one. After the load,
          // so its `session/new` never competes with the load on a process just come up.
          this.createStandbySession().catch(() => {});
        }
      }
      logger.info(
        {
          tag: "session-manager",
          op: "session_restart_done",
          agentId,
          sessionId,
          processRestarted,
          durationMs: Date.now() - start,
        },
        `Restarted session ${sessionId} (${Date.now() - start}ms)`,
      );
      const agent = toAgentEventId(agentId);
      if (agent) {
        void trackServerEvent("session_restarted", {
          agent,
          scope: processRestarted ? "agent_process" : "session",
        });
      }
      // A turn the restart cut short that has not answered by now is ended before the chat hears
      // the restart is over (here, on `failed`, and at the deadline). One a run abandoned at the
      // deadline retires only later is ended by the grace timer — still once, after the `failed`.
      this.endOwedTurn(entry, "cancelled");
      this.emitForSession(sessionId, { type: "session-restart", phase: "done" });
      return { agentId, processRestarted };
    } catch (err) {
      if (run.abandoned) {
        // The deadline already failed this restart for the chat; nothing more is said.
        logger.info(
          { tag: "session-manager", op: "session_restart_abandoned", agentId, sessionId, durationMs: Date.now() - start },
          `Abandoned restart of session ${sessionId} stopped`,
        );
        throw err;
      }
      const failure =
        err instanceof SessionRestartError ? err : this.restartLoadFailure(err);
      logger.warn(
        {
          tag: "session-manager",
          op: "session_restart_failed",
          agentId,
          sessionId,
          code: failure.code,
          durationMs: Date.now() - start,
          err,
        },
        `Restart of session ${sessionId} failed: ${failure.message}`,
      );
      this.endOwedTurn(entry, "cancelled");
      this.emitForSession(sessionId, { type: "session-restart", phase: "failed", error: failure.message });
      throw failure;
    }
  }

  private restartLoadFailure(err: unknown): SessionRestartError {
    const reason = plainReason(err);
    return new SessionRestartError(
      "load_failed",
      reason ? `The chat couldn't be loaded again: ${reason}` : "The chat couldn't be loaded again.",
    );
  }

  /**
   * The first half of a restart: cancel the running turn, then close the session on the adapter.
   * Returns where the adapter stopped answering (`close`, or `load` for an activation that was
   * already under way and never finished), or null when it answered.
   */
  private async closeForRestart(entry: SessionEntry): Promise<"close" | "load" | null> {
    const { sessionId, agentId } = entry;

    // The chat was being opened when the user asked: that load is waited out first, within the
    // same bound. One that never finishes is exactly the stuck adapter a restart is for.
    const opening = this.activatingSessions.get(sessionId);
    if (opening) {
      const opened = await settleWithin(opening, RESTART_LOAD_TIMEOUT_MS);
      if (opened.kind === "timed_out") return "load";
    }

    if (!entry.active) {
      // The adapter may still hold a session libi let go of (a close it never answered), and a
      // load would return that early instead of building it again. "Session not found" is the
      // usual answer, and it is fine.
      const closed = await this.closeAcpSession(agentId, sessionId, RESTART_CLOSE_TIMEOUT_MS);
      return closed === "timed_out" ? "close" : null;
    }

    // The running turn is cancelled the way Stop cancels it: its approval cards resolve as
    // cancelled, and the adapter is told to stop.
    if (isSessionMidTurn(entry) || entry.pendingApprovals.size > 0) {
      await settleWithin(this.cancelTurn(sessionId), RESTART_CLOSE_TIMEOUT_MS);
    }

    // A turn the adapter did not settle on the close — including one sent from another window while
    // the close was awaited — is ended by the deactivation itself (`retirePrompts`).
    const closed = await this.deactivateSession(sessionId, { closeTimeoutMs: RESTART_CLOSE_TIMEOUT_MS });
    return closed === "timed_out" ? "close" : null;
  }

  /**
   * The adapter answered neither the close nor the load: replace its process, so the chat can load
   * on a new one. Refused while another chat on that process is working or being opened — killing
   * the process would kill that work. Idle chats on it lose their ACP session with it and are let
   * go the way an eviction lets go of one; each loads again on its next message.
   */
  private async replaceUnresponsiveProcess(
    entry: SessionEntry,
    stage: "close" | "load" | "mode_push",
  ): Promise<{ stale: Promise<AgentMessage[]> | undefined }> {
    const { agentId, sessionId } = entry;
    const pm = this.pm;
    const busy = this.otherChatBusy(agentId, sessionId);
    if (busy) {
      logger.warn(
        { tag: "session-manager", op: "session_restart_process_skipped", agentId, sessionId, stage, reason: busy },
        "The agent is not answering, but another chat on its process is working; not replacing the process",
      );
      throw new SessionRestartError(
        "agent_busy",
        "The agent isn't responding, and another chat is still working on it, so libi didn't restart it. Stop that chat (or let it finish), then restart this one again.",
      );
    }
    if (!pm?.restartProcess) {
      throw new SessionRestartError(
        "agent_unresponsive",
        "The agent isn't responding. Quit and reopen libi, then try again.",
      );
    }
    logger.warn(
      { tag: "session-manager", op: "session_restart_process", agentId, sessionId, stage },
      `The agent did not answer the restart's ${stage}; replacing its process`,
    );
    for (const other of this.sessions.values()) {
      if (other.agentId !== agentId || other.sessionId === sessionId || !other.active) continue;
      this.resolveAllPendingAsCancelled(other);
      this.preserveListeners(other);
      pm.unregisterSessionId(agentId, other.sessionId);
      this.clearEntry(other);
    }
    if (this.standbySession?.agentId === agentId) {
      this.standbySession = null;
      this.emitSystemEvent({ type: "standby-ready", ready: false });
    }
    const stale = this.activatingSessions.get(sessionId);
    try {
      await pm.restartProcess(agentId);
    } catch (err) {
      this.forgetModePushesOfOldProcess(agentId);
      // The old process is gone and no new one came up, so there is no standby either. A refusal is
      // an observed answer about the agent (readiness records it; installing or updating the CLI is
      // the user's to do), so nothing is started again. Any other failure says nothing about the
      // agent: start it once in the background, the way a failed shell-environment restart does.
      this.markAgentSpawnRefused(agentId, err);
      if (!isAgentSpawnRefused(err)) {
        this.startAgainAfterFailedRestart(agentId, ++this.agentStartEpoch);
      }
      const reason = plainReason(err);
      throw new SessionRestartError(
        "agent_unresponsive",
        `The agent wasn't responding, and libi couldn't start it again${reason ? `: ${reason}` : "."}`,
      );
    }
    this.forgetModePushesOfOldProcess(agentId);
    // Wrapped: an async function returning the promise itself would adopt it, awaiting the stale load.
    return { stale };
  }

  /**
   * Whether `entry`'s approval-mode push chain is still unanswered after the close, given the same
   * bound a prompt gate gives it (`approvalModePushWaitMs`) — a push merely slow gets its chance.
   */
  private async modePushStillOutstanding(entry: SessionEntry): Promise<boolean> {
    const push = entry.approvalModePush;
    if (!push) return false;
    if ((await settleWithin(push.all, this.approvalModePushWaitMs)).kind !== "timed_out") return false;
    logger.warn(
      {
        tag: "session-manager",
        op: "session_restart_mode_push_stuck",
        agentId: entry.agentId,
        sessionId: entry.sessionId,
        context: push.context,
      },
      `${entry.sessionId}'s approval-mode push is still unanswered at restart — the process must be replaced`,
    );
    return true;
  }

  /**
   * The process of `agentId` was replaced or died (a Restart, a crash, a shell-environment or
   * launcher restart — also when starting the new one failed): every approval-mode push still
   * waiting on it was sent to
   * a process that is gone, so none can change a session on the new one. Drop them from each chat's
   * chain — otherwise the chat's next push chains behind one that may never settle, and its prompts
   * stay held — and bump the push generation, so one that does settle late counts as superseded
   * (it re-pushes the current mode at most; it never decides the chat's state).
   */
  private forgetModePushesOfOldProcess(agentId: string): void {
    for (const entry of this.sessions.values()) {
      if (entry.agentId !== agentId || !entry.approvalModePush) continue;
      entry.approvalModePush = undefined;
      entry.approvalModePushGeneration = (entry.approvalModePushGeneration ?? 0) + 1;
    }
  }

  /**
   * After the process was replaced: wait out the activation that was stuck on the old one, and make
   * sure nothing it loaded counts. Killing the old process closed its connection, which rejects the
   * load that was stuck on it; until it lets go, a new load would only join it. A load that instead
   * ANSWERED at the last moment did so on the process that is gone — the entry is active on a
   * session the new process has never heard of, and the next activation would return that cache
   * without loading — so it is let go the way the idle chats on the process were. So is a chat
   * active with no load to wait for: an activation that started AND finished on the old process
   * while the restart waited (its stuck-push wait, NQ-7) is just as gone with that process.
   */
  private async dropStaleActivation(entry: SessionEntry, stale: Promise<unknown> | undefined): Promise<void> {
    if (stale && (await settleWithin(stale, RESTART_STALE_SETTLE_MS)).kind === "timed_out") {
      throw new SessionRestartError(
        "agent_unresponsive",
        "The agent still isn't responding, even after libi restarted it. Quit and reopen libi, then try again.",
      );
    }
    if (entry.active) {
      this.resolveAllPendingAsCancelled(entry);
      this.preserveListeners(entry);
      this.pm?.unregisterSessionId(entry.agentId, entry.sessionId);
      this.clearEntry(entry);
    }
  }

  /** Why the process of `agentId` must not be replaced for `sessionId`'s restart: another chat on
   *  it is working (a prompt or an approval card open) or being opened. Null when none is. */
  private otherChatBusy(agentId: string, sessionId: string): "mid_turn" | "opening" | null {
    for (const other of this.sessions.values()) {
      if (other.agentId !== agentId || other.sessionId === sessionId || !other.active) continue;
      if (isSessionMidTurn(other) || other.pendingApprovals.size > 0) return "mid_turn";
    }
    const ownOpening = this.activatingSessions.has(sessionId) ? 1 : 0;
    if ((this.openingSessions.get(agentId) ?? 0) - ownOpening > 0) return "opening";
    return null;
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
    const shellEnvLoaded = this.shellEnvLoadedFor(agentId);
    const freshness = captureStandbyFreshness(agentId);

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
      const result = await this.newAcpSession(conn, agentId, "standby");
      this.markAgentReady(agentId, "session-new");
      void this.logCodexEntryShape(agentId, result.sessionId);
      this.standbySession = {
        agentId,
        sessionId: result.sessionId,
        configOptions: result.configOptions ?? [],
        availableCommands: [],
        availableModes: result.modes?.availableModes,
        shellEnvLoaded,
        freshness,
      };
      this.rememberAdvertisedModes(agentId, result.modes?.availableModes);
      // Route ACP notifications for the standby NOW — claude-agent-acp sends
      // available_commands_update right after newSession() returns, and the
      // createClient gate drops updates for unregistered sessionIds. Without
      // this, every standby-claimed chat has an empty command palette until
      // a later loadSession re-activation (QA 2026-07-04).
      this.pm.registerSessionId(agentId, result.sessionId);
      // Bounded: a `set_mode` / `set_config_option` that never answers would leave
      // `standbyCreating` set, and `restartIdleAgentForLauncher` would keep the hung process. The
      // claim pushes both again (bounded) before the chat is handed out, and its prompts are gated.
      const bounded = await this.pushApprovalModeBounded(
        result.sessionId,
        agentId,
        result.modes?.availableModes,
        "standby",
      );
      const slowModePush = bounded?.slow;
      if (slowModePush && this.standbySession?.sessionId === result.sessionId) {
        const standby = this.standbySession;
        standby.approvalModePush = slowModePush;
        void slowModePush.then(
          () => {
            if (standby.approvalModePush === slowModePush) standby.approvalModePush = undefined;
          },
          () => {},
        );
      }
      const boundedModel = await this.pushModelBounded(
        result.sessionId,
        agentId,
        result.configOptions ?? [],
      );
      const slowModelPush = boundedModel?.slow;
      if (slowModelPush && this.standbySession?.sessionId === result.sessionId) {
        const standby = this.standbySession;
        standby.modelPush = slowModelPush;
        void slowModelPush.then(() => {
          if (standby.modelPush === slowModelPush) standby.modelPush = undefined;
        });
      }
      this.standbyFailedFor = null;
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
      this.standbyFailedFor = agentId;
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
      const ready = this.standbySession;
      // The environment loaded while this standby was being created on a process that predates
      // it — replace it now rather than hand it to the next chat.
      const shellEnvRefresh = ready?.shellEnvLoaded === false && isShellEnvLoaded();
      if (
        ready &&
        !shellEnvRefresh &&
        this.setupOverlappedAndSettled(ready.freshness) &&
        staleStandbyReason(ready.agentId, ready.freshness) !== null
      ) {
        // A setup terminal overlapped this standby's creation and closed before it was ready, so the settle found
        // nothing to replace (`refreshStaleStandby` skips a standby being created) — whether its command changed the
        // config mid-creation or not. Replace it now, before it is announced ready, or the next chat would discard it
        // and start slow. The replacement is taken with none open, so only another setup terminal can repeat this.
        this.discardStaleStandby(ready.agentId);
      } else {
        this.emitSystemEvent({
          type: "standby-ready",
          ready: this.isStandbyReady(),
        });
        if (shellEnvRefresh) void this.refreshStandbyForShellEnv();
      }
    }
  }

  /** Whether a setup terminal overlapped the creation of a standby taken with `freshness`, and none is open now. */
  private setupOverlappedAndSettled(freshness: StandbyFreshness): boolean {
    const setup = setupActivity();
    return setup.live === 0 && (freshness.setupLive || freshness.setupEpoch !== setup.epoch);
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
   * A standby's MCP servers are fixed when its session is created, so one created before the user added a provider
   * (the Providers tab's Add, or their own `claude mcp add`) would open a chat without it, while the tab tells them a
   * new chat has it. A ready standby of `agentId` whose MCP config changed since it was created, or that overlapped a
   * setup terminal (`staleStandbyReason`), is closed here, and a replacement is started at once. A chat about to
   * claim it starts fresh instead, which costs it the standby's head start and nothing else.
   */
  private discardStaleStandby(agentId: string): void {
    const standby = this.standbySession;
    if (!standby || this.standbyCreating || standby.agentId !== agentId) return;
    const reason = staleStandbyReason(agentId, standby.freshness);
    if (!reason) return;
    this.standbySession = null;
    this.emitSystemEvent({ type: "standby-ready", ready: false });
    this.pm?.getConnection(agentId)?.closeSession({ sessionId: standby.sessionId }).catch(() => {});
    this.pm?.unregisterSessionId(agentId, standby.sessionId);
    logger.info(
      { tag: "session-manager", op: "standby_stale_discarded", agentId, sessionId: standby.sessionId, reason },
      "The standby chat's MCP servers may be out of date; discarding it and starting a replacement",
    );
    this.createStandbySession().catch(() => {});
  }

  /** Replace the unclaimed standby if it went stale — called once the last setup terminal closed. */
  refreshStaleStandby(): void {
    if (this.standbySession) this.discardStaleStandby(this.standbySession.agentId);
  }

  /**
   * Standby refresh. The desktop app loads the user's shell environment in the background, so an
   * agent process can start before it arrives. Once it has loaded, an unclaimed standby whose
   * agent process was spawned before that is discarded, so the next chat starts WITH the
   * environment. A child's environment is fixed when it spawns, so a replacement standby on the
   * same process would inherit the same gap: the process is restarted first — only while no
   * in-app chat runs on it. A running chat is NEVER killed: with one running — or one still being
   * opened (created, or resumed and replaying its history) — nothing is restarted or closed, that
   * chat keeps its warning, and the standby is kept (the chat it later becomes shows the warning
   * too). A chat opened while the restart is under way waits for the new process. A restart that
   * fails for any reason but a refusal is followed by one background start of the agent, so "New
   * chat" does not stay disabled with nothing under way.
   */
  async refreshStandbyForShellEnv(): Promise<void> {
    const standby = this.standbySession;
    if (!standby || standby.shellEnvLoaded || !isShellEnvLoaded() || !this.pm?.restartProcess) return;
    const { agentId, sessionId } = standby;
    const busy = this.chatOnProcess(agentId);
    if (busy) {
      logger.info(
        { tag: "session-manager", op: "shell_env_standby_kept", agentId, reason: busy },
        "Shell environment loaded, but a chat is running on this agent's process; keeping its standby",
      );
      // Kept for the environment, but not if its MCP servers are out of date: that check still applies.
      this.refreshStaleStandby();
      return;
    }
    this.standbySession = null;
    this.emitSystemEvent({ type: "standby-ready", ready: false });
    this.pm.getConnection(agentId)?.closeSession({ sessionId }).catch(() => {});
    this.pm.unregisterSessionId(agentId, sessionId);
    logger.info(
      { tag: "session-manager", op: "shell_env_standby_discarded", agentId, sessionId },
      "Shell environment loaded after this standby's agent started; restarting the idle agent and replacing the standby",
    );
    const epoch = ++this.agentStartEpoch;
    try {
      await this.pm.restartProcess(agentId);
    } catch (err) {
      this.forgetModePushesOfOldProcess(agentId);
      // A typed refusal is an observed answer about the agent: readiness records it, and its remedy
      // (install or update the CLI) is the user's to act on, so nothing is started again. Any other
      // failure (an ACP initialize timeout, say) says nothing about the agent, so readiness is left
      // alone. Either way no process is left, and the standby was already discarded above.
      this.markAgentSpawnRefused(agentId, err);
      logger.warn(
        { tag: "session-manager", op: "shell_env_standby_refresh_failed", agentId, err },
        "Could not restart the agent after the shell environment loaded",
      );
      if (!isAgentSpawnRefused(err)) this.startAgainAfterFailedRestart(agentId, epoch);
      return;
    }
    this.forgetModePushesOfOldProcess(agentId);
    await this.createStandbySession();
  }

  /**
   * A launcher the user installed after `agentId`'s process started (detection's `launcherAfterStart`):
   * Codex starts its MCP servers from one long-lived process, so a running one never gets the PATH
   * that grew since (`lib/agents/agent-path.ts`). An IDLE process is replaced the way the
   * shell-environment refresh replaces one: its unclaimed standby is discarded, the process restarted
   * — spawned with the PATH as it is now — and, when it is the active agent, a standby made again.
   *
   * Never while a chat runs on the process or is being opened on it, nor while its standby is being
   * created: the process is kept, and the Providers tab keeps its "restart libi" hint. Nor unless a new
   * process would find one of `launchers` (the flagged rows' bare names) on the PATH it would get, read
   * fresh (the registry's on Windows): a launcher found somewhere that PATH doesn't reach would otherwise
   * restart the process on every detection pass.
   *
   * `restarting` (the hint can go) while the replacement is under way, a second call joining the one
   * already running; it settles, never rejects, once the new process is up and its standby made, or the
   * restart failed (then, as after the shell-environment restart, one background start follows).
   */
  async restartIdleAgentForLauncher(
    agentId: string,
    launchers: readonly string[],
  ): Promise<{ restarting: Promise<void> } | { kept: LauncherRestartKept }> {
    // The PATH a new process would get, read now (Windows: the registry; elsewhere a no-op).
    const pathRefresh = refreshFreshPathDirs();
    if (pathRefresh) await pathRefresh;
    const pm = this.pm;
    const kept = (reason: LauncherRestartKept) => {
      if (this.launcherRestartKeptLogged.get(agentId) !== reason) {
        this.launcherRestartKeptLogged.set(agentId, reason);
        logger.info(
          { tag: "session-manager", op: "launcher_restart_kept", agentId, reason },
          "A launcher was installed after this agent's process started; keeping the process",
        );
      }
      return { kept: reason } as const;
    };
    if (!pm?.restartProcess) return kept("no_process");
    const pending = pm.pendingRestart?.(agentId);
    if (pending) return { restarting: pending };
    if (!pm.getConnection(agentId)) return kept("no_process");
    const busy = this.chatOnProcess(agentId);
    if (busy) return kept(busy);
    if (this.standbyCreating && this._activeAgentId === agentId) return kept("standby_creating");
    const next = (agentChildPath() ?? "").split(pathDelimiter()).filter(Boolean);
    const reached = launchers.some((name) => lookupLauncher(name, { loginShellDirs: () => [], processPathDirs: () => next }) === "found");
    if (!reached) return kept("launcher_not_reached");

    this.launcherRestartKeptLogged.delete(agentId);
    const standby = this.standbySession?.agentId === agentId ? this.standbySession : null;
    if (standby) {
      this.standbySession = null;
      this.emitSystemEvent({ type: "standby-ready", ready: false });
      pm.getConnection(agentId)?.closeSession({ sessionId: standby.sessionId }).catch(() => {});
      pm.unregisterSessionId(agentId, standby.sessionId);
    }
    logger.info(
      { tag: "session-manager", op: "launcher_restart", agentId, standbyDiscarded: standby !== null },
      "A launcher was installed after this idle agent's process started; restarting it so its MCP servers can run it",
    );
    const epoch = ++this.agentStartEpoch;
    const restartProcess = pm.restartProcess.bind(pm);
    const restarting = (async (): Promise<void> => {
      try {
        await restartProcess(agentId);
      } catch (err) {
        this.forgetModePushesOfOldProcess(agentId);
        this.markAgentSpawnRefused(agentId, err);
        logger.warn(
          { tag: "session-manager", op: "launcher_restart_failed", agentId, err },
          "Could not restart the agent for its new launcher",
        );
        if (!isAgentSpawnRefused(err)) this.startAgainAfterFailedRestart(agentId, epoch);
        return;
      }
      this.forgetModePushesOfOldProcess(agentId);
      if (this._activeAgentId === agentId) await this.createStandbySession();
    })().catch(() => {});
    return { restarting };
  }

  /**
   * One background start of `agentId` after a restart of its process failed for a reason other
   * than a refusal — the shell-environment restart, the new-launcher restart, or a chat restart replacing an unresponsive
   * process (`replaceUnresponsiveProcess`). That restart left no process and no standby, and nothing else starts one until
   * the user opens a chat or picks the agent again — meanwhile "New chat" stays disabled on
   * "Preparing a new chat session…", a state that would never finish.
   *
   * One attempt, never a loop: if this start fails too, that is logged and the next chat or agent
   * pick starts the agent. Once the agent is up it waits, for at most `REWARM_RESUME_WAIT_MS`, for
   * the resumes of this agent already under way to finish loading, then creates the standby. It
   * stands down when it has been superseded — another agent was picked, this one was picked
   * again, or another restart began — because whatever superseded it starts the agent and sets
   * the standby up itself. It never kills anything: `warmProcess` only spawns (and joins a spawn
   * already under way), and `createStandbySession` does nothing while a standby exists or is
   * being created. The new process spawns with the environment, so its standby cannot send the
   * refresh round again.
   */
  private startAgainAfterFailedRestart(agentId: string, epoch: number): void {
    const pm = this.pm;
    const superseded = (): boolean =>
      this.pm !== pm ||
      this._activeAgentId !== agentId ||
      this.agentStartEpoch !== epoch ||
      !!pm?.pendingRestart?.(agentId);
    if (!pm || superseded()) return;
    logger.warn(
      { tag: "session-manager", op: "shell_env_restart_rewarm", agentId },
      "Starting the agent again once, in the background, after its restart failed",
    );
    void (async () => {
      try {
        await pm.warmProcess(agentId);
      } catch (err) {
        this.markAgentSpawnRefused(agentId, err);
        logger.warn(
          { tag: "session-manager", op: "shell_env_restart_rewarm_failed", agentId, err },
          "Could not start the agent again after its restart failed; the next chat or agent pick starts it",
        );
        return;
      }
      // A resume that joined this spawn is still loading its history on a process that has only
      // just come up. The standby's `session/new` waits for it, the same ordering a resume that
      // warmed the agent itself keeps. It waits rather than standing down: a chat opened on a
      // process that was already up does not bring the standby back itself. The wait is capped, and
      // the standby is created after it either way, so a resume that never answers cannot keep
      // "New chat" on "Preparing…".
      await this.activationsSettled(agentId, REWARM_RESUME_WAIT_MS);
      if (superseded()) {
        logger.info(
          { tag: "session-manager", op: "shell_env_restart_rewarm_superseded", agentId },
          "The agent was picked or restarted again meanwhile; leaving the standby to that",
        );
        return;
      }
      await this.createStandbySession();
    })().catch(() => {});
  }

  /** Settles once the resumes of `agentId` in flight when it is called have finished loading, or
   *  after `capMs`, whichever comes first. A resume that begins afterwards is not waited on: it
   *  found the process already up, so its `loadSession` does not compete with a fresh start, and
   *  back-to-back resumes would otherwise keep extending the wait. Never rejects: a resume that
   *  fails has still stopped loading. */
  private async activationsSettled(agentId: string, capMs: number): Promise<void> {
    const inflight = [...this.activatingSessions]
      .filter(([sessionId]) => this.sessions.get(sessionId)?.agentId === agentId)
      .map(([, activation]) => activation);
    if (inflight.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const capped = new Promise<"capped">((resolve) => {
      timer = setTimeout(() => resolve("capped"), capMs);
      timer.unref?.();
    });
    const outcome = await Promise.race([Promise.allSettled(inflight).then(() => "settled" as const), capped]);
    clearTimeout(timer);
    if (outcome === "capped") {
      logger.warn(
        { tag: "session-manager", op: "shell_env_restart_rewarm_resume_wait_capped", agentId, capMs },
        "A resume on the agent is still loading its history; creating the standby anyway",
      );
    }
  }

  /** Why a chat other than the unclaimed standby is on `agentId`'s process right now, or null when
   *  none is: an active chat, or one still being opened. */
  private chatOnProcess(agentId: string): "active_sessions" | "opening_sessions" | null {
    if (this.getActiveSessions().some((s) => s.agentId === agentId)) return "active_sessions";
    if (this.openingSessions.has(agentId)) return "opening_sessions";
    return null;
  }

  /**
   * Poll the shell→runtime environment seam while it says `pending` (the desktop probe settles
   * within ~30 s: 5 attempts of 2 s plus 1+2+4+8 s of backoff), then refresh the standby once.
   * A no-op under npx, dev and Windows (the variable is absent) and once the state is final.
   */
  watchShellEnvState(intervalMs: number = SHELL_ENV_WATCH_INTERVAL_MS): void {
    if (this.shellEnvWatch || readShellEnvState() !== "pending") return;
    const timer = setInterval(() => {
      const state = readShellEnvState();
      if (state === "pending") return;
      clearInterval(timer);
      this.shellEnvWatch = null;
      logger.info({ tag: "session-manager", op: "shell_env_settled", state }, `Shell environment ${state}`);
      if (state === "loaded") void this.refreshStandbyForShellEnv();
    }, intervalMs);
    timer.unref?.();
    this.shellEnvWatch = timer;
  }

  /**
   * Claim the standby session for a new chat.
   * Returns sessionId if available and matching the requested agent, else null.
   */
  private claimStandbySession(agentId: string): string | null {
    // Only a READY standby (the same condition `isStandbyReady` reports). One still being set up
    // already has its id, but claiming it then would skip the replenish below — `createStandbySession`
    // returns early while one is in progress — and leave "New chat" disabled for good. A chat that
    // waited out a restart resumes exactly while the refresh sets the next standby up.
    if (!this.standbySession || this.standbyCreating || this.standbySession.agentId !== agentId) {
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
    // runs. `isSessionMidTurn` reads the prompt counter `sendMessage` keeps —
    // not the assembly cursor, which late content re-creates after a turn.
    const idleSessions = activeSessions.filter((s) => !isSessionMidTurn(s));

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

    // Pending listeners (registered before session exists). A deactivation copies the listeners here
    // BEFORE it awaits the close and drops them from the entry after, so in between a callback is in
    // both sets — it still gets each event once.
    const pendingSet = this.pendingListeners.get(sessionId);
    if (pendingSet) {
      for (const cb of pendingSet) if (!entry?.listeners.has(cb)) cb(event);
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
   * Proof of readiness — the only proof we accept:
   *  - a prompt turn that came back (any stop reason except `cancelled`), for every agent;
   *  - a clean `session/new` — EXCEPT that it never overwrites an observed `needs-auth`
   *    for an agent that rejects auth only at `session/prompt` (declared as
   *    `signIn.rejectedAt: "prompt"` — today Claude Code, whose `session/new` succeeds
   *    unauthenticated). A standby created after a rejected prompt is no evidence of
   *    sign-in — live, that standby flipped readiness back to ready 100–200 ms after the
   *    rejection. Codex rejects AT `session/new`, so a clean one IS proof there.
   */
  private markAgentReady(agentId: string, via: "session-new" | "prompt"): void {
    if (
      via === "session-new" &&
      getAgentSetup(agentId)?.signIn.rejectedAt === "prompt" &&
      this.readiness.get(agentId)?.state === "needs-auth"
    ) {
      return;
    }
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
    // The wizard's confirmation is a UI gate, and this is the one observation
    // that proves it wrong. Only the wizard's agents have one.
    if (isSetupAgentId(agentId)) {
      try {
        clearSignInConfirmation(agentId);
      } catch (clearErr) {
        logger.warn(
          { tag: "session-manager", op: "clear_sign_in_confirmation_failed", agentId, err: clearErr },
          "could not clear the sign-in confirmation",
        );
      }
    }
    this.setReadiness(agentId, {
      state: "needs-auth",
      agentId,
      message,
    });
    // The funnel's drop-off signal: the sign-in the wizard's confirmation
    // claimed, disproved by the agent itself. Only a setup agent has a bounded
    // id to report; `context` is the `AuthNoteContext` enum.
    const agent = toAgentEventId(agentId);
    if (agent) trackServerEvent("agent_auth_rejected", { agent, stage: context });
  }

  /** Sessions whose CURRENT turn opened with Claude's auth-failure text. */
  private readonly authRejectedByTextTurn = new Set<string>();

  /**
   * Claude reported a failed sign-in (an expired OAuth session) as its REPLY TEXT in
   * a turn that otherwise succeeds — no ACP error, so `isAuthRequiredError` never
   * sees it. The event handler calls this only when a live claude-code turn OPENS
   * with CLAUDE_AUTH_FAILURE_TEXT_PREFIX. It is the same observed rejection as a
   * −32000, so it goes through `markAgentAuthFailure`: needs-auth, and the wizard's
   * sign-in confirmation cleared.
   */
  private markAgentAuthRejectedByText(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.authRejectedByTextTurn.add(sessionId);
    const err = Object.assign(new Error("Authentication required"), { code: ACP_AUTH_REQUIRED_CODE });
    this.markAgentAuthFailure(entry.agentId, err, "prompt");
  }

  /**
   * The process manager REFUSED to spawn (no usable CLI, or no adapter). That
   * refusal is itself the readiness answer — the same `not-installed` the start
   * route reports. Recognised by the error's name only (`isAgentSpawnRefused` — the process
   * manager may come from another route bundle than this one): any other failure, whatever its
   * message says, leaves readiness alone. Only a spawn can be refused, so this
   * belongs around `warmProcess`, never around `session/new`.
   */
  private markAgentSpawnRefused(agentId: string, err: unknown): void {
    if (isAgentSpawnRefused(err)) {
      this.setReadiness(agentId, { state: "not-installed", reason: err.reason.message });
    }
  }

  /**
   * A later user action supersedes an observed auth rejection: the user
   * confirmed they signed in, or picked the agent again. Readiness goes back to
   * `unknown` — never `ready`, because nothing here observed the agent working.
   * From there readiness is observed again: the next clean `session/new` (the
   * standby that replenishes, say) or returned prompt records `ready`, and a
   * prompt rejection records `needs-auth` again. Without this, an agent that
   * rejects auth only at `session/prompt`
   * has no `session/new` that can undo the observation, and every surface keeps
   * sending the user back to the sign-in terminal until libi restarts.
   *
   * Only the setup wizard's agents; a no-op unless the agent is in `needs-auth`.
   */
  forgetObservedAuthFailure(
    agentId: string,
    reason: "sign-in-confirmed" | "agent-reselected" = "sign-in-confirmed",
  ): void {
    if (!isSetupAgentId(agentId)) return;
    if (this.readiness.get(agentId)?.state !== "needs-auth") return;
    logger.info(
      { tag: "session-manager", op: "forget_observed_auth_failure", agentId, reason },
      `Forgetting ${agentId}'s observed auth rejection (${reason})`,
    );
    this.setReadiness(agentId, { state: "unknown" });
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
    // Picking an agent starts it and sets its standby up, superseding a pending background start.
    this.agentStartEpoch++;

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
    try {
      await this.pm.warmProcess(agentId);
    } catch (err) {
      this.markAgentSpawnRefused(agentId, err);
      throw err;
    }
    this._activeAgentId = agentId;

    // Picking the agent again is how the sign-in instructions tell the user to
    // come back. For an agent that rejects auth only at `session/prompt`, a
    // `session/new` never clears a `needs-auth` it holds, so forget it here,
    // before the session work starts: the standby's clean `session/new` below
    // then records `ready`, and only a prompt can record `needs-auth` again. An
    // agent that rejects AT `session/new` keeps its state: the standby below
    // re-tests it.
    if (getAgentSetup(agentId)?.signIn.rejectedAt === "prompt") {
      this.forgetObservedAuthFailure(agentId, "agent-reselected");
    }

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

        // The turn ends first, then the error says why — in that order the client finalizes the
        // message and still shows the error (an agent-complete after it would clear it).
        this.retirePrompts(entry, { now: true });
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
    this.forgetModePushesOfOldProcess(agentId);
  }

  // -------------------------------------------------------------------------
  // 16. Shutdown
  // -------------------------------------------------------------------------

  /** Gracefully shut down all sessions. */
  async shutdown(): Promise<void> {
    if (this.shellEnvWatch) {
      clearInterval(this.shellEnvWatch);
      this.shellEnvWatch = null;
    }
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
        (sessionId) => this.markAgentAuthRejectedByText(sessionId),
      );
      this.eventHandler.attachJobProgressBridge(
        (toolCallId) => this.findSessionByToolCallId(toolCallId),
        (toolIds, toolArgs) => this.findInProgressToolCall(toolIds, toolArgs),
      );
    }
    return this.eventHandler;
  }

  /**
   * The chat a libi tool call belongs to, for a navigation that should move only the tab showing
   * that chat (NAV-1): by the ACP toolCallId when the MCP child had one (Claude's toolUseId), else
   * by the registered tool name + args against the chats' unresolved calls — the same two keys the
   * job progress bridge uses. Null when no libi chat holds the call (a CLI agent's).
   */
  sessionForToolCall(call: { toolCallId?: string; toolName?: string; toolArgs?: unknown }): string | null {
    if (call.toolCallId) {
      const entry = this.findSessionByToolCallId(call.toolCallId);
      if (entry) return entry.sessionId;
    }
    if (call.toolName?.startsWith("libi.")) {
      const hit = this.findInProgressToolCall([makeMcpToolId(LIBI_MCP_ENTRY_NAME, call.toolName)], call.toolArgs);
      if (hit) return hit.session.sessionId;
    }
    return null;
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

/**
 * A setup terminal's command may have changed an agent's MCP servers or signed a provider in: once the last one
 * closed, the session manager `get` returns replaces a stale unclaimed standby, so the next chat is both instant and
 * current. Returns the unsubscribe.
 */
export function refreshStandbyWhenSetupSettles(get: () => Pick<SessionManager, "refreshStaleStandby"> | undefined): () => void {
  return onSetupTerminalsSettled(() => {
    get()?.refreshStaleStandby();
  });
}

/** How long a cancelled prompt may take to settle before it stops counting
 *  as in flight. A hung adapter (process alive, prompt never answered) would
 *  otherwise pin the session busy until teardown: Stop on every reconnect
 *  that cannot end the turn, and LRU eviction skipping it. */
export const CANCEL_SETTLE_TIMEOUT_MS = 30_000;

/** One prompt `sendMessage` sent. `counted` is true while it contributes to
 *  `entry.promptsInFlight`; it goes false exactly once — when the prompt
 *  settles, when its session is torn down, or when a cancel outlives
 *  `CANCEL_SETTLE_TIMEOUT_MS` — so no path can decrement twice. */
interface PromptTicket {
  epoch: number;
  counted: boolean;
  /** True once `conn.prompt` answered or failed. */
  settled: boolean;
}

/** Each entry's prompts still counted. Module-level (not a SessionEntry field)
 *  so the entry stays plain data. */
const openPrompts = new WeakMap<SessionEntry, Set<PromptTicket>>();

/** Cancelled prompts `CANCEL_SETTLE_TIMEOUT_MS` stopped counting before they answered. Not busy any
 *  more, but their turn is still open for the client: it ends when one answers, or when a drop
 *  retires them (`retirePrompts`). */
const releasedPrompts = new WeakMap<SessionEntry, Set<PromptTicket>>();

/** How long a turn whose prompts a drop retired waits for one of them to answer, so that its end is
 *  reported with the real stop reason, before it is ended as `cancelled`. An adapter that settles a
 *  prompt because its session closed does so within milliseconds of the close (measured 3 ms and
 *  105 ms on 2026-09-25). */
export const RETIRED_TURN_GRACE_MS = 2_000;

/** A turn a drop retired whose `agent-complete` the chat is still owed (`retirePrompts`). */
interface OwedTurnEnd {
  tickets: Set<PromptTicket>;
  timer: ReturnType<typeof setTimeout>;
}
const owedTurnEnds = new WeakMap<SessionEntry, OwedTurnEnd>();

/** Count a prompt as in flight. */
function beginPrompt(entry: SessionEntry): PromptTicket {
  entry.promptsInFlight = (entry.promptsInFlight ?? 0) + 1;
  const ticket: PromptTicket = { epoch: entry.promptEpoch ?? 0, counted: true, settled: false };
  let open = openPrompts.get(entry);
  if (!open) openPrompts.set(entry, (open = new Set()));
  open.add(ticket);
  return ticket;
}

/** Stop counting a prompt, once. A ticket from before a reset (its epoch is
 *  stale) was already dropped from the count by that reset. */
function releasePrompt(entry: SessionEntry, ticket: PromptTicket): boolean {
  openPrompts.get(entry)?.delete(ticket);
  if (!ticket.counted) return false;
  ticket.counted = false;
  if ((entry.promptEpoch ?? 0) !== ticket.epoch) return false;
  entry.promptsInFlight = Math.max(0, (entry.promptsInFlight ?? 0) - 1);
  return true;
}

/** The ACP session was dropped (deactivate, crash, replay): nothing it had
 *  in flight can still be running. */
function resetPromptsInFlight(entry: SessionEntry): void {
  entry.promptsInFlight = 0;
  entry.promptEpoch = (entry.promptEpoch ?? 0) + 1;
  for (const ticket of openPrompts.get(entry) ?? []) ticket.counted = false;
  openPrompts.get(entry)?.clear();
  releasedPrompts.get(entry)?.clear();
}

/** A prompt whose ACP session was dropped (deactivate, crash, replay) before it settled. */
function isStalePrompt(entry: SessionEntry, ticket: PromptTicket): boolean {
  return (entry.promptEpoch ?? 0) !== ticket.epoch;
}

// v6 (week/2026-10-02): APR-1 `awaitApprovalMode`, SES-4 `forgetSession` + the chat index, NAV-1
// `sessionForToolCall` — routes call each, and a hot-reloaded dev server kept a v5 instance without
// them. Bumped once for the week.
const SM_GLOBAL_KEY = "__sessionManager_v6";

const globalForSM = globalThis as unknown as {
  [SM_GLOBAL_KEY]?: SessionManager;
};

export function getSessionManager(): SessionManager {
  let sm = globalForSM[SM_GLOBAL_KEY];
  if (!sm) {
    sm = new SessionManager();
    globalForSM[SM_GLOBAL_KEY] = sm;
    sm.setSessionIndex(fileSessionIndex());

    // Register callback so mcp-config can refresh sessions without importing
    // us directly. We only refresh the standby — never disturb sessions
    // the user is mid-conversation with.
    onMcpConfigInvalidated(({ reason }) => {
      const inst = globalForSM[SM_GLOBAL_KEY];
      if (!inst) return;
      void reason;
      inst.invalidateStandbySession();
    });

    refreshStandbyWhenSetupSettles(() => globalForSM[SM_GLOBAL_KEY]);

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
      spawnedWithShellEnv: (agentId) => pm.spawnedWithShellEnv(agentId),
      restartProcess: (agentId) => pm.restartProcess(agentId),
      pendingRestart: (agentId) => pm.pendingRestart(agentId),
    });
    // The desktop app may still be loading the user's shell environment.
    smRef.watchShellEnvState();
  }
  return sm;
}
