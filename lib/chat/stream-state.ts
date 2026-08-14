// ---------------------------------------------------------------------------
// Chat stream state — the single, PURE model of how chat messages are
// assembled on the client.
//
// ## Why this module exists
//
// The chat view renders two buckets of messages:
//
//   - `cached` — history fetched once from `GET /api/agent/messages`
//     (built server-side by SessionEventHandler from the ACP replay).
//   - `live`   — messages assembled incrementally from SSE events that
//     arrived since the hook mounted / the session was switched.
//
// `selectChatMessages` merges them (dedup by id, live wins) for rendering.
//
// Assembly rules used to live inside React `setState` updater closures that
// ALSO mutated refs and module counters. React is allowed to re-invoke,
// replay, or discard updaters (StrictMode dev double-invoke, concurrent
// rebasing) — so those side effects fired a nondeterministic number of
// times. Observed symptoms: one thinking block fragmented into a
// ThoughtSection per SSE chunk, messages stuck `isStreaming: true` after
// `agent-complete` (thinking sections stuck expanded with a pulsing dot),
// and stray empty streaming-cursor blocks.
//
// The fix: every transition here is a pure function `(state, input) →
// state`. The hook (`hooks/sessions/use-agent-chat.ts`) holds the one
// authoritative `ChatStreamState` in a ref, applies each SSE event EXACTLY
// ONCE as it arrives (outside any React updater), and publishes the
// resulting immutable snapshot via plain `setState`. React can replay that
// publication as often as it likes — it's just a value.
//
// ## Message-flow invariants
//
//   1. One agent turn = ONE agent message. All parts of a turn (thoughts,
//      text, tool calls, results, permission cards) append to the message
//      identified by `currentAgentMessageId`.
//   2. A new current message is minted on `agent-status: "thinking"`
//      (start of a turn the client observed from the beginning).
//   3. Consecutive same-type text/thought chunks MERGE into the last part;
//      a part boundary only appears when the part type changes (e.g. a
//      tool call between two thoughts).
//   4. If stream content arrives with NO current message (page refreshed /
//      session re-opened mid-turn), the in-flight turn is ADOPTED: the last
//      cached agent message becomes the live current message (same id), so
//      the turn never splits into a "head" (history) and "tail" (live)
//      message. See `ensureCurrentAgentMessage`.
//   5. `agent-complete` finalizes EVERY live message (`isStreaming: false`)
//      — nothing can be left stuck streaming.
//   6. Patch events (tool progress / results / permission resolutions /
//      subagent refinements) address parts by id across BOTH buckets — a
//      long-running tool may complete after a refresh moved its call into
//      `cached`.
// ---------------------------------------------------------------------------

import type {
  AgentMessage as BaseAgentMessage,
  AgentMessagePart,
} from "@/lib/agents/message-types";
import type { AgentEvent } from "@/lib/agents/types";
import type { McpToolId } from "@/lib/agents/mcp-tool-id";
import {
  isSubagentDispatch,
  parseSubagentDispatch,
  parseSubagentCompletion,
  extractAgentId,
} from "@/lib/agents/subagent-detector";

/** A chat message as the client renders it. `isStreaming` only ever exists
 *  on `live` agent messages; history from the server never streams.
 *  `sendFailed` only ever exists on `live` user messages — it marks an
 *  optimistic echo whose POST /api/agent/send never reached the server
 *  (the server holds no copy, so a history refetch can never resurrect it). */
export interface ChatMessage extends BaseAgentMessage {
  isStreaming?: boolean;
  sendFailed?: boolean;
}

export interface ChatStreamState {
  /** History from `GET /api/agent/messages` — replaced by `applyHistory`. */
  cached: ChatMessage[];
  /** Messages assembled from SSE events since mount / session switch. */
  live: ChatMessage[];
  /** Id of the live agent message currently receiving stream parts.
   *  Null between turns. */
  currentAgentMessageId: string | null;
}

/** Injected impurities — minting ids and reading the clock — so transitions
 *  stay deterministic under test. */
export interface ChatStreamDeps {
  /** Returns a fresh unique id with the given prefix (e.g. "agent"). */
  mintId: (prefix: string) => string;
  now: () => number;
}

let idCounter = 0;
export const defaultChatStreamDeps: ChatStreamDeps = {
  mintId: (prefix) => `${prefix}_${Date.now()}_${idCounter++}`,
  now: () => Date.now(),
};

