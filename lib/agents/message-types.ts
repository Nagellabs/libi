// ---------------------------------------------------------------------------
// Shared message types — used by both server (ProcessManager) and client (hooks)
// ---------------------------------------------------------------------------

import type { McpToolId } from "@/lib/agents/mcp-tool-id";

export interface AgentMessage {
  id: string;
  role: "user" | "agent";
  parts: AgentMessagePart[];
  timestamp: number;
  /** If true, this is a system-injected context message (hidden from UI) */
  isSystemContext?: boolean;
}

export type AgentMessagePart =
  | { type: "text"; text: string }
  | { type: "thought"; text: string }
  | {
      type: "tool-call";
      toolCallId: string;
      /** Canonical ID for MCP tools, null for built-in Claude Code tools
       *  (Read, Edit, Bash, ToolSearch, Task, …). */
      toolId: McpToolId | null;
      /** Raw `update.title` as received from ACP. Always set. Used only by
       *  `formatBuiltinTitle` for the built-in branch (when toolId is null). */
      rawTitle: string;
      args: unknown;
      /** Latest in-progress text the tool emitted via ACP `tool_call_update`
       *  notifications. Streamed live to give the user visibility into what
       *  long-running tools are doing instead of staring at a spinner. Null
       *  until the tool emits its first content chunk. */
      progress?: string | null;
      /** Unix ms timestamp set when this tool call first appears in the
       *  stream. Used by the chat UI to render an elapsed-time timer that
       *  survives reconnects (the client-side `Date.now()` is unreliable
       *  when the chat loses + restores its SSE connection mid-run). */
      startedAt?: number;
      /** Lifecycle: "pending" = announced but not observed executing (Claude
       *  Code runs batched MCP tools sequentially — announcement ≠ start);
       *  "running" = a real execution signal arrived (SDK heartbeat, job
       *  progress attach, or sequential inference). Cleared on completion —
       *  terminal state is derived from the paired tool-result part. */
      status?: "pending" | "running";
      /** Unix ms when the tool was first observed EXECUTING (may be
       *  backdated from the heartbeat's elapsedTimeSeconds). Timers render
       *  from this — never from startedAt (announce time). */
      runningAt?: number;
      /** Job id this tool call is backed by (if any). Set by the synthetic
       *  `agent-tool-progress` event from `notify.jobProgress`. */
      jobId?: string;
    }
  | {
      type: "tool-result";
      toolCallId: string;
      toolId: McpToolId | null;
      rawTitle: string;
      result: unknown;
      success: boolean;
      /** Unix ms when the completion was ingested. Duration = completedAt −
       *  call.runningAt (both must exist for a duration to render). */
      completedAt?: number;
    }
  | {
      type: "file-attachment";
      fileId: string;
      filename: string;
      contentType: string | null;
      size: number;
    }
  | {
      /** ACP `requestPermission` surfaced as a chat card. The card lets the
       *  user pick one of the offered options; the answer flows back to the
       *  held promise via POST /api/sessions/:sessionId/permission. The
       *  agent-side cancel/evict paths drain pending requests and emit a
       *  resolved event with `outcome.kind === "cancelled"`. */
      type: "permission-request";
      pendingId: string;
      toolCall: import("@agentclientprotocol/sdk").ToolCallUpdate;
      options: import("@agentclientprotocol/sdk").PermissionOption[];
      /** Why we surfaced the prompt — drives copy / styling. */
      reason: "acp" | "generation";
      /** "pending" until the agent emits `agent-permission-resolved`. */
      status: "pending" | "resolved";
      outcome?:
        | { kind: "selected"; optionId: string }
        | { kind: "cancelled" };
    }
  | {
      /** Dispatched sub-agent (Claude Code Task / Agent tool). */
      type: "subagent";
      /** The parent tool_use_id that dispatched this sub-agent. Used to
       *  match later completion events (queue-operation task-notifications). */
      toolCallId: string;
      /** "general-purpose", "Explore", "Plan", etc. */
      subagentType: string;
      /** Short user-facing label from the dispatch input. */
      description: string;
      /** Initial prompt sent to the sub-agent (truncated client-side for display). */
      prompt: string;
      /** "sonnet", "opus", "haiku" — when present in dispatch input. */
      model: string | null;
      /** True if the dispatch had `run_in_background: true`. */
      background: boolean;
      /** Wall-clock time of dispatch (ms). The card uses this to drive the
       *  timer. ABSENT on loadSession-replayed history — a replay-time stamp
       *  would be a lie, and the card shows no timer without it (falls back
       *  to `usage.durationMs` when the completion carried one). */
      startedAt?: number;
      /** State machine for the sub-agent's lifecycle. */
      status: "running" | "completed" | "failed" | "cancelled";
      /** Once completed, the agent's reply (raw string from <result>). */
      result: string | null;
      /** Once completed, usage stats. */
      usage: {
        totalTokens?: number;
        toolUses?: number;
        durationMs?: number;
      } | null;
      /** Optional opaque agentId from Claude Code's "Async agent launched" reply. */
      agentId: string | null;
      /** Latest in-progress activity text streamed via ACP `tool_call_update`
       *  while the sub-agent is running. Mirrors the `progress` field on
       *  `tool-call` parts — gives the user visibility into long-running
       *  sub-agent dispatches instead of a bare elapsed-time spinner. */
      progress?: string | null;
    };
