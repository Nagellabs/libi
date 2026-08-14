import {
  type Client,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import type { AgentEvent } from "./types";
import type { AgentMessage, AgentMessagePart } from "./message-types";
import type { ManagedProcess } from "./managed-types";
import type { SessionEntry } from "@/lib/sessions/types";
import {
  isSubagentDispatch,
  parseSubagentDispatch,
  parseSubagentCompletion,
  extractAgentId,
} from "@/lib/agents/subagent-detector";
import { applyAttachmentParsing } from "@/lib/agents/parse-attachments";
import { getApprovalMode } from "@/lib/approval/settings";
import { isGenerationTool } from "@/lib/approval/generation";
import { serverLogger as logger } from "@/lib/logger";
import {
  jobProgressEmitter,
  type JobProgressPayload,
} from "@/lib/jobs/progress-emitter";
import { getJobManager } from "@/lib/jobs/manager";
import { fromAnyToolName, type McpToolId } from "@/lib/agents/mcp-tool-id";
import {
  getJobKindToToolIdsMap,
  getRunner,
} from "@/lib/jobs/runners/registry";
import { getNotificationsSetting } from "@/lib/db/settings";
import { pushIfBackgrounded } from "@/mcp/notify";
import { applyUsageUpdate, toAvailableCommands } from "@/lib/sessions/usage";

// usage_update is @experimental — on drift we keep the previous state and
// warn ONCE per session (spec: never spam the log at stream rate).
const usageParseWarnedSessions = new Set<string>();

// ---------------------------------------------------------------------------
// Permission decision helper
//
// Pure — extracted so unit tests can exercise the decision matrix without
// instantiating the full handler. Returns either an "auto-allow" verdict
// (with the optionId to select) or a "prompt" verdict (with the reason
// for UI hint copy).
// ---------------------------------------------------------------------------

export type PermissionAction =
  | { kind: "auto-allow"; optionId: string }
  | { kind: "prompt"; reason: "acp" | "generation" };

/**
 * Decide what to do with an ACP permission request based on the agent's
 * saved approval mode and whether the tool is a paid generation MCP.
 *
 * Tool name extraction: claude-agent-acp's `toolInfoFromToolUse` falls
 * through to a default branch for any tool it doesn't have a custom case
 * for (including all `mcp__server__tool` names), and that branch sets
 * `toolCall.title = toolUse.name`. So for MCP tools, `title` IS the
 * canonical `mcp__server__tool` identifier — exactly what
 * `isGenerationTool` matches against. For built-in tools (Read, Edit,
 * Bash, …), `title` is a human-readable label that doesn't start with
 * `mcp__`, so `isGenerationTool` correctly returns false.
 *
 * We also fall back to `rawInput?.name` if for any reason `title` is
 * absent — newer claude-agent-acp builds may shift the field, and other
 * ACP agents (codex) may not run through `toolInfoFromToolUse`
 * at all.
 */
type ToolMeta = {
  toolId: McpToolId | null;
  rawName: string;
};

function extractToolMeta(req: RequestPermissionRequest): ToolMeta {
  const tc = req.toolCall as Partial<{
    title: string | null;
    rawInput: Record<string, unknown> | null;
  }>;
  // Tool name extraction: claude-agent-acp's `toolInfoFromToolUse` falls
  // through to a default branch for any tool it doesn't have a custom case
  // for (including all `mcp__server__tool` names), and that branch sets
  // `toolCall.title = toolUse.name`. So for MCP tools, `title` IS the
  // canonical `mcp__server__tool` identifier — exactly what
  // `isGenerationTool` matches against. For built-in tools (Read, Edit,
  // Bash, …), `title` is a human-readable label that doesn't start with
  // `mcp__`, so `isGenerationTool` correctly returns false.
  //
  // We also fall back to `rawInput?.name` if for any reason `title` is
  // absent — newer claude-agent-acp builds may shift the field, and other
  // ACP agents (codex) may not run through `toolInfoFromToolUse`
  // at all.
  const rawName =
    typeof tc.title === "string" && tc.title.length > 0
      ? tc.title
      : typeof tc.rawInput?.name === "string"
        ? (tc.rawInput.name as string)
        : "";
  const toolId = fromAnyToolName(rawName);
  return { toolId, rawName };
}

export async function decidePermissionAction(
  agentId: string,
  request: RequestPermissionRequest,
): Promise<PermissionAction> {
  const mode = getApprovalMode(agentId);
  const meta = extractToolMeta(request);
  const isGen = isGenerationTool(meta.toolId);
  const allowOpt = request.options.find(
    (o) => o.kind === "allow_once" || o.kind === "allow_always",
  );

  if (mode === "ask") {
    return { kind: "prompt", reason: isGen ? "generation" : "acp" };
  }

  if (isGen && mode !== "auto-with-generations") {
    return { kind: "prompt", reason: "generation" };
  }

  if (allowOpt) return { kind: "auto-allow", optionId: allowOpt.optionId };

  return { kind: "prompt", reason: "acp" };
}

// ---------------------------------------------------------------------------
// SessionEventHandler
//
// Translates raw ACP SessionNotification events into AgentEvents and builds
// the in-memory message cache. Used by SessionManager.
//
// Dependencies are injected at construction time to avoid circular imports:
//   - msgCounter  — monotonic ID generator shared with the SessionManager
//   - emit        — routes events to the right session's listeners
//   - lookupSession — finds the SessionEntry for a given sessionId
// ---------------------------------------------------------------------------

export class SessionEventHandler {
  /** Removes the active job-progress subscription, if any. Set by
   *  `attachJobProgressBridge`; called automatically when the bridge is
   *  re-attached (HMR safety) so we don't accumulate stale listeners. */
  private detachJobProgress: (() => void) | null = null;

  constructor(
    private readonly msgCounter: { next: () => number },
    private readonly emit: (sessionId: string, event: AgentEvent) => void,
    private readonly lookupSession: (
      sessionId: string,
    ) => SessionEntry | undefined,
    /** Fallback for available_commands_update arriving before a SessionEntry
     *  exists — claude-agent-acp advertises commands ~0ms after newSession()
     *  returns, which for the STANDBY session is long before claim. The
     *  SessionManager stashes them on the standby record so the claimed
     *  entry starts with a populated palette. */
    private readonly stashOrphanCommands?: (
      sessionId: string,
      commands: import("@/lib/sessions/usage").AvailableCommandInfo[],
    ) => void,
  ) {}

  /**
   * Subscribe to `jobProgressEmitter` and synthesize an `agent-tool-progress`
   * event on the session whose tool-call (or subagent) part matches the
   * payload's `toolCallId`. Called from SessionManager during setup.
   *
   * The `findSessionByToolCallId` callback walks the manager's session map.
   * Idempotent: re-attaching detaches the previous subscription first so HMR
   * doesn't double-emit.
   */
  attachJobProgressBridge(
    findSessionByToolCallId: (toolCallId: string) => SessionEntry | undefined,
    findInProgressToolCall?: (
      toolIds: McpToolId[],
      toolArgs: unknown | undefined,
    ) => { session: SessionEntry; toolCallId: string } | undefined,
  ): void {
    if (this.detachJobProgress) {
      this.detachJobProgress();
      this.detachJobProgress = null;
    }

    // Cache the kind→toolId[] map at attach time (rebuilt on subsequent
    // attaches for HMR).
    const kindMap = getJobKindToToolIdsMap();

    const handler = (payload: JobProgressPayload) => {
      // Resolve toolCallId. JobManager sets it on the payload IF
      // `attachToolCallId(jobId, toolCallId)` was called. The MCP child
      // doesn't know its own toolCallId, so the first progress tick arrives
      // without one — fall back to a kind→toolId[] lookup against the
      // session cache, then attach the discovered toolCallId to JobManager
      // so subsequent ticks for the same job route directly.
      let toolCallId: string | undefined = payload.toolCallId;
      let session: SessionEntry | undefined;
      // Try the threaded toolCallId first. NOTE: `payload.toolCallId` may
      // actually be an MCP `progressToken` (a per-request incrementing
      // integer like "1", "2", "3" set by claude-agent-acp) — it is NOT
      // guaranteed to equal an ACP toolCallId. If lookup by it fails (which
      // it will for progressTokens), fall through to the kind→canonical-id
      // fallback below.
      if (toolCallId) {
        session = findSessionByToolCallId(toolCallId);
        if (!session) {
          // The threaded value didn't resolve — it was probably a
          // progressToken, not a real toolCallId. Clear it so the fallback
          // can resolve the REAL toolCallId from the cache.
          toolCallId = undefined;
        }
      }
      if (!session && findInProgressToolCall) {
        // Candidate tool ids: prefer the exact hint toolName; fall back to
        // the runner-registry kind map.
        const hintId = payload.toolName ? fromAnyToolName(payload.toolName) : null;
        const ids = hintId ? [hintId] : (kindMap.get(payload.kind) ?? []);
        const match = ids.length > 0 ? findInProgressToolCall(ids, payload.toolArgs) : undefined;
        if (match) {
          session = match.session;
          toolCallId = match.toolCallId;
          try {
            getJobManager().attachToolCallId(payload.jobId, toolCallId);
          } catch (err) {
            logger.warn(
              {
                tag: "session-event-handler",
                op: "attach_tool_call_id_failed",
                jobId: payload.jobId,
                err: err instanceof Error ? err.message : String(err),
              },
              "Failed to attach toolCallId to JobManager",
            );
          }
        }
      }
      if (!session || !toolCallId) return;
      const text = formatJobProgressText(payload);
      // Patch the message cache so a fresh /api/agent/messages fetch
      // (e.g. after page refresh) returns the latest progress + jobId.
      const agentMsg = this.findAgentMessageWithToolCall(session, toolCallId);
      if (agentMsg) {
        const idx = agentMsg.parts.findIndex(
          (p) =>
            (p.type === "tool-call" || p.type === "subagent") &&
            p.toolCallId === toolCallId,
        );
        if (idx !== -1) {
          const old = agentMsg.parts[idx];
          if (old.type === "tool-call") {
            agentMsg.parts[idx] = {
              ...old,
              progress: text,
              jobId: payload.jobId,
            };
          } else if (old.type === "subagent") {
            agentMsg.parts[idx] = { ...old, progress: text };
          }
        }
      }
      // A job progress tick IS an execution signal for this tool call.
      this.markToolCallRunning(session.sessionId, session, toolCallId, Date.now());
      this.emit(session.sessionId, {
        type: "agent-tool-progress",
        toolCallId,
        toolId: null,
        rawTitle: "",
        text,
        jobId: payload.jobId,
      });
    };
    jobProgressEmitter.on("job_progress", handler);

    // ── Terminal-event bridge → push notifications ─────────────────────────
    // Fire a system notification when a job ends (completed or failed)
    // IF:
    //   1. the user enabled `backgroundJobComplete` in Settings → Notifications
    //   2. the run took >10s wallclock (short tasks don't warrant a push)
    //   3. the runner declares an `mcpToolId` (i.e., it has a chat surface —
    //      proxy_gen / export_render etc. are internal and shouldn't notify).
    // `pushIfBackgrounded` itself no-ops when the window is focused.
    const mgr = getJobManager();
    const handleTerminal = async (
      status: "completed" | "failed",
      jobId: string,
      errorMessage: string | null,
    ): Promise<void> => {
      try {
        if (!getNotificationsSetting().backgroundJobComplete) return;

        const snapshot = await mgr.getStatus(jobId);
        if (!snapshot.startedAt || !snapshot.completedAt) return;
        const durationMs =
          snapshot.completedAt.getTime() - snapshot.startedAt.getTime();
        if (durationMs < 10_000) return;

        const runner = getRunner(snapshot.kind);
        if (!runner?.mcpToolId) return;

        const title = prettyTitleForKind(snapshot.kind, status);
        const body =
          status === "failed"
            ? errorMessage ?? "Failed — open libi to review."
            : "Done — open libi to review.";

        void pushIfBackgrounded({ title, body, jobId });
      } catch (err) {
        logger.warn(
          {
            tag: "session-event-handler",
            op: "terminal_notify_failed",
            jobId,
            status,
            err: err instanceof Error ? err.message : String(err),
          },
          "Failed to push completion notification",
        );
      }
    };

    const completionHandler = (payload: {
      jobId: string;
      result?: unknown;
    }): void => {
      void handleTerminal("completed", payload.jobId, null);
    };
    const failureHandler = (payload: {
      jobId: string;
      error: string;
    }): void => {
      void handleTerminal("failed", payload.jobId, payload.error);
    };
    mgr.on("completed", completionHandler);
    mgr.on("failed", failureHandler);

    this.detachJobProgress = () => {
      jobProgressEmitter.off("job_progress", handler);
      mgr.off("completed", completionHandler);
      mgr.off("failed", failureHandler);
    };
  }

  // -------------------------------------------------------------------------
  // ACP Client factory
  // -------------------------------------------------------------------------

  /**
   * Returns the ACP Client handler for a ManagedProcess.
   * Routes session/update notifications via knownSessionIds on the process.
   */
  createClient(managed: ManagedProcess): Client {
    return {
      sessionUpdate: async (params: SessionNotification): Promise<void> => {
        if (managed.knownSessionIds.has(params.sessionId)) {
          this.handleSessionUpdate(params.sessionId, params);
        }
      },

      requestPermission: async (
        params: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> => {
        return await this.handlePermissionRequest(params);
      },
    };
  }

  // -------------------------------------------------------------------------
  // Session update routing
  // -------------------------------------------------------------------------

  /**
   * Maps ACP SessionUpdate variants to AgentEvents and builds AgentMessage
   * objects in the RAM cache. Called both during live streaming and loadSession
   * history replay.
   */
  handleSessionUpdate(sessionId: string, params: SessionNotification): void {
    const update = params.update;
    const session = this.lookupSession(sessionId);

    switch (update.sessionUpdate) {
      case "user_message_chunk": {
        // During loadSession replay the agent streams user messages back.
        // Build them into the cache so the full conversation is available.
        if (session && update.content.type === "text") {
          const userMsg = this.ensureUserMessage(session);
          const parts = userMsg.parts;
          const last = parts[parts.length - 1];
          if (last && last.type === "text") {
            (last as { type: "text"; text: string }).text +=
              update.content.text;
          } else {
            parts.push({ type: "text", text: update.content.text });
          }
        }
        break;
      }

      case "agent_message_chunk": {
        if (update.content.type === "text") {
          const text = update.content.text;
          this.emit(sessionId, { type: "agent-text", text });

          if (session) {
            const agentMsg = this.ensureAgentMessage(session);
            const parts = agentMsg.parts;
            const last = parts[parts.length - 1];
            if (last && last.type === "text") {
              (last as { type: "text"; text: string }).text += text;
            } else {
              parts.push({ type: "text", text });
            }
          }
        }
        break;
      }

      case "agent_thought_chunk": {
        if (update.content.type === "text") {
          const text = update.content.text;

          this.emit(sessionId, {
            type: "agent-text",
            text,
            isThought: true,
          });

          if (session) {
            const agentMsg = this.ensureAgentMessage(session);
            const parts = agentMsg.parts;
            const last = parts[parts.length - 1];
            if (last && last.type === "thought") {
              (last as { type: "thought"; text: string }).text += text;
            } else {
              parts.push({ type: "thought", text });
            }
          }
        }
        break;
      }

      case "tool_call": {
        const rawTitle = update.title;
        const toolId = fromAnyToolName(rawTitle);
        const toolCallId = update.toolCallId;

        // Subagent dispatch — Task / Agent. On LIVE invocation rawInput
        // includes description/prompt/subagent_type so we get a rich
        // SubagentCard. On REPLAY, claude-agent-acp omits rawInput
        // (we observed `args: {}` for Task tools in loadSession output),
        // so `parseSubagentDispatch` returns null. We still want a
        // SubagentCard then — fall back to a minimal subagent part with
        // the tool name as the description so the UI shows "Task" with
        // the elapsed timer rather than nesting it among regular tool
        // calls and dumping its JSON result inline.
        //
        // Passing rawInput to `isSubagentDispatch` also catches the case
        // where claude-agent-acp uses the dispatch's `description` as
        // the tool title — the title becomes "Describe video keyframes"
        // instead of "Task" and the name-only check would miss.
        if (isSubagentDispatch(rawTitle, update.rawInput)) {
          const parsed = parseSubagentDispatch(update.rawInput);
          this.emit(sessionId, {
            type: "agent-tool-call",
            toolCallId,
            toolId,
            rawTitle,
            args: update.rawInput,
          });
          if (session) {
            const agentMsg = this.ensureAgentMessage(session);
            // Replay: no startedAt — a replay-time stamp is a lie and made
            // historical Task cards show a fresh ~0s "duration". The card
            // renders no timer without it (uses usage.durationMs when the
            // replayed completion carries one).
            const stamp = session.isReplaying ? {} : { startedAt: Date.now() };
            const subagentPart: Extract<AgentMessagePart, { type: "subagent" }> =
              parsed
                ? {
                    type: "subagent",
                    toolCallId,
                    subagentType: parsed.subagentType,
                    description: parsed.description,
                    prompt: parsed.prompt,
                    model: parsed.model,
                    background: parsed.background,
                    ...stamp,
                    status: "running",
                    result: null,
                    usage: null,
                    agentId: null,
                  }
                : {
                    type: "subagent",
                    toolCallId,
                    subagentType: "unknown",
                    description: rawTitle, // "Task" or "Agent"
                    prompt: "",
                    model: null,
                    background: false,
                    ...stamp,
                    status: "running",
                    result: null,
                    usage: null,
                    agentId: null,
                  };
            agentMsg.parts.push(subagentPart);
          }
          break;
        }

        this.emit(sessionId, {
          type: "agent-tool-call",
          toolCallId,
          toolId,
          rawTitle,
          args: update.rawInput,
        });

        if (session) {
          const agentMsg = this.ensureAgentMessage(session);
          // Stamp jobId at ingest time if JobManager already has one attached
          // for this toolCallId. This handles the race where the MCP tool's
          // POST /api/jobs lands (and attaches the toolCallId to a jobId)
          // BEFORE the ACP `tool_call` event reaches us — without this, the
          // tool-call entry would have `jobId: null` and the chat UI would
          // never show a Stop button for runners that emit no early progress
          // (model downloads, opaque subprocesses).
          const replaying = session.isReplaying === true;
          let jobIdForCache: string | undefined;
          if (!replaying) {
            try {
              jobIdForCache =
                getJobManager().getJobIdForToolCallId(toolCallId) ?? undefined;
            } catch (err) {
              logger.warn(
                {
                  tag: "session-event-handler",
                  op: "ingest_jobid_lookup_failed",
                  toolCallId,
                  err: err instanceof Error ? err.message : String(err),
                },
                "getJobIdForToolCallId threw during tool_call ingest",
              );
            }
          }
          agentMsg.parts.push({
            type: "tool-call",
            toolCallId,
            toolId,
            rawTitle,
            args: update.rawInput,
            ...(replaying ? {} : { startedAt: Date.now(), status: "pending" as const }),
            ...(jobIdForCache && !replaying ? { jobId: jobIdForCache } : {}),
          });
        }
        break;
      }

      case "tool_call_update": {
        // In-progress updates: ACP servers (and Claude Code's wrappers)
        // stream content blocks as the tool executes. Forward those as
        // progress events so the UI can show what the tool is doing live.
        if (update.status !== "completed" && update.status !== "failed") {
          // Subagent dispatches arrive in two phases from claude-agent-acp:
          //   1) `tool_call` at content_block_start with EMPTY input (no
          //      description yet) — we create a placeholder subagent
          //      part with description="Task".
          //   2) `tool_call_update` after the assistant message finishes
          //      streaming — `rawInput` and `title` now carry the full
          //      dispatch payload (subagent_type, description, prompt,
          //      model). This is our chance to refine the part so the
          //      card stops saying "Task" and shows the real description.
          // Without this refinement the part stays as "Task running …"
          // forever, both in the live UI and in the cached message log
          // served on page refresh.
          const carriesContent =
            extractProgressText(update.content ?? null) !== null;
          if (session && (update.status === "in_progress" || carriesContent)) {
            // Direct execution signal FOR THIS toolCallId: an SDK heartbeat
            // (status in_progress, possibly with elapsedTimeSeconds) or a
            // content-bearing progress update.
            const meta = (update as {
              _meta?: { claudeCode?: { toolResponse?: { elapsedTimeSeconds?: number } } };
            })._meta;
            const elapsedS = meta?.claudeCode?.toolResponse?.elapsedTimeSeconds;
            const runningAt =
              typeof elapsedS === "number"
                ? Date.now() - Math.round(elapsedS * 1000)
                : Date.now();
            this.markToolCallRunning(sessionId, session, update.toolCallId, runningAt);
          } else if (session) {
            // Refinement update (no status, no content): the assistant
            // message finished streaming — execution begins now. Flip the
            // OLDEST pending call in the holding message.
            const holder = this.findAgentMessageWithToolCall(session, update.toolCallId);
            if (holder) this.markOldestPendingRunning(sessionId, session, holder);
          }

          const refined = this.refineSubagentFromUpdate(
            session,
            update.toolCallId,
            update.rawInput,
            update.title,
          );
          if (refined) {
            this.emit(sessionId, {
              type: "agent-subagent-refine",
              toolCallId: update.toolCallId,
              args: update.rawInput,
              title: update.title ?? null,
            });
          }

          const progressText = extractProgressText(update.content ?? null);
          if (progressText !== null) {
            this.emit(sessionId, {
              type: "agent-tool-progress",
              toolCallId: update.toolCallId,
              toolId: fromAnyToolName(update.title ?? ""),
              rawTitle: update.title ?? "",
              text: progressText,
            });
            // Patch the message cache so a fresh /api/agent/messages
            // fetch (e.g. after page refresh) returns the latest
            // progress with the call. The matching part might be a
            // `tool-call` (regular tool) OR a `subagent` (Task/Agent
            // dispatch) — both carry an optional `progress` field.
            if (session) {
              const agentMsg = this.findAgentMessageWithToolCall(
                session,
                update.toolCallId,
              );
              if (agentMsg) {
                const idx = agentMsg.parts.findIndex(
                  (p) =>
                    (p.type === "tool-call" || p.type === "subagent") &&
                    p.toolCallId === update.toolCallId,
                );
                if (idx !== -1) {
                  const old = agentMsg.parts[idx];
                  if (old.type === "tool-call" || old.type === "subagent") {
                    agentMsg.parts[idx] = { ...old, progress: progressText };
                  }
                }
              }
            }
          }
          break;
        }

        // status === "completed" || status === "failed" — emit final result.
        const rawTitle = update.title ?? "";
        const toolId = fromAnyToolName(rawTitle);
        const result = update.rawOutput;

        // Detect subagent completions by either name OR by checking
        // whether the cache already holds a subagent part with this
        // toolCallId (the dispatch path may have classified it via the
        // shape-based detector and the name alone wouldn't match).
        const subagentInCache =
          session !== undefined &&
          this.findAgentMessageWithToolCall(session, update.toolCallId)
            ?.parts.some(
              (p) =>
                p.type === "subagent" && p.toolCallId === update.toolCallId,
            ) === true;
        if (isSubagentDispatch(rawTitle) || subagentInCache) {
          this.emit(sessionId, {
            type: "agent-tool-result",
            toolCallId: update.toolCallId,
            toolId,
            rawTitle,
            result,
            success: update.status === "completed",
          });
          if (session) {
            // Search the entire cache, not just `currentAgentMessage` —
            // a long-running sub-agent may have started in an earlier
            // turn (and the agent moved on to a new message before the
            // completion arrived).
            const agentMsg =
              this.findAgentMessageWithToolCall(session, update.toolCallId) ??
              this.ensureAgentMessage(session);
            const idx = agentMsg.parts.findIndex(
              (p) => p.type === "subagent" && p.toolCallId === update.toolCallId,
            );
            if (idx !== -1) {
              const old = agentMsg.parts[idx] as Extract<
                AgentMessagePart,
                { type: "subagent" }
              >;
              const text = typeof result === "string" ? result : JSON.stringify(result);
              const completion = parseSubagentCompletion(text);
              if (completion) {
                agentMsg.parts[idx] = {
                  ...old,
                  status: completion.status,
                  result: completion.result,
                  usage: completion.usage,
                };
              } else {
                const agentId = extractAgentId(text);
                // Background dispatches reply with an agentId ack
                // ("Async agent launched. agentId: …") that ARRIVES with
                // status=completed but is NOT actually a completion —
                // the agent keeps running and the real notification
                // lands later. Keep status="running" in that case so
                // the card doesn't prematurely flip.
                const isBackgroundAck =
                  agentId !== null &&
                  (old.background || /async\s+agent\s+launched/i.test(text));
                if (isBackgroundAck) {
                  agentMsg.parts[idx] = { ...old, agentId };
                } else {
                  // Real foreground completion without a task-notification
                  // block (raw text reply, or replay shape). Flip status
                  // off "running" so the card doesn't sit forever with a
                  // spinner, and stash the reply text for the expanded view.
                  const finalStatus: typeof old.status =
                    update.status === "completed" ? "completed" : "failed";
                  agentMsg.parts[idx] = {
                    ...old,
                    status: finalStatus,
                    result: text || old.result,
                    ...(agentId ? { agentId } : {}),
                  };
                }
              }
            }
          }
          break;
        }

        this.emit(sessionId, {
          type: "agent-tool-result",
          toolCallId: update.toolCallId,
          toolId,
          rawTitle,
          result,
          success: update.status === "completed",
        });

        if (session) {
          const holder =
            this.findAgentMessageWithToolCall(session, update.toolCallId) ??
            this.ensureAgentMessage(session);
          holder.parts.push({
            type: "tool-result",
            toolCallId: update.toolCallId,
            toolId,
            rawTitle,
            result,
            success: update.status === "completed",
            ...(session.isReplaying ? {} : { completedAt: Date.now() }),
          });
          // Clear the call part's transient status (terminal state = result present).
          const callIdx = holder.parts.findIndex(
            (p) => p.type === "tool-call" && p.toolCallId === update.toolCallId,
          );
          if (callIdx !== -1) {
            const call = holder.parts[callIdx] as Extract<
              AgentMessagePart,
              { type: "tool-call" }
            >;
            if (call.status !== undefined) {
              const { status: _s, ...rest } = call;
              holder.parts[callIdx] = rest as AgentMessagePart;
            }
          }
          // Sequential execution: the next queued sibling starts now.
          this.markOldestPendingRunning(sessionId, session, holder);
        }
        break;
      }

      case "usage_update": {
        if (session) {
          const next = applyUsageUpdate(session.latestUsage, update);
          if (next !== session.latestUsage && next !== null) {
            session.latestUsage = next;
            this.emit(sessionId, { type: "agent-usage", usage: next });
          } else if (next === session.latestUsage && !usageParseWarnedSessions.has(sessionId)) {
            // applyUsageUpdate returns the SAME reference only on malformed
            // input (valid updates always build a fresh object).
            usageParseWarnedSessions.add(sessionId);
            logger.warn(
              { tag: "session-manager", op: "usage_parse_failed", sessionId },
              "malformed usage_update ignored (experimental ACP field drift?)",
            );
          }
        }
        break;
      }

      case "available_commands_update": {
        const commands = toAvailableCommands(update);
        if (session) {
          session.availableCommands = commands;
          this.emit(sessionId, { type: "agent-commands", commands });
        } else {
          // No SessionEntry yet (standby session pre-claim) — let the
          // SessionManager stash them for the eventual claim.
          this.stashOrphanCommands?.(sessionId, commands);
        }
        break;
      }

      // Informational updates — not surfaced to the UI
      case "plan":
      case "plan_update":
      case "plan_removed":
      case "current_mode_update":
      case "config_option_update":
      case "session_info_update":
        break;

      default: {
        const _exhaustive: never = update;
        logger.warn(
          {
            tag: "acp",
            op: "unknown_session_update",
            sessionId,
            sessionUpdate: (_exhaustive as { sessionUpdate: string }).sessionUpdate,
          },
          "Unknown ACP session update type",
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Permission handling
  // -------------------------------------------------------------------------

  /**
   * Mode-aware permission dispatch. Auto-allows when the agent's approval
   * mode permits; otherwise registers a pending entry on the session and
   * surfaces an `agent-permission-request` event so the UI can show a card.
   * The promise resolves later when the user picks an option (via
   * `POST /api/sessions/[sessionId]/permission`) or when the session is
   * cancelled (handled by SessionManager — see Task 4).
   */
  async handlePermissionRequest(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const sessionId = params.sessionId;
    const session = this.lookupSession(sessionId);

    // Defensive: unknown session — preserve the previous best-effort behavior
    // (pick first allow option, else first option, else empty string) so the
    // agent doesn't hang on a request we can't route.
    if (!session) {
      logger.warn(
        { sessionId: params.sessionId, toolCallId: params.toolCall?.toolCallId },
        "permission request for unknown session — falling back to first allow option",
      );
      const allow = params.options.find(
        (o) => o.kind === "allow_once" || o.kind === "allow_always",
      );
      const optionId = allow?.optionId ?? params.options[0]?.optionId ?? "";
      return { outcome: { outcome: "selected", optionId } };
    }

    const action = await decidePermissionAction(session.agentId, params);

    if (action.kind === "auto-allow") {
      return { outcome: { outcome: "selected", optionId: action.optionId } };
    }

    return new Promise<RequestPermissionResponse>((resolve) => {
      const pendingId = randomUUID();
      session.pendingApprovals.set(pendingId, {
        pendingId,
        toolCall: params.toolCall,
        options: params.options,
        resolve,
        createdAt: Date.now(),
      });
      this.emit(sessionId, {
        type: "agent-permission-request",
        pendingId,
        toolCall: params.toolCall,
        options: params.options,
        reason: action.reason,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Message cache helpers
  // -------------------------------------------------------------------------

  /**
   * Ensures an agent message exists in the cache for appending content.
   * Also finalizes any in-progress user message (turn boundary).
   */
  ensureAgentMessage(session: SessionEntry): AgentMessage {
    // Turn boundary — clean and finalize the user message
    if (session.currentUserMessage) {
      this.cleanUserMessageParts(session.currentUserMessage);
    }
    session.currentUserMessage = null;

    if (!session.currentAgentMessage) {
      const msg: AgentMessage = {
        id: `agent_${Date.now()}_${this.msgCounter.next()}`,
        role: "agent",
        parts: [],
        timestamp: Date.now(),
      };
      session.currentAgentMessage = msg;
      session.messageCache.push(msg);
    }
    return session.currentAgentMessage;
  }

  /**
   * Ensures a user message exists in the cache for appending content.
   * Also finalizes any in-progress agent message (turn boundary).
   */
  ensureUserMessage(session: SessionEntry): AgentMessage {
    // Turn boundary — finalize the agent message
    session.currentAgentMessage = null;

    if (!session.currentUserMessage) {
      const msg: AgentMessage = {
        id: `user_${Date.now()}_${this.msgCounter.next()}`,
        role: "user",
        parts: [],
        timestamp: Date.now(),
      };
      session.currentUserMessage = msg;
      session.messageCache.push(msg);
    }
    return session.currentUserMessage;
  }

  /**
   * Claude Code embeds slash-command metadata inside the user turn as XML when
   * recording session history (e.g. `/model sonnet` at session init becomes
   * `<command-name>/model</command-name>...<local-command-stdout>...</local-command-stdout>`).
   * Strip these blocks so replayed user messages only show the actual user text.
   */
  cleanUserMessageParts(msg: AgentMessage): void {
    for (const part of msg.parts) {
      if (part.type === "text") {
        (part as { type: "text"; text: string }).text = part.text
          .replace(/<command-name>[\s\S]*?<\/local-command-stdout>/g, "")
          .trimStart();
      }
    }
    // Drop parts that became empty after cleaning
    const cleaned = msg.parts.filter(
      (p) => p.type !== "text" || p.text.length > 0,
    );
    // Reparse the `[Attached files]` block out of the user-message text
    // and add proper file-attachment parts. This is the replay path —
    // the live path already builds the parts client-side in
    // use-agent-chat.ts:sendMessage. Without this, refreshing the page
    // mid-conversation would show attachments as plain text.
    const withAttachments = applyAttachmentParsing(cleaned);
    msg.parts.splice(0, msg.parts.length, ...withAttachments);
  }

  /**
   * Refine a subagent part's description/prompt/model fields from the
   * second-phase tool_call_update (the one that carries the full input).
   * Returns true when an existing subagent part was found and patched.
   *
   * Called from the in-progress `tool_call_update` branch where claude-
   * agent-acp re-sends the dispatch with the now-complete `rawInput`.
   * Without this, subagent cards stay stuck on description="Task" with
   * empty prompt for the entire run and on every replay afterward.
   */
  private refineSubagentFromUpdate(
    session: SessionEntry | undefined,
    toolCallId: string,
    rawInput: unknown,
    title: string | null | undefined,
  ): boolean {
    if (!session) return false;
    const agentMsg = this.findAgentMessageWithToolCall(session, toolCallId);
    if (!agentMsg) return false;
    const idx = agentMsg.parts.findIndex(
      (p) => p.type === "subagent" && p.toolCallId === toolCallId,
    );
    if (idx === -1) return false;
    const old = agentMsg.parts[idx] as Extract<
      AgentMessagePart,
      { type: "subagent" }
    >;
    const parsed = parseSubagentDispatch(rawInput);
    let nextDescription = old.description;
    let nextSubagentType = old.subagentType;
    let nextPrompt = old.prompt;
    let nextModel = old.model;
    let nextBackground = old.background;
    let changed = false;
    if (parsed) {
      if (parsed.description && parsed.description !== old.description) {
        nextDescription = parsed.description;
        changed = true;
      }
      if (parsed.subagentType && parsed.subagentType !== old.subagentType) {
        nextSubagentType = parsed.subagentType;
        changed = true;
      }
      if (parsed.prompt && parsed.prompt !== old.prompt) {
        nextPrompt = parsed.prompt;
        changed = true;
      }
      if (parsed.model && parsed.model !== old.model) {
        nextModel = parsed.model;
        changed = true;
      }
      if (parsed.background !== old.background) {
        nextBackground = parsed.background;
        changed = true;
      }
    }
    // Title fallback — claude-agent-acp uses input.description as the
    // tool title, so even when rawInput is partially missing the title
    // can still upgrade the placeholder "Task" label.
    if (
      typeof title === "string" &&
      title &&
      title !== "Task" &&
      title !== "Agent" &&
      title !== old.description
    ) {
      nextDescription = title;
      changed = true;
    }
    if (!changed) return false;
    agentMsg.parts[idx] = {
      ...old,
      description: nextDescription,
      subagentType: nextSubagentType,
      prompt: nextPrompt,
      model: nextModel,
      background: nextBackground,
    };
    return true;
  }

  /**
   * Walk the cache backwards to find the agent message holding the given
   * tool-call OR subagent part. Both kinds live on the agent message they
   * were emitted from (usually `currentAgentMessage`, but may be an
   * earlier one if a `tool_call_update` arrives after the agent has
   * already started a new message — common for long-running tools and
   * sub-agents).
   */
  private findAgentMessageWithToolCall(
    session: SessionEntry,
    toolCallId: string,
  ): AgentMessage | null {
    for (let i = session.messageCache.length - 1; i >= 0; i--) {
      const msg = session.messageCache[i];
      if (msg.role !== "agent") continue;
      const hit = msg.parts.some(
        (p) =>
          (p.type === "tool-call" || p.type === "subagent") &&
          p.toolCallId === toolCallId,
      );
      if (hit) return msg;
    }
    return null;
  }

  /** Flip a cached tool-call part to "running" (idempotent) and emit
   *  `agent-tool-status`. Returns true when the flip happened. */
  private markToolCallRunning(
    sessionId: string,
    session: SessionEntry,
    toolCallId: string,
    runningAt: number,
  ): boolean {
    if (session.isReplaying === true) return false;
    const agentMsg = this.findAgentMessageWithToolCall(session, toolCallId);
    if (!agentMsg) return false;
    const idx = agentMsg.parts.findIndex(
      (p) => p.type === "tool-call" && p.toolCallId === toolCallId,
    );
    if (idx === -1) return false;
    const old = agentMsg.parts[idx] as Extract<
      AgentMessagePart,
      { type: "tool-call" }
    >;
    if (old.status === "running" || old.runningAt !== undefined) return false;
    agentMsg.parts[idx] = { ...old, status: "running", runningAt };
    this.emit(sessionId, {
      type: "agent-tool-status",
      toolCallId,
      status: "running",
      runningAt,
    });
    return true;
  }

  /** Flip the OLDEST still-pending tool-call in the message to running —
   *  the sequential-execution inference (a sibling completed → the next
   *  queued tool starts; the message finished streaming → the first tool
   *  starts). No-op when nothing is pending. */
  private markOldestPendingRunning(
    sessionId: string,
    session: SessionEntry,
    agentMsg: AgentMessage,
  ): void {
    if (session.isReplaying === true) return;
    const notDone = (toolCallId: string) =>
      !agentMsg.parts.some(
        (q) => q.type === "tool-result" && q.toolCallId === toolCallId,
      );
    // Pre-scan: only ONE thing executes at a time, so if ANYTHING in this
    // message is already executing — a running subagent (Task dispatches
    // have no pending state and execute in announce order like tools) or a
    // not-yet-completed running tool-call anywhere in the batch — the
    // inference must NOT flip a second one.
    for (const p of agentMsg.parts) {
      if (p.type === "subagent" && p.status === "running") return;
      if (
        p.type === "tool-call" &&
        notDone(p.toolCallId) &&
        (p.status === "running" || p.runningAt !== undefined)
      ) {
        return;
      }
    }
    for (const p of agentMsg.parts) {
      if (p.type !== "tool-call" || !notDone(p.toolCallId)) continue;
      this.markToolCallRunning(sessionId, session, p.toolCallId, Date.now());
      return;
    }
  }
}

/**
 * Pull text out of an ACP `ToolCallContent[]` array. Concatenates every
 * `{ type: "content", content: { type: "text" } }` block; ignores diff /
 * terminal / image content for now (we don't have UI for those yet).
 *
 * Returns null when the array is empty/missing or contains no usable text.
 */
function formatEta(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${sec}s`;
}

/** One-line progress text for a job tick. Exported for unit tests. */
export function formatJobProgressText(payload: JobProgressPayload): string {
  const pct =
    payload.total > 0 ? Math.floor((payload.done / payload.total) * 100) : 0;
  const eta = payload.etaMs != null ? formatEta(payload.etaMs) : null;
  const core = `${payload.kind} ${payload.done}/${payload.total} ${payload.unit}${pct ? ` (${pct}%)` : ""}${eta ? ` — ETA ${eta}` : ""}`;
  return payload.progressLabel ? `${payload.progressLabel} — ${core}` : core;
}

/**
 * Maps a JobRunner `kind` to a user-friendly notification title. Falls back
 * to the kind string itself when no mapping is defined, so a forgotten entry
 * degrades to "music_generate" instead of breaking the notification. Append
 * to the table when a new chat-surface runner is added.
 */
function prettyTitleForKind(
  kind: string,
  status: "completed" | "failed",
): string {
  const titles: Record<string, string> = {
    music_generate: "Music generated",
    tracking: "Tracking finished",
    tracking_provider: "Tracking finished",
    whisper_model_download: "Whisper model ready",
    music_model_download: "Music model ready",
    tts_model_download: "TTS model ready",
  };
  const base = titles[kind] ?? kind;
  return status === "failed" ? `${base} — failed` : base;
}

function extractProgressText(
  content: Array<{
    type?: string;
    content?: { type?: string; text?: string };
  }> | null,
): string | null {
  if (!content || content.length === 0) return null;
  const texts: string[] = [];
  for (const block of content) {
    if (
      block?.type === "content" &&
      block.content?.type === "text" &&
      typeof block.content.text === "string"
    ) {
      texts.push(block.content.text);
    }
  }
  const joined = texts.join("\n").trim();
  return joined.length > 0 ? joined : null;
}
