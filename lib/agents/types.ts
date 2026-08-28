import type { McpToolId } from "@/lib/agents/mcp-tool-id";

/** Events emitted by any agent provider */
export type AgentEvent =
  | { type: "agent-text"; text: string; isThought?: boolean }
  | {
      type: "agent-tool-call";
      toolCallId: string;
      toolId: McpToolId | null;
      rawTitle: string;
      args: unknown;
    }
  | {
      type: "agent-tool-result";
      toolCallId: string;
      toolId: McpToolId | null;
      rawTitle: string;
      result: unknown;
      success: boolean;
    }
  | {
      /** Live progress chunk for an in-flight tool call. The agent sends one
       *  whenever ACP `tool_call_update` arrives with status `pending` /
       *  `in_progress` and at least one text content block. `text` is the
       *  latest snapshot, not a delta — replace, don't append. */
      type: "agent-tool-progress";
      toolCallId: string;
      toolId: McpToolId | null;
      rawTitle: string;
      text: string;
      /** Optional job id when this progress event was synthesized from a
       *  `notify.jobProgress` call. Lets the UI map tool-call parts to
       *  their backing job (Stop button, ETA display). */
      jobId?: string;
    }
  | {
      /** A tool call was observed to actually START executing. */
      type: "agent-tool-status";
      toolCallId: string;
      status: "running";
      runningAt: number;
    }
  | {
      /** Subagent dispatch refinement. claude-agent-acp emits the initial
       *  `tool_call` for Task/Agent at content_block_start with empty
       *  `input`, then a `tool_call_update` with the full input once the
       *  assistant message finishes streaming. This event lets the UI
       *  patch the existing subagent part's description/prompt/model so
       *  the card stops showing "Task" and reflects the real dispatch. */
      type: "agent-subagent-refine";
      toolCallId: string;
      args: unknown;
      title: string | null;
    }
  | {
      /** Latest context/rate-limit usage for the session (ACP usage_update,
       *  parsed by lib/sessions/usage.ts). Snapshot, not a delta. */
      type: "agent-usage";
      usage: import("@/lib/sessions/usage").SessionUsageState;
    }
  | {
      /** Slash commands the agent currently advertises (ACP
       *  available_commands_update). Full replacement list. */
      type: "agent-commands";
      commands: import("@/lib/sessions/usage").AvailableCommandInfo[];
    }
  | {
      /** The session's ACP config options changed (config_option_update from
       *  the agent, or loadSession filling them on activation). Carries the
       *  derived model state in the GET /api/sessions/[id]/model response
       *  shape so the client patches its cache without a refetch. */
      type: "agent-config-options";
      model: import("@/lib/sessions/model-option").SessionModelSnapshot;
    }
  | { type: "agent-status"; status: string; error?: string }
  | { type: "agent-complete"; stopReason: string }
  | {
      /** A deterministic, system-authored note rendered as a finished
       *  message. Does NOT prompt the agent (no generation, no streaming
       *  state) — used for transparency notes like "[manual edit] …".
       *  `noteId` keeps it idempotent across reconnect/duplicate delivery. */
      type: "chat-note";
      text: string;
      noteId: string;
    }
  | {
      type: "agent-permission-request";
      pendingId: string;
      toolCall: import("@agentclientprotocol/sdk").ToolCallUpdate;
      options: import("@agentclientprotocol/sdk").PermissionOption[];
      /** Why we surfaced the prompt — used by the UI for hint copy. */
      reason: "acp" | "generation";
    }
  | {
      type: "agent-permission-resolved";
      pendingId: string;
      /** What was selected, or "cancelled" if the turn was cancelled. */
      outcome:
        | { kind: "selected"; optionId: string }
        | { kind: "cancelled" };
    }
  | {
      /**
       * Per-agent usability, as OBSERVED from the ACP handshake — never
       * inferred, never a credential probe (see lib/agents/agent-readiness.ts).
       *
       * Sessionless: it describes an AGENT, not a session, so SessionManager
       * broadcasts it on the SYSTEM channel alongside `standby-ready` rather
       * than routing it to a sessionId. It lives in this union anyway because
       * the SSE stream is the one wire the client parses, and every frame on
       * it is an AgentEvent shape to the reader.
       */
      type: "agent-readiness";
      agentId: string;
      readiness: import("@/lib/agents/agent-readiness").AgentReadiness;
    }
  | { type: "sessions-changed" };

/**
 * The readiness broadcast, named so SessionManager can widen its system-event
 * channel to carry it without `lib/sessions/types.ts#SystemEvent` having to
 * know about agent readiness.
 */
export type AgentReadinessEvent = Extract<AgentEvent, { type: "agent-readiness" }>;

/**
 * Why an agent can't be selected right now.
 *
 * Exists so an unavailable agent can be shown DISABLED WITH A REASON rather
 * than silently omitted from the selector: the Claude adapter is installed at
 * runtime (~306MB, see `lib/agents/runtime-install.ts`), so a first-boot user
 * waiting on that download would otherwise stare at a list their default agent
 * has simply vanished from, with the explanation reaching only
 * `~/.libi/logs/libi.log`.
 *
 * `code` is the machine-readable state; `message` is the short line the UI
 * renders verbatim. `detail` carries `pendingInstallReason()`'s own vocabulary
 * ("version drift (…)", "native binary missing") so the UI and the install
 * path describe the same tree in the same words instead of two parallel
 * dialects.
 */
export type AgentUnavailableCode =
  /** An install is running RIGHT NOW (the install lock is held and fresh). */
  | "installing"
  /** An install ran against this root and left a tree that cannot run. */
  | "install_failed"
  /** Nothing has been installed here, and nothing is running. */
  | "not_installed";

export interface AgentUnavailableReason {
  code: AgentUnavailableCode;
  /** Short, user-facing sentence. Safe to render verbatim. */
  message: string;
  /** `pendingInstallReason()` vocabulary verbatim, when a tree exists. */
  detail?: string;
}

/** Information about an available agent provider */
export interface AgentProviderInfo {
  id: string;
  name: string;
  type: "acp";
  /** true if CLI installed */
  available: boolean;
  requiresApiKey: boolean;
  /** true if key is set in env or settings */
  apiKeyConfigured: boolean;
  /** Capabilities advertised by the agent during initialize() — null if not yet connected */
  capabilities: { canListSessions: boolean };
  /** Set only when `available` is false — why, for the disabled selector row. */
  unavailableReason?: AgentUnavailableReason;
}

