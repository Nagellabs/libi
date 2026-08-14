"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AgentMessagePart } from "@/lib/agents/message-types";
import type { AgentEvent } from "@/lib/agents/types";
import type { McpToolId } from "@/lib/agents/mcp-tool-id";
import type {
  SessionUsageState,
  AvailableCommandInfo,
} from "@/lib/sessions/usage";
import { toast } from "sonner";
import { sanitizeInspectorGroup } from "@/lib/editor-state-context";
import {
  applyAgentEvent,
  applyHistory,
  appendLocalUserMessage,
  markLocalUserMessageFailed,
  removeLocalUserMessage,
  defaultChatStreamDeps,
  initialChatStreamState,
  mergeChatMessages,
  selectChatMessages,
  type ChatMessage,
  type ChatStreamState,
} from "@/lib/chat/stream-state";

/**
 * Message assembly (how SSE events become messages, how history and the
 * live stream merge, turn adoption after refresh, etc.) lives in the PURE
 * state machine at `lib/chat/stream-state.ts` — read its header for the
 * full model. This hook owns the impure shell: the SSE singleton, status
 * tracking, and publishing immutable snapshots into React state.
 */
export type AgentMessage = ChatMessage;
export { mergeChatMessages };
export type { AgentMessagePart };

export type AgentChatStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "thinking"
  | "streaming"
  | "error"
  | "disconnected";

// ── Module-level cache ──────────────────────────────────────────────

const _cachedStatusMap = new Map<string, AgentChatStatus>();

// ── Pending-approval count tracker ──────────────────────────────────
// Tracks unresolved `permission-request` events per session so the
// sidebar can show an indicator dot on inactive sessions. Counts are
// maintained globally (not per-component) because the sidebar renders
// rows for sessions whose chat hook isn't mounted.

const _pendingApprovalCounts = new Map<string, number>();
// Track which pendingIds we've already counted, so duplicate SSE
// deliveries (e.g. mid-stream reconnect re-fans cached events) don't
// double-increment. Same map gates resolve so it only decrements once.
const _seenPendingIds = new Map<string, string>(); // pendingId -> sessionId
const _pendingApprovalSubscribers = new Set<() => void>();

function _emitPendingApprovalChange() {
  for (const sub of _pendingApprovalSubscribers) sub();
}

function _incrementPending(sessionId: string, pendingId: string) {
  if (_seenPendingIds.has(pendingId)) return;
  _seenPendingIds.set(pendingId, sessionId);
  _pendingApprovalCounts.set(
    sessionId,
    (_pendingApprovalCounts.get(sessionId) ?? 0) + 1,
  );
  _emitPendingApprovalChange();
}

function _decrementPending(pendingId: string) {
  const sessionId = _seenPendingIds.get(pendingId);
  if (!sessionId) return;
  _seenPendingIds.delete(pendingId);
  const next = (_pendingApprovalCounts.get(sessionId) ?? 1) - 1;
  if (next <= 0) {
    _pendingApprovalCounts.delete(sessionId);
  } else {
    _pendingApprovalCounts.set(sessionId, next);
  }
  _emitPendingApprovalChange();
}

/** Subscribe to per-session pending-approval count changes. Returns the
 *  current count for `sessionId`. The sidebar uses this to render a small
 *  amber dot on rows with unresolved permission requests. */
export function usePendingApprovalCount(sessionId: string | null): number {
  const subscribe = useCallback((cb: () => void) => {
    _pendingApprovalSubscribers.add(cb);
    // Ensure the SSE stream is alive so we actually receive permission
    // events while only the sidebar (no chat hook) is mounted.
    _ensureGlobalSSE();
    return () => {
      _pendingApprovalSubscribers.delete(cb);
      _closeGlobalSSEIfIdle();
    };
  }, []);
  const getSnapshot = useCallback(
    () => (sessionId ? _pendingApprovalCounts.get(sessionId) ?? 0 : 0),
    [sessionId],
  );
  // SSR snapshot — no pending approvals on the server.
  return useSyncExternalStore(subscribe, getSnapshot, () => 0);
}