export function initialChatStreamState(): ChatStreamState {
  return { cached: [], live: [], currentAgentMessageId: null };
}

export interface ApplyEventResult {
  state: ChatStreamState;
  /** Set when the event was an `agent-tool-result` the UI should forward to
   *  `onToolResult` consumers. (Subagent name-fallback results that matched
   *  no part are swallowed, mirroring the server's classification.) */
  toolResult?: { toolId: McpToolId | null; rawTitle: string; result: unknown };
}

/**
 * Merge cached history with the live stream, deduping by id (live wins) and
 * hiding system-context messages.
 *
 * Why dedup matters: client and server both mint ids in the format
 * `agent_${Date.now()}_${counter}` from independent counters that start at
 * 0. When a round-trip is tight enough that both sides emit a message in
 * the same millisecond AND their counters align, the server-issued id in
 * `cached` matches a client-issued id in `live`. It is also load-bearing
 * for turn ADOPTION (invariant 4): an adopted message keeps its server id,
 * so its stale copy in `cached` is filtered out here.
 *
 * The dedup is GLOBAL (one seen-set across the whole concatenation), not
 * just cross-bucket: a duplicate within either bucket is also collapsed.
 * The render list keys on `id`, so any duplicate is a hard React crash
 * ("two children with the same key"). `live` is appended last and wins on
 * a collision — it carries the freshest in-flight state.
 */
export function mergeChatMessages<
  M extends { id: string; isSystemContext?: boolean },
