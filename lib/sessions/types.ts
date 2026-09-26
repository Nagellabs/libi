import type { AgentEvent } from "@/lib/agents/types";
import type { AgentReadiness } from "@/lib/agents/agent-readiness";
import type { AgentMessage } from "@/lib/agents/message-types";
import type {
  PermissionOption,
  RequestPermissionResponse,
  SessionConfigOption,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import type {
  SessionUsageState,
  AvailableCommandInfo,
} from "@/lib/sessions/usage";

export interface PendingApproval {
  pendingId: string;
  toolCall: ToolCallUpdate;
  options: PermissionOption[];
  /** Why the prompt was surfaced (UI hint copy). Kept so the SSE route can
   *  re-announce the request on a (re)connect exactly as first sent. */
  reason?: "acp" | "extension";
  /** Resolves the ACP requestPermission promise. Idempotent — additional
   *  calls are no-ops because the entry is removed on first resolve. */
  resolve: (response: RequestPermissionResponse) => void;
  createdAt: number;
}

export interface SessionEntry {
  sessionId: string;
  agentId: string;
  title: string | null;
  updatedAt: string | null;
  active: boolean;
  lastUsed: number;
  messageCache: AgentMessage[];
  /** Message-ASSEMBLY cursor: the agent message incoming content appends to.
   *  NOT an in-flight flag — the event handler re-creates it for any late
   *  agent content, and a cancelled prompt's teardown nulls it while a steered
   *  successor is still running. Use `isSessionMidTurn` for "is it working". */
  currentAgentMessage: AgentMessage | null;
  currentUserMessage: AgentMessage | null;
  /** Prompts `sendMessage` has sent that have not settled yet. A count, not a
   *  flag: on the steer path turn 2 goes out before the cancelled turn 1
   *  resolves. Reset to 0 (and `promptEpoch` bumped) whenever the ACP session
   *  is dropped. Optional only because an entry built by an older class (the
   *  dev singleton across HMR) lacks it — see `isSessionMidTurn`. */
  promptsInFlight?: number;
  /** Bumped on every reset of `promptsInFlight`, so a prompt that settles
   *  after its session was torn down cannot decrement a newer count. */
  promptEpoch?: number;
  /** Wall-clock ms of the last LIVE update the agent sent (any session
   *  update; replay excluded). A cancelled prompt stops counting as in flight
   *  only after the session has been silent this long past
   *  CANCEL_SETTLE_TIMEOUT_MS, so a slow-but-working adapter stays busy. */
  lastAgentActivityAt?: number;
  listeners: Set<(event: AgentEvent) => void>;
  /** Permission requests awaiting user decision. Keyed by pendingId. */
  pendingApprovals: Map<string, PendingApproval>;
  /** Set by libi.restart_acp_session — instructs the SessionManager to reload
   *  this session's ACP connection after the current prompt unwinds. */
  reloadPending?: boolean;
  /** ACP session config options from new/load session (contains the `model`
   *  select when the agent advertises one). Used to render the model picker. */
  configOptions: SessionConfigOption[];
  /** Latest ACP usage_update state (context tokens / cost / rate limits).
   *  In-memory only — null until the first usage_update of a turn. */
  latestUsage: SessionUsageState | null;
  /** Slash commands advertised via available_commands_update. Re-sent by
   *  the adapter on new/load/resume, so this recovers on activation. */
  availableCommands: AvailableCommandInfo[];
  /** ACP `result.modes?.availableModes` captured at fresh newSession / standby
   *  creation. Cached so user-driven mode broadcasts, standby claims, and
   *  post-loadSession re-pushes never push an unadvertised ACP mode id blind
   *  (the codex -32602 bug). Undefined until the fresh-newSession path
   *  captures it. */
  availableModes?: { id: string }[];
  /** True while loadSession() replays history through the event handler.
   *  Replayed tool calls get no timestamps/status — a replay-time
   *  Date.now() would be a lie (QA 2026-07-04: bogus timers after
   *  session re-activation). It also keeps the replay's message content off
   *  the SSE: the replay builds the cache the history fetch returns, and an
   *  open chat shown it live adopted it as a turn nothing ends (a stale "▍",
   *  2026-09-25). Not only a timestamp switch — don't narrow it to one. */
  isReplaying?: boolean;
  /** False when the agent process this session runs on was spawned while the desktop app had not
   *  loaded the user's shell environment — its chat shows a warning. Set when the session becomes
   *  active; unset on a history entry that has never been activated. */
  shellEnvLoaded?: boolean;
  /** The agent answered `session/load` with "no such session": its transcript is gone. Set once;
   *  later activations throw `AgentHistoryMissingError` without asking the agent again. In memory
   *  only, so a transcript the user restores is picked up after libi restarts. */
  historyMissing?: boolean;
}

/** A group of sessions under a day header for the sidebar UI */
export interface SessionGroup {
  label: string; // "Today", "Yesterday", or date string like "Apr 15"
  sessions: SessionEntry[];
}

/** Listener that receives events for ALL sessions (tagged with sessionId) */
export type GlobalSessionEventListener = (
  sessionId: string,
  event: AgentEvent
) => void;

/** System-level events that aren't scoped to a single session — broadcast to
 *  every connected SSE client so the UI can react to things like the
 *  pre-warmed standby becoming available again. */
export type SystemEvent =
  | { type: "standby-ready"; ready: boolean }
  /**
   * An agent's usability changed — most importantly, it answered an auth
   * challenge negatively. This is the channel that stops `standby-ready:false`
   * from being the ONLY signal of a failed agent switch: on its own it made the
   * sidebar render a permanently disabled "+" tooltipped "Preparing a new chat
   * session…", asserting progress that could never complete. See
   * lib/agents/agent-readiness.ts.
   */
  | { type: "agent-readiness"; agentId: string; readiness: AgentReadiness }
  | { type: "instructions_updated"; sessionsTerminated: number }
  | {
      /** Active sessions were force-deactivated to pick up an MCP config
       *  refresh (e.g. post-prewarm). The UI can prompt the user to retry
       *  any in-flight message — the connection will be re-attached
       *  automatically on the next interaction. */
      type: "active-sessions-refreshed";
      reason: string;
      sessionIds: string[];
    };

/** Maximum concurrent active sessions (LRU eviction beyond this) */
export const MAX_ACTIVE_SESSIONS = 10;

/**
 * Is this session mid-turn — a prompt sent and not yet settled?
 * Read by LRU eviction (never evict a working session) and by the SSE route on
 * every (re)connect (announce a working session as busy, not idle —
 * app/api/agent/events/route.ts).
 *
 * The signal is `promptsInFlight`, maintained by `sendMessage` around
 * `conn.prompt`. `currentAgentMessage` is consulted ONLY for an entry that has
 * no counter at all (built by an older class the dev server kept across HMR),
 * and never OR-ed with it: the cursor is re-created by late content, so
 * trusting it alongside the counter would bring back a Stop button that
 * cancels nothing.
 */
export function isSessionMidTurn(entry: SessionEntry | undefined): boolean {
  if (!entry || !entry.active) return false;
  if (typeof entry.promptsInFlight === "number") return entry.promptsInFlight > 0;
  return entry.currentAgentMessage != null;
}

/**
 * Mark the cached copy of an approval card resolved. The card is part of the
 * session's history (`SessionEventHandler.handlePermissionRequest` caches it)
 * so a reload brings back a pending one; every path that answers or drops the
 * request must also close the cached card, or a reload would offer an
 * answerable card for a request that no longer exists. Tolerates an entry
 * without a cache. No-op for an unknown `pendingId`.
 */
export function markPermissionResolvedInCache(
  entry: { messageCache?: AgentMessage[] },
  pendingId: string,
  outcome: { kind: "selected"; optionId: string } | { kind: "cancelled" },
): void {
  for (const msg of entry.messageCache ?? []) {
    const idx = msg.parts.findIndex(
      (p) => p.type === "permission-request" && p.pendingId === pendingId,
    );
    if (idx === -1) continue;
    const part = msg.parts[idx];
    if (part.type !== "permission-request") return;
    msg.parts[idx] = { ...part, status: "resolved", outcome };
    return;
  }
}