// ── refresh_query global emitter ────────────────────────────────────
// A second pub/sub channel layered on top of the single SSE EventSource.
// `useAgentChat` instances forward their per-session callback (existing
// `onRefreshQuery` option) AS WELL AS publishing every refresh_query
// event here. Layout-level subscribers (see
// `hooks/use-global-refresh-query-subscription.ts`) consume this so the
// data-cache invalidation runs on every (app) route, not only on the
// editor page where `onRefreshQuery` happens to be wired in.

type RefreshQueryListener = (event: {
  queryKey: string;
  pieceId?: string;
  sceneId?: string;
  fileId?: string;
  trackId?: string;
}) => void;

class RefreshQueryEmitter {
  private listeners = new Set<RefreshQueryListener>();
  on(fn: RefreshQueryListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  emit(event: Parameters<RefreshQueryListener>[0]): void {
    for (const fn of this.listeners) fn(event);
  }
}

const globalForRefresh = globalThis as unknown as {
  __libiRefreshEmitter?: RefreshQueryEmitter;
};
if (!globalForRefresh.__libiRefreshEmitter) {
  globalForRefresh.__libiRefreshEmitter = new RefreshQueryEmitter();
}
export const refreshQueryEmitter = globalForRefresh.__libiRefreshEmitter;

// ── Session-context global emitter ──────────────────────────────────
// agent-usage / agent-commands events (tagged with sessionId) publish here
// at the SSE-singleton level; `useSessionContext` (lib/queries/
// session-context.ts) subscribes and patches the React Query cache. Same
// rationale as refreshQueryEmitter: delivery must not depend on which
// useAgentChat instances happen to be mounted.

export type SessionContextEvent =
  | { sessionId: string; kind: "usage"; usage: SessionUsageState }
  | { sessionId: string; kind: "commands"; commands: AvailableCommandInfo[] };

type SessionContextListener = (event: SessionContextEvent) => void;

class SessionContextEmitter {
  private listeners = new Set<SessionContextListener>();
  on(fn: SessionContextListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  emit(event: SessionContextEvent): void {
    for (const fn of this.listeners) fn(event);
  }
}

const globalForSessionContext = globalThis as unknown as {
  __libiSessionContextEmitter?: SessionContextEmitter;
};
if (!globalForSessionContext.__libiSessionContextEmitter) {
  globalForSessionContext.__libiSessionContextEmitter = new SessionContextEmitter();
}
export const sessionContextEmitter =
  globalForSessionContext.__libiSessionContextEmitter;

// ── Global navigate emitter ─────────────────────────────────────────
// `navigate` events (libi.show_piece / show_asset / show_preview) used to
// be delivered ONLY to a mounted per-session `onNavigate` handler with no
// replay. The first show_piece of a turn races the editor's per-session
// subscription (initial load / session switch) and was silently dropped —
// the user then had to ask "show me the piece" manually. Mirror the proven
// refresh_query pattern: emit on a global singleton at the SSE-singleton
// level so a page-level subscriber always applies the latest navigation,
// regardless of useAgentChat mount timing.

type NavigateListener = (event: {
  target: string;
  pieceId: string;
  fileId?: string;
  /** Optional id for special targets. */
  id?: string;
}) => void;

class NavigateEmitter {
  private listeners = new Set<NavigateListener>();
  on(fn: NavigateListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  emit(event: Parameters<NavigateListener>[0]): void {
    for (const fn of this.listeners) fn(event);
  }
}

const globalForNavigate = globalThis as unknown as {
  __libiNavigateEmitter?: NavigateEmitter;
};
if (!globalForNavigate.__libiNavigateEmitter) {
  globalForNavigate.__libiNavigateEmitter = new NavigateEmitter();
}
export const navigateEmitter = globalForNavigate.__libiNavigateEmitter;

// ── Global overlay-error emitter ────────────────────────────────────
// The storage watcher (`lib/overlays/watcher.ts`) emits `overlay_error`
// on every code/three overlay whose file failed to validate after an
// agent edit. Mirror the refresh_query pattern: publish at the SSE
// singleton level so the preview surface always receives the latest
// per-overlay compile error regardless of mount timing. The preview
// surface clears an overlay's error once a later successful compile
// arrives (driven by the Task-12 `errors` map), so this channel only
// needs to deliver the failure signal.

type OverlayErrorListener = (event: {
  pieceId: string;
  overlayId: string;
  message: string;
}) => void;

class OverlayErrorEmitter {
  private listeners = new Set<OverlayErrorListener>();
  on(fn: OverlayErrorListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  emit(event: Parameters<OverlayErrorListener>[0]): void {
    for (const fn of this.listeners) fn(event);
  }
}

const globalForOverlayError = globalThis as unknown as {
  __libiOverlayErrorEmitter?: OverlayErrorEmitter;
};
if (!globalForOverlayError.__libiOverlayErrorEmitter) {
  globalForOverlayError.__libiOverlayErrorEmitter = new OverlayErrorEmitter();
}
export const overlayErrorEmitter = globalForOverlayError.__libiOverlayErrorEmitter;

// ── Global highlight + set-complexity-mode emitters ─────────────────
// `libi.highlight_property` / `libi.set_complexity_mode` arrive as SSE
// `highlight` / `set_complexity_mode` messages. Mirror the navigate/refresh
// pattern: publish at the SSE-singleton level so the preview surface applies
// guided-edit highlights regardless of useAgentChat mount timing.

type HighlightListener = (event: {
  pieceId: string;
  overlayId: string;
  property: string;
  note?: string;
}) => void;

class HighlightEmitter {
  private listeners = new Set<HighlightListener>();
  on(fn: HighlightListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  emit(event: Parameters<HighlightListener>[0]): void {
    for (const fn of this.listeners) fn(event);
  }
}

const globalForHighlight = globalThis as unknown as {
  __libiHighlightEmitter?: HighlightEmitter;
};
if (!globalForHighlight.__libiHighlightEmitter) {
  globalForHighlight.__libiHighlightEmitter = new HighlightEmitter();
}
export const highlightEmitter = globalForHighlight.__libiHighlightEmitter;

// Effects guided-edit highlights — a globalThis-backed singleton emitter
// mirroring `highlightEmitter`, so the preview surface applies effect
// highlights regardless of useAgentChat mount timing.

type EffectHighlightListener = (event: {
  pieceId: string;
  target:
    | { kind: "catalog"; effectId: string; phase?: "in" | "out" | "loop" }
    | { kind: "applied"; layerId: string; phase: "in" | "out" | "loop" };
  note?: string;
}) => void;

class EffectHighlightEmitter {
  private listeners = new Set<EffectHighlightListener>();
  on(fn: EffectHighlightListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  emit(event: Parameters<EffectHighlightListener>[0]): void {
    for (const fn of this.listeners) fn(event);
  }
}

const globalForEffectHighlight = globalThis as unknown as {
  __libiEffectHighlightEmitter?: EffectHighlightEmitter;
};
if (!globalForEffectHighlight.__libiEffectHighlightEmitter) {
  globalForEffectHighlight.__libiEffectHighlightEmitter = new EffectHighlightEmitter();
}
export const effectHighlightEmitter =
  globalForEffectHighlight.__libiEffectHighlightEmitter;

type SetComplexityModeListener = (event: {
  pieceId?: string;
  overlayId: string;
  mode: "transform" | "style" | "text" | "3d" | "anchors";
}) => void;

class SetComplexityModeEmitter {
  private listeners = new Set<SetComplexityModeListener>();
  on(fn: SetComplexityModeListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  emit(event: Parameters<SetComplexityModeListener>[0]): void {
    for (const fn of this.listeners) fn(event);
  }
}

const globalForSetMode = globalThis as unknown as {
  __libiSetComplexityModeEmitter?: SetComplexityModeEmitter;
};
if (!globalForSetMode.__libiSetComplexityModeEmitter) {
  globalForSetMode.__libiSetComplexityModeEmitter = new SetComplexityModeEmitter();
}
export const setComplexityModeEmitter = globalForSetMode.__libiSetComplexityModeEmitter;

// ── Global SSE singleton ────────────────────────────────────────────

type SSESessionHandler = (event: Record<string, unknown>) => void;

const _sseSessionHandlers = new Map<string, Set<SSESessionHandler>>();
const _sseBroadcastHandlers = new Set<SSESessionHandler>();
let _globalES: EventSource | null = null;
let _globalESReconnectTimer: ReturnType<typeof setTimeout> | null = null;

function _hasAnyHandlers() {
  return (
    _sseSessionHandlers.size > 0 ||
    _sseBroadcastHandlers.size > 0 ||
    _pendingApprovalSubscribers.size > 0
  );
}

function _ensureGlobalSSE() {
  if (_globalES) return;

  const es = new EventSource("/api/agent/events");
  _globalES = es;

  es.onmessage = (event: MessageEvent) => {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(event.data as string) as Record<string, unknown>;
    } catch {
      return;
    }

    // Publish refresh_query events to the layout-level emitter at the
    // SINGLETON level so cache invalidation runs on every (app) route,
    // even when no useAgentChat instance is mounted (e.g. /settings,
    // /characters, /items — AppSidebar opens the SSE singleton via
    // usePendingApprovalCount but registers no per-instance handler).
    // The per-instance `optionsRef.current?.onRefreshQuery?.(...)`
    // callback still fires inside the per-session handler below so the
    // editor's composition handler keeps working.
    if (data.type === "refresh_query") {
      refreshQueryEmitter.emit({
        queryKey: data.queryKey as string,
        pieceId: data.pieceId as string | undefined,
        sceneId: data.sceneId as string | undefined,
        fileId: data.fileId as string | undefined,
        trackId: data.trackId as string | undefined,
      });
    }

    // agent-usage / agent-commands: session-context data for the composer
    // chip + command palette. Published at the SINGLETON level (same
    // rationale as refresh_query) so the React Query cache is patched even
    // when no per-session handler is mounted for that session.
    if (
      (data.type === "agent-usage" || data.type === "agent-commands") &&
      typeof data.sessionId === "string"
    ) {
      if (data.type === "agent-usage") {
        sessionContextEmitter.emit({
          sessionId: data.sessionId,
          kind: "usage",
          usage: data.usage as SessionUsageState,
        });
      } else {
        sessionContextEmitter.emit({
          sessionId: data.sessionId,
          kind: "commands",
          commands: data.commands as AvailableCommandInfo[],
        });
      }
    }

    // Same rationale as refresh_query above: publish navigate at the
    // SINGLETON level so the editor applies it even if no per-session
    // useAgentChat handler is mounted yet (initial load / session switch).
    // The per-instance `onNavigate` callback below still fires for any
    // opted-in consumer — this is purely additive (delivery guarantee).
    if (data.type === "navigate") {
      navigateEmitter.emit({
        target: data.target as string,
        pieceId: data.pieceId as string,
        fileId: data.fileId as string | undefined,
        id: data.id as string | undefined,
      });
    }

    // overlay_error: a code/three overlay's file failed to validate after an
    // agent edit. Publish at the SINGLETON level so the preview surface's
    // badge state always sees it (same rationale as refresh_query/navigate).
    if (data.type === "overlay_error") {
      overlayErrorEmitter.emit({
        pieceId: data.pieceId as string,
        overlayId: data.overlayId as string,
        message: (data.message as string) ?? "invalid code",
      });
    }

    // highlight / set_complexity_mode: guided-edit signals from the agent.
    // Publish at the SINGLETON level (same rationale as navigate above) so
    // the preview surface applies them regardless of mount timing.
    if (data.type === "highlight") {
      highlightEmitter.emit({
        pieceId: data.pieceId as string,
        overlayId: data.overlayId as string,
        property: data.property as string,
        note: data.note as string | undefined,
      });
    }

    if (data.type === "highlight_effect") {
      effectHighlightEmitter.emit({
        pieceId: data.pieceId as string,
        target: data.target as Parameters<
          typeof effectHighlightEmitter.emit
        >[0]["target"],
        note: data.note as string | undefined,
      });
    }

    if (data.type === "set_complexity_mode") {
      setComplexityModeEmitter.emit({
        pieceId: data.pieceId as string | undefined,
        overlayId: data.overlayId as string,
        mode: sanitizeInspectorGroup(data.mode),
      });
    }

    const sessionId = data.sessionId as string | undefined;

    // Sessionless events (navigation, standby-ready, etc.) go to both the
    // broadcast-only subscribers and every per-session handler (legacy
    // behaviour for navigation).
    if (!sessionId) {
      for (const h of _sseBroadcastHandlers) h(data);
      for (const handlers of _sseSessionHandlers.values()) {
        for (const h of handlers) h(data);
      }
      return;
    }

    const handlers = _sseSessionHandlers.get(sessionId);
    if (handlers) {
      for (const h of handlers) h(data);
    }

    if (data.type === "agent-status") {
      _cachedStatusMap.set(sessionId, data.status as AgentChatStatus);
    }

    // Track pending-approval counts globally so the sidebar can show an
    // indicator dot on sessions whose chat hook isn't currently mounted.
    if (data.type === "agent-permission-request") {
      const pendingId = data.pendingId as string | undefined;
      if (pendingId) _incrementPending(sessionId, pendingId);
    } else if (data.type === "agent-permission-resolved") {
      const pendingId = data.pendingId as string | undefined;
      if (pendingId) _decrementPending(pendingId);
    }
  };