>(cached: M[], live: M[]): M[] {
  const liveIds = new Set(live.map((m) => m.id));
  const seen = new Set<string>();
  const out: M[] = [];
  // live first so a colliding id resolves to the live (freshest) copy, then
  // re-insert at the original cached/live order below.
  for (const m of [...cached.filter((m) => !liveIds.has(m.id)), ...live]) {
    if (m.isSystemContext) continue;
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

/** The render-facing view of the state. */
export function selectChatMessages(state: ChatStreamState): ChatMessage[] {
  return mergeChatMessages(state.cached, state.live);
}

/**
 * Install fetched history. If the fetch resolved while a turn is already
 * streaming into `live` (events raced the fetch after a mid-turn refresh),
 * the server snapshot supersedes the partial tail we built: the streaming
 * live agent messages are dropped and the last fetched agent message is
 * adopted as the current live message. Everything the dropped tail
 * contained is already inside the server snapshot — the server appends to
 * its cache in the same synchronous block that emits each SSE event, and
 * the snapshot was serialized after those events were emitted.
 */
export function applyHistory(
  state: ChatStreamState,
  fetched: ChatMessage[],
): ChatStreamState {
  const last = fetched[fetched.length - 1];
  const hasStreamingLive = state.live.some(
    (m) => m.role === "agent" && m.isStreaming,
  );
  if (last && last.role === "agent" && hasStreamingLive) {
    const live = state.live.filter(
      (m) => !(m.role === "agent" && m.isStreaming),
    );
    return {
      cached: fetched,
      live: [...live, { ...last, isStreaming: true }],
      currentAgentMessageId: last.id,
    };
  }
  return { ...state, cached: fetched };
}

/** Optimistic local echo of the user's prompt (the server will hold its own
 *  copy; ids differ, but `live` is reset before history is ever refetched). */
export function appendLocalUserMessage(
  state: ChatStreamState,
  msg: ChatMessage,
): ChatStreamState {
  return { ...state, live: [...state.live, msg] };
}

/** Flag an optimistic user echo whose send never reached the server, so the
 *  UI can stop pretending it was delivered and offer a retry. Identity-
 *  preserving when the id isn't a live user message. */
export function markLocalUserMessageFailed(
  state: ChatStreamState,
  messageId: string,
): ChatStreamState {
  const idx = state.live.findIndex(
    (m) => m.id === messageId && m.role === "user",
  );
  if (idx === -1) return state;
  const live = [...state.live];
  live[idx] = { ...live[idx], sendFailed: true };
  return { ...state, live };
}

/** Remove an optimistic user echo from `live` — the retry path drops the
 *  failed copy before re-sending so the prompt never appears twice. */
export function removeLocalUserMessage(
  state: ChatStreamState,
  messageId: string,
): ChatStreamState {
  const idx = state.live.findIndex(
    (m) => m.id === messageId && m.role === "user",
  );
  if (idx === -1) return state;
  return { ...state, live: state.live.filter((_, i) => i !== idx) };
}

// ---------------------------------------------------------------------------
// Event application
// ---------------------------------------------------------------------------

export function applyAgentEvent(
  state: ChatStreamState,
  event: AgentEvent,
  deps: ChatStreamDeps = defaultChatStreamDeps,
): ApplyEventResult {
  switch (event.type) {
    case "agent-status":
      // Only the turn-start status affects messages; the status string
      // itself is UI state owned by the hook.
      if (event.status === "thinking") {
        return { state: startNewTurn(state, deps) };
      }
      return { state };

    case "agent-text":
      return {
        state: appendStreamText(
          state,
          event.isThought ? "thought" : "text",
          event.text,
          deps,
        ),
      };

    case "agent-tool-call":
      return { state: appendToolCall(state, event, deps) };

    case "agent-tool-progress":
      return { state: applyToolProgress(state, event) };

    case "agent-tool-status":
      return { state: applyToolStatus(state, event) };

    case "agent-subagent-refine":
      return { state: applySubagentRefine(state, event) };

    case "agent-tool-result":
      return applyToolResult(state, event, deps);

    case "agent-permission-request":
      return { state: appendPermissionRequest(state, event, deps) };

    case "agent-permission-resolved":
      return { state: applyPermissionResolved(state, event) };

    case "chat-note":
      return { state: appendChatNote(state, event, deps) };

    case "agent-complete":
      return { state: finalizeTurn(state) };

    default:
      return { state };
  }
}

// ---------------------------------------------------------------------------
// Turn lifecycle
// ---------------------------------------------------------------------------

/** Invariant 2 — a fresh empty agent message becomes the current target.
 *  Any still-streaming live message is finalized first (belt and braces —
 *  a lost `agent-complete` must not leave a forever-streaming message). */
function startNewTurn(
  state: ChatStreamState,
  deps: ChatStreamDeps,
): ChatStreamState {
  const msg: ChatMessage = {
    id: deps.mintId("agent"),
    role: "agent",
    parts: [],
    timestamp: deps.now(),
    isStreaming: true,
  };
  return {
    ...state,
    live: [...finalizeStreaming(state.live), msg],
    currentAgentMessageId: msg.id,
  };
}

/** Invariant 5 — nothing survives a completed turn still streaming. */
function finalizeTurn(state: ChatStreamState): ChatStreamState {
  return {
    ...state,
    live: finalizeStreaming(state.live),
    currentAgentMessageId: null,
  };
}

function finalizeStreaming(live: ChatMessage[]): ChatMessage[] {
  let changed = false;
  const next = live.map((m) => {
    if (!m.isStreaming) return m;
    changed = true;
    return { ...m, isStreaming: false };
  });
  return changed ? next : live;
}

/**
 * Invariants 1 + 4 — resolve (or create) the live agent message that stream
 * content should append to:
 *
 *   a. The tracked current message, when it exists.
 *   b. ADOPTION: no current message, `live` holds no agent message yet, AND
 *      the last cached message is an agent message → we joined an in-flight
 *      turn mid-stream (page refresh / session switch-back while the agent
 *      talks). Continue that message — same id — instead of starting a
 *      parallel "tail" message. Its stale copy in `cached` is shadowed by id
 *      in `selectChatMessages`.
 *
 *      The "no live agent message yet" guard is load-bearing: without it, a
 *      stray late chunk arriving AFTER a turn completed (currentId is null)
 *      would reach back and adopt an OLD, already-finalized cached turn,
 *      duplicating it (two children with the same React key — a real crash
 *      found by stress-testing aggressive reloads). Adoption is only ever
 *      correct as the FIRST agent content this mount produces; once we've
 *      streamed any agent message, a null currentId means a turn boundary →
 *      mint fresh (case c).
 *   c. Otherwise mint a fresh message (mid-stream reconnects sometimes
 *      deliver no `agent-status: "thinking"` at all).
 */
function ensureCurrentAgentMessage(
  state: ChatStreamState,
  deps: ChatStreamDeps,
): { state: ChatStreamState; index: number } {
  if (state.currentAgentMessageId) {
    const index = state.live.findIndex(
      (m) => m.id === state.currentAgentMessageId,
    );
    if (index !== -1) return { state, index };
  }

  const liveHasAgentMessage = state.live.some((m) => m.role === "agent");
  const lastCached = state.cached[state.cached.length - 1];
  if (!liveHasAgentMessage && lastCached && lastCached.role === "agent") {
    const adopted: ChatMessage = { ...lastCached, isStreaming: true };
    return {
      state: {
        ...state,
        live: [...state.live, adopted],
        currentAgentMessageId: adopted.id,
      },
      index: state.live.length,
    };
  }

  const created: ChatMessage = {
    id: deps.mintId("agent"),
    role: "agent",
    parts: [],
    timestamp: deps.now(),
    isStreaming: true,
  };
  return {
    state: {
      ...state,
      live: [...state.live, created],
      currentAgentMessageId: created.id,
    },
    index: state.live.length,
  };
}

/** Append parts to the current agent message via a pure parts transform. */
function withCurrentMessage(
  state: ChatStreamState,
  deps: ChatStreamDeps,
  transform: (parts: AgentMessagePart[]) => AgentMessagePart[],
): ChatStreamState {
  const ensured = ensureCurrentAgentMessage(state, deps);
  const live = [...ensured.state.live];
  const msg = live[ensured.index];
  live[ensured.index] = { ...msg, parts: transform(msg.parts) };
  return { ...ensured.state, live };
}

// ---------------------------------------------------------------------------
// Stream content
// ---------------------------------------------------------------------------

/** Invariant 3 — merge into the last part when the type matches, otherwise
 *  start a new part. A thinking block therefore renders as ONE
 *  ThoughtSection no matter how many SSE chunks delivered it. */
function appendStreamText(
  state: ChatStreamState,
  partType: "text" | "thought",
  text: string,
  deps: ChatStreamDeps,
): ChatStreamState {
  return withCurrentMessage(state, deps, (parts) => {
    const last = parts[parts.length - 1];
    if (last && last.type === partType) {
      return [
        ...parts.slice(0, -1),
        { ...last, text: last.text + text } as AgentMessagePart,
      ];
    }
    return [...parts, { type: partType, text } as AgentMessagePart];
  });
}

function appendToolCall(
  state: ChatStreamState,
  event: Extract<AgentEvent, { type: "agent-tool-call" }>,
  deps: ChatStreamDeps,
): ChatStreamState {
  // Subagent dispatch (Task / Agent) renders as a SubagentCard, not a
  // generic tool row. Passing `args` also catches dispatches whose
  // `description` became the tool title ("Describe video keyframes" etc.).
  if (isSubagentDispatch(event.rawTitle, event.args)) {
    const parsed = parseSubagentDispatch(event.args);
    if (parsed) {
      const part: AgentMessagePart = {
        type: "subagent",
        toolCallId: event.toolCallId,
        subagentType: parsed.subagentType,
        description: parsed.description,
        prompt: parsed.prompt,
        model: parsed.model,
        background: parsed.background,
        startedAt: deps.now(),
        status: "running",
        result: null,
        usage: null,
        agentId: null,
      };
      return withCurrentMessage(state, deps, (parts) => [...parts, part]);
    }
  }

  const part: AgentMessagePart = {
    type: "tool-call",
    toolCallId: event.toolCallId,
    toolId: event.toolId,
    rawTitle: event.rawTitle,
    args: event.args,
    startedAt: deps.now(),
    status: "pending" as const,
  };
  return withCurrentMessage(state, deps, (parts) => [...parts, part]);
}

function appendPermissionRequest(
  state: ChatStreamState,
  event: Extract<AgentEvent, { type: "agent-permission-request" }>,
  deps: ChatStreamDeps,
): ChatStreamState {
  const part: AgentMessagePart = {
    type: "permission-request",
    pendingId: event.pendingId,
    toolCall: event.toolCall,
    options: event.options,
    reason: event.reason,
    status: "pending",
  };
  return withCurrentMessage(state, deps, (parts) => [...parts, part]);
}

/** A finished, system-authored message. Idempotent on noteId so duplicate
 *  SSE delivery (reconnect re-fans) can't double-post. */
function appendChatNote(
  state: ChatStreamState,
  event: Extract<AgentEvent, { type: "chat-note" }>,
  deps: ChatStreamDeps,
): ChatStreamState {
  const id = event.noteId || deps.mintId("note");
  const exists =
    state.live.some((m) => m.id === id) ||
    state.cached.some((m) => m.id === id);
  if (exists) return state;
  const msg: ChatMessage = {
    id,
    role: "agent",
    parts: [{ type: "text", text: event.text }],
    timestamp: deps.now(),
    isStreaming: false,
  };
  return { ...state, live: [...state.live, msg] };
}

// ---------------------------------------------------------------------------
// Patch events — address existing parts by id across BOTH buckets
// (invariant 6)
// ---------------------------------------------------------------------------

/** Identity-preserving map over every message in both buckets. */
function patchMessagesEverywhere(
  state: ChatStreamState,
  patcher: (msg: ChatMessage) => ChatMessage,
): { state: ChatStreamState; changed: boolean } {
  let changed = false;
  const mapBucket = (bucket: ChatMessage[]) => {
    let bucketChanged = false;
    const next = bucket.map((m) => {
      const patched = patcher(m);
      if (patched !== m) bucketChanged = true;
      return patched;
    });
    return bucketChanged ? ((changed = true), next) : bucket;
  };
  const cached = mapBucket(state.cached);
  const live = mapBucket(state.live);
  return { state: changed ? { ...state, cached, live } : state, changed };
}

/** Identity-preserving part replacement inside one message. */
function patchPartInMessage(
  msg: ChatMessage,
  predicate: (p: AgentMessagePart) => boolean,
  transform: (p: AgentMessagePart) => AgentMessagePart,
): ChatMessage {
  const idx = msg.parts.findIndex(predicate);
  if (idx === -1) return msg;
  const next = transform(msg.parts[idx]);
  if (next === msg.parts[idx]) return msg;
  const parts = [...msg.parts];
  parts[idx] = next;
  return { ...msg, parts };
}

function applyToolProgress(
  state: ChatStreamState,
  event: Extract<AgentEvent, { type: "agent-tool-progress" }>,
): ChatStreamState {
  return patchMessagesEverywhere(state, (msg) =>
    patchPartInMessage(
      msg,
      (p) =>
        (p.type === "tool-call" || p.type === "subagent") &&
        p.toolCallId === event.toolCallId,
      (p) => {
        if (p.type === "tool-call") {
          if (p.progress === event.text && (!event.jobId || p.jobId === event.jobId)) return p;
          return { ...p, progress: event.text, ...(event.jobId ? { jobId: event.jobId } : {}) };
        }
        if (p.type === "subagent") {
          if (p.progress === event.text) return p;
          return { ...p, progress: event.text };
        }
        return p;
      },
    ),
  ).state;
}

/** Lifecycle: flip a pending tool-call to running when a real execution
 *  signal arrives. Idempotent — a call already running (or carrying a
 *  runningAt) is left untouched so re-delivery can't churn the timer. */
function applyToolStatus(
  state: ChatStreamState,
  event: Extract<AgentEvent, { type: "agent-tool-status" }>,
): ChatStreamState {
  return patchMessagesEverywhere(state, (msg) =>
    patchPartInMessage(
      msg,
      (p) => p.type === "tool-call" && p.toolCallId === event.toolCallId,
      (p) => {
        if (p.type !== "tool-call") return p;
        if (p.status === "running" || p.runningAt !== undefined) return p;
        return { ...p, status: "running", runningAt: event.runningAt };
      },
    ),
  ).state;
}

/** Phase-2 refinement of a Task/Agent dispatch — upgrades the placeholder
 *  "Task" card with the real description / prompt / model once the
 *  assistant message finishes streaming. */
function applySubagentRefine(
  state: ChatStreamState,
  event: Extract<AgentEvent, { type: "agent-subagent-refine" }>,
): ChatStreamState {
  const parsed = parseSubagentDispatch(event.args);
  if (!parsed && !event.title) return state;
  return patchMessagesEverywhere(state, (msg) =>
    patchPartInMessage(
      msg,
      (p) => p.type === "subagent" && p.toolCallId === event.toolCallId,
      (p) => {
        if (p.type !== "subagent") return p;
        let next = p;
        if (parsed) {
          next = {
            ...next,
            description: parsed.description || next.description,
            subagentType: parsed.subagentType || next.subagentType,
            prompt: parsed.prompt || next.prompt,
            model: parsed.model ?? next.model,
            background: parsed.background,
          };
        }
        if (
          typeof event.title === "string" &&
          event.title &&
          event.title !== "Task" &&
          event.title !== "Agent" &&
          event.title !== next.description
        ) {
          next = { ...next, description: event.title };
        }
        return next;
      },
    ),
  ).state;
}

function applyPermissionResolved(
  state: ChatStreamState,
  event: Extract<AgentEvent, { type: "agent-permission-resolved" }>,
): ChatStreamState {
  return patchMessagesEverywhere(state, (msg) =>
    patchPartInMessage(
      msg,
      (p) => p.type === "permission-request" && p.pendingId === event.pendingId,
      (p) =>
        p.type === "permission-request" && p.status !== "resolved"
          ? { ...p, status: "resolved", outcome: event.outcome }
          : p,
    ),
  ).state;
}

// ---------------------------------------------------------------------------
// Tool results
// ---------------------------------------------------------------------------

function applyToolResult(
  state: ChatStreamState,
  event: Extract<AgentEvent, { type: "agent-tool-result" }>,
  deps: ChatStreamDeps,
): ApplyEventResult {
  const forward = {
    toolId: event.toolId,
    rawTitle: event.rawTitle,
    result: event.result,
  };

  // 1) Subagent completion — patch the matching subagent part (detection is
  //    structural by toolCallId, since claude-agent-acp may title the
  //    dispatch with its description rather than "Task").
  const subagentPatch = patchMessagesEverywhere(state, (msg) =>
    patchSubagentCompletion(msg, event),
  );
  if (subagentPatch.changed) {
    return { state: subagentPatch.state, toolResult: forward };
  }

  // 2) Name-only fallback for a subagent result whose part never reached us
  //    (SSE ordering quirks) — swallow rather than render raw JSON inline.
  if (isSubagentDispatch(event.rawTitle)) return { state };

  // 3) Pair with the originating tool-call wherever it lives (it moved into
  //    `cached` if the page refreshed mid-run). Idempotent on toolCallId.
  const resultPart: AgentMessagePart = {
    type: "tool-result",
    toolCallId: event.toolCallId,
    toolId: event.toolId,
    rawTitle: event.rawTitle,
    result: event.result,
    success: event.success,
    completedAt: deps.now(),
  };
  const paired = patchMessagesEverywhere(state, (msg) => {
    const hasCall = msg.parts.some(
      (p) => p.type === "tool-call" && p.toolCallId === event.toolCallId,
    );
    if (!hasCall) return msg;
    const hasResult = msg.parts.some(
      (p) => p.type === "tool-result" && p.toolCallId === event.toolCallId,
    );
    if (hasResult) return msg;
    // Terminal state derives from the paired result — clear the call's
    // transient lifecycle status in the same transform we append it.
    const parts = msg.parts.map((p) =>
      p.type === "tool-call" && p.toolCallId === event.toolCallId && p.status !== undefined
        ? (({ status: _s, ...rest }) => rest as AgentMessagePart)(p)
        : p,
    );
    return { ...msg, parts: [...parts, resultPart] };
  });
  if (paired.changed) return { state: paired.state, toolResult: forward };

  // Already recorded (duplicate delivery)? Don't append an orphan copy.
  const alreadyRecorded = [...state.cached, ...state.live].some((m) =>
    m.parts.some(
      (p) => p.type === "tool-result" && p.toolCallId === event.toolCallId,
    ),
  );
  if (alreadyRecorded) return { state, toolResult: forward };

  // 4) No matching call anywhere — append to the current message so the
  //    result is at least visible.
  return {
    state: withCurrentMessage(state, deps, (parts) => [...parts, resultPart]),
    toolResult: forward,
  };
}

function patchSubagentCompletion(
  msg: ChatMessage,
  event: Extract<AgentEvent, { type: "agent-tool-result" }>,
): ChatMessage {
  return patchPartInMessage(
    msg,
    (p) => p.type === "subagent" && p.toolCallId === event.toolCallId,
    (p) => {
      if (p.type !== "subagent") return p;
      const text =
        typeof event.result === "string"
          ? event.result
          : JSON.stringify(event.result);
      const completion = parseSubagentCompletion(text);
      if (completion) {
        return {
          ...p,
          status: completion.status,
          result: completion.result,
          usage: completion.usage,
        };
      }
      // Foreground completion without a <task-notification> wrapper (raw
      // text reply), or a background-dispatch ack. The ack ("Async agent
      // launched. agentId: …") is NOT a completion — keep status "running".
      const agentId = extractAgentId(text);
      const isBackgroundAck =
        agentId !== null &&
        (p.background || /async\s+agent\s+launched/i.test(text));
      if (isBackgroundAck) return { ...p, agentId };
      return {
        ...p,
        status: event.success ? "completed" : "failed",
        result: text || p.result,
        ...(agentId ? { agentId } : {}),
      };
    },
  );
}
