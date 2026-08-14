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
  currentAgentMessage: AgentMessage | null;
  currentUserMessage: AgentMessage | null;
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
   *  session re-activation). */
  isReplaying?: boolean;
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