  es.onerror = () => {
    es.close();
    _globalES = null;
    _globalESReconnectTimer = setTimeout(() => {
      _globalESReconnectTimer = null;
      if (_hasAnyHandlers()) _ensureGlobalSSE();
    }, 3000);
  };
}

function _closeGlobalSSEIfIdle() {
  if (_hasAnyHandlers() || !_globalES) return;
  _globalES.close();
  _globalES = null;
  if (_globalESReconnectTimer) {
    clearTimeout(_globalESReconnectTimer);
    _globalESReconnectTimer = null;
  }
}

function _subscribeSession(sessionId: string, handler: SSESessionHandler) {
  let set = _sseSessionHandlers.get(sessionId);
  if (!set) {
    set = new Set();
    _sseSessionHandlers.set(sessionId, set);
  }
  set.add(handler);
  _ensureGlobalSSE();
}

function _unsubscribeSession(sessionId: string, handler: SSESessionHandler) {
  const set = _sseSessionHandlers.get(sessionId);
  if (set) {
    set.delete(handler);
    if (set.size === 0) _sseSessionHandlers.delete(sessionId);
  }
  _closeGlobalSSEIfIdle();
}

/** Subscribe to sessionless broadcast events from the server (e.g.
 *  `standby-ready`). Returns an unsubscribe function. Shares the single
 *  global EventSource with per-session subscribers. */
export function subscribeBroadcast(
  handler: (data: Record<string, unknown>) => void,
): () => void {
  _sseBroadcastHandlers.add(handler);
  _ensureGlobalSSE();
  return () => {
    _sseBroadcastHandlers.delete(handler);
    _closeGlobalSSEIfIdle();
  };
}

// ── Hook ────────────────────────────────────────────────────────────

export interface UseAgentChatOptions {
  /** Notified when a tool result arrives. `toolId` is null for built-in
   *  Claude Code tools and the canonical id for MCP tools; `rawTitle` is
   *  the original ACP title — most consumers only care about toolId. */
  onToolResult?: (toolId: McpToolId | null, rawTitle: string, result: unknown) => void;
  onNavigate?: (event: { target: string; pieceId: string; fileId?: string; id?: string }) => void;
  /** Fired when a server-side tool asks the UI to invalidate a React Query
   *  cache (e.g. composition after a scene mutation). */
  onRefreshQuery?: (event: { queryKey: string; pieceId?: string; sceneId?: string; fileId?: string }) => void;
  /** Fired after the server has re-synced session metadata (e.g. the agent
   *  just auto-renamed this session). Consumers typically refresh their
   *  sidebar session list. */
  onSessionsChanged?: () => void;
}

export interface UseAgentChat {
  messages: ChatMessage[];
  sendMessage: (text: string, fileAttachments?: Array<{ fileId: string; filename: string; contentType: string | null; size: number; mediaDuration?: number | null; mediaWidth?: number | null; mediaHeight?: number | null }>) => void;
  /** Re-send a `sendFailed` optimistic message (drops the failed copy first
   *  so the prompt never appears twice). No-op for any other id. */
  retryMessage: (messageId: string) => void;
  /** Cancel the current turn. Resolves once the request hits the server;
   *  the actual cancellation completes asynchronously when the agent
   *  emits its final `stop_reason: cancelled` update. */
  cancelMessage: () => Promise<void>;
  status: AgentChatStatus;
  /** The agent's own explanation for the last `agent-status: error`, or null.
   *  Also rendered inline as a system chat note — see the sseHandler. */
  statusError: string | null;
  isLoading: boolean;
  sessionReady: boolean;
}

/** SSE event types that affect the assembled messages and therefore run
 *  through the pure stream-state reducer. Everything else (navigate,
 *  refresh_query, sessions-changed) is a side-channel. */
const CHAT_STREAM_EVENT_TYPES = new Set([
  "agent-status",
  "agent-text",
  "agent-tool-call",
  "agent-tool-progress",
  "agent-tool-status",
  "agent-subagent-refine",
  "agent-tool-result",
  "agent-permission-request",
  "agent-permission-resolved",
  "chat-note",
  "agent-complete",
]);

export function useAgentChat(sessionId: string | null, options?: UseAgentChatOptions): UseAgentChat {
  // THE one authoritative copy of the assembled chat. Every SSE event is
  // applied to it exactly once, synchronously, as it arrives — never
  // inside a React setState updater. React may double-invoke / replay /
  // discard updaters (StrictMode dev, concurrent rebasing), and the
  // previous updater-based assembly did exactly that: thought streams
  // fragmented into one message per chunk and messages were left stuck
  // `isStreaming: true` after the turn completed. `messages` below is just
  // an immutable render snapshot of this ref.
  const stateRef = useRef<ChatStreamState>(initialChatStreamState());
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const publish = useCallback(() => {
    setMessages(selectChatMessages(stateRef.current));
  }, []);

  // The last error text the AGENT reported (agent-status `error` field), kept
  // alongside the status so a consumer can show it without re-deriving it from
  // the message list.
  const [statusError, setStatusError] = useState<string | null>(null);

  const [status, setStatusRaw] = useState<AgentChatStatus>(
    sessionId ? (_cachedStatusMap.get(sessionId) ?? "idle") : "idle",
  );
  const setStatus = useCallback((s: AgentChatStatus) => {
    if (sessionId) _cachedStatusMap.set(sessionId, s);
    setStatusRaw(s);
  }, [sessionId]);

  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });
  const queuedPromptRef = useRef<{
    text: string;
    attachments?: Array<{ fileId: string; filename: string; contentType: string | null; size: number; mediaDuration?: number | null; mediaWidth?: number | null; mediaHeight?: number | null }>;
  } | null>(null);

  const sessionReady = status === "connected" || status === "thinking" || status === "streaming";

  const sseHandler = useCallback(
    (data: Record<string, unknown>) => {
      const type = data.type as string;

      // ── Message assembly ─────────────────────────────────────────────
      if (CHAT_STREAM_EVENT_TYPES.has(type)) {
        const result = applyAgentEvent(
          stateRef.current,
          data as unknown as AgentEvent,
        );
        if (result.state !== stateRef.current) {
          stateRef.current = result.state;
          publish();
        }
        if (result.toolResult) {
          optionsRef.current?.onToolResult?.(
            result.toolResult.toolId,
            result.toolResult.rawTitle,
            result.toolResult.result,
          );
        }
      }

      // ── Status side-channel ──────────────────────────────────────────
      if (type === "agent-status") {
        const agentStatus = data.status as string;
        if (agentStatus === "connected") setStatus("connected");
        else if (agentStatus === "connecting") setStatus("connecting");
        else if (agentStatus === "disconnected") setStatus("disconnected");
        else if (agentStatus === "thinking") setStatus("streaming");
        else if (agentStatus === "error") setStatus("error");

        // `agent-status` has carried an optional `error` string since it was
        // introduced and NOTHING read it — `status === "error"` had no visual
        // treatment anywhere, so an agent that told us exactly what went wrong
        // produced a chat that looked merely idle. Replay it through the same
        // reducer path as a server-authored `chat-note` so it renders as a
        // finished system message. The noteId is derived from the text, which
        // makes duplicate SSE delivery (reconnect re-fan) idempotent for free.
        const errorText =
          typeof data.error === "string" ? data.error.trim() : "";
        if (errorText) {
          setStatusError(errorText);
          const result = applyAgentEvent(stateRef.current, {
            type: "chat-note",
            text: errorText,
            noteId: `agent-error:${errorText}`,
          });
          if (result.state !== stateRef.current) {
            stateRef.current = result.state;
            publish();
          }
        }
      } else if (type === "agent-text") {
        // Mid-stream reconnects sometimes only deliver an `agent-status:
        // connected` (no `thinking`), so the streaming flag would stay
        // off. Flip to "streaming" the first time real agent content
        // arrives.
        setStatus("streaming");
      } else if (type === "agent-complete") {
        setStatus("connected");
        setStatusError(null);
      }

      // ── Per-instance side-channels ───────────────────────────────────
      if (type === "navigate") {
        optionsRef.current?.onNavigate?.({
          target: data.target as string,
          pieceId: data.pieceId as string,
          fileId: data.fileId as string | undefined,
          id: data.id as string | undefined,
        });
      }

      if (type === "refresh_query") {
        // Note: refreshQueryEmitter.emit happens at the SSE singleton
        // (see _ensureGlobalSSE onmessage) so layout-level subscribers
        // get every event regardless of whether any useAgentChat
        // instance is mounted. The per-instance callback below is just
        // for consumers that opt-in via `onRefreshQuery` (e.g. the
        // editor page's composition handler).
        optionsRef.current?.onRefreshQuery?.({
          queryKey: data.queryKey as string,
          pieceId: data.pieceId as string | undefined,
          sceneId: data.sceneId as string | undefined,
          fileId: data.fileId as string | undefined,
        });
      }

      if (type === "sessions-changed") {
        optionsRef.current?.onSessionsChanged?.();
      }
    },
    [setStatus, setStatusError, publish],
  );

  // Cancel the current turn
  const cancelMessage = useCallback(async () => {
    if (!sessionId) return;
    // Optimistically flip status; the SSE stream will confirm with the
    // agent's final update + `agent-status: connected`.
    setStatus("connected");
    try {
      await fetch("/api/agent/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
    } catch {
      // The user can retry; nothing to roll back.
    }
  }, [sessionId, setStatus]);

  // Send message
  const sendMessage = useCallback(
    async (text: string, fileAttachments?: Array<{ fileId: string; filename: string; contentType: string | null; size: number; mediaDuration?: number | null; mediaWidth?: number | null; mediaHeight?: number | null }>) => {
      if (!sessionId) return;

      // Steering: if a turn is in flight, cancel it and queue this prompt for
      // replay once the agent settles back to `connected`.
      if (status === "thinking" || status === "streaming") {
        queuedPromptRef.current = { text, attachments: fileAttachments };
        await cancelMessage();
        return;
      }

      const parts: AgentMessagePart[] = [];
      if (text) parts.push({ type: "text", text });
      if (fileAttachments) {
        for (const f of fileAttachments) {
          parts.push({ type: "file-attachment", fileId: f.fileId, filename: f.filename, contentType: f.contentType, size: f.size });
        }
      }
      const userMessage: AgentMessage = {
        id: defaultChatStreamDeps.mintId("msg"),
        role: "user",
        parts,
        timestamp: Date.now(),
      };
      stateRef.current = appendLocalUserMessage(stateRef.current, userMessage);
      publish();
      setStatus("thinking");

      // A rejected fetch (server unreachable) and a non-OK response are the
      // same failure from the user's perspective: the prompt never reached
      // the agent. Without the catch, the rejection is unhandled and status
      // stays "thinking" forever — the stuck-"generating" bug.
      try {
        const res = await fetch("/api/agent/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, sessionId, attachments: fileAttachments }),
        });
        if (!res.ok) throw new Error(`send failed: HTTP ${res.status}`);
      } catch {
        stateRef.current = markLocalUserMessageFailed(stateRef.current, userMessage.id);
        publish();
        setStatus("connected");
        toast.error("Message failed to send", {
          description: "The libi server didn't receive it. Use the retry button on the message.",
        });
      }
    },
    [sessionId, status, cancelMessage, setStatus, publish],
  );

  // Re-send a failed optimistic message: drop the flagged copy from the
  // stream state, then run the normal send path with the same content.
  const retryMessage = useCallback(
    (messageId: string) => {
      const failed = stateRef.current.live.find(
        (m) => m.id === messageId && m.role === "user" && m.sendFailed,
      );
      if (!failed) return;
      const text = failed.parts
        .filter((p): p is Extract<AgentMessagePart, { type: "text" }> => p.type === "text")
        .map((p) => p.text)
        .join("\n");
      const attachments = failed.parts
        .filter((p): p is Extract<AgentMessagePart, { type: "file-attachment" }> => p.type === "file-attachment")
        .map((p) => ({ fileId: p.fileId, filename: p.filename, contentType: p.contentType, size: p.size }));
      stateRef.current = removeLocalUserMessage(stateRef.current, messageId);
      publish();
      sendMessage(text, attachments.length > 0 ? attachments : undefined);
    },
    [sendMessage, publish],
  );

  // Replay queued prompt once agent returns to `connected` after a cancel.
  useEffect(() => {
    if (status !== "connected") return;
    const queued = queuedPromptRef.current;
    if (!queued) return;
    queuedPromptRef.current = null;
    // Use a microtask so the cancellation's final state actually settles
    // before we kick off the next turn.
    Promise.resolve().then(() => sendMessage(queued.text, queued.attachments));
  }, [status, sendMessage]);

  // SSE subscription. (Status priming on session change is owned by the
  // "Reset on session change" effect below — it runs on the same trigger.)
  useEffect(() => {
    if (!sessionId) return;
    _subscribeSession(sessionId, sseHandler);
    return () => { _unsubscribeSession(sessionId, sseHandler); };
  }, [sessionId, sseHandler]);

  // Broadcast-channel subscription — receives sessionless events
  // (navigate, refresh_query, sessions-changed) when there is no
  // active session. Without this, the editor would silently miss
  // agent-driven refreshes whenever `sessionId` is null (fresh install,
  // e2e tests without chat seeding). We skip subscribing when a session
  // is active because sessionless events are already fanned out to every
  // per-session handler by `_ensureGlobalSSE`.
  useEffect(() => {
    if (sessionId) return;
    const unsub = subscribeBroadcast(sseHandler);
    return unsub;
  }, [sessionId, sseHandler]);

  // Reset on session change
  useEffect(() => {
    stateRef.current = initialChatStreamState();
    setMessages(selectChatMessages(stateRef.current));
    if (!sessionId) return;

    // Default to "connecting" (not "idle") while we wait for history to load.
    // GET /api/agent/messages triggers server-side activation (via dedup),
    // which can take several seconds on sessions with long histories. Without
    // an explicit connecting state the chat panel would render the empty
    // "Describe the video…" placeholder for the whole wait, because the
    // server's SSE "connecting" event can arrive before the handler
    // subscribes. Preserve a more specific cached status (thinking/streaming/
    // connected) if one exists — those reflect real server state.
    const cached = _cachedStatusMap.get(sessionId);
    const next: AgentChatStatus =
      cached && cached !== "idle" ? cached : "connecting";
    setStatusRaw(next);
    _cachedStatusMap.set(sessionId, next);
  }, [sessionId]);

  // Fetch cached messages. `applyHistory` reconciles an in-flight turn:
  // if SSE events raced the fetch (refresh / session switch mid-turn),
  // the server snapshot supersedes the partial live tail so the turn
  // renders as ONE message instead of splitting in two.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    fetch(`/api/agent/messages?sessionId=${sessionId}`)
      .then((r) => r.json())
      .then((data: { messages?: AgentMessage[] }) => {
        if (cancelled) return;
        stateRef.current = applyHistory(stateRef.current, data.messages ?? []);
        publish();
        // Transition optimistic "connecting" → "connected" once history
        // arrives. Don't clobber a more specific status (thinking/streaming)
        // that an SSE event may have set while the fetch was in flight.
        const current = _cachedStatusMap.get(sessionId);
        if (current === "connecting") {
          _cachedStatusMap.set(sessionId, "connected");
          setStatusRaw("connected");
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [sessionId, publish]);

  return { messages, sendMessage, retryMessage, cancelMessage, status, statusError, isLoading: status === "thinking" || status === "streaming", sessionReady };
}

// ── Tool events helper ──────────────────────────────────────────────

export function useAgentToolEvents(
  messages: AgentMessage[],
  toolIds: McpToolId[],
  onToolResult: (toolId: McpToolId, result: unknown) => void,
) {
  const processedRef = useRef(new Set<string>());
  useEffect(() => {
    for (const msg of messages) {
      for (const part of msg.parts) {
        if (
          part.type === "tool-result" &&
          part.toolId !== null &&
          toolIds.includes(part.toolId)
        ) {
          if (!processedRef.current.has(part.toolCallId)) {
            processedRef.current.add(part.toolCallId);
            onToolResult(part.toolId, part.result);
          }
        }
      }
    }
  }, [messages, toolIds, onToolResult]);
}
