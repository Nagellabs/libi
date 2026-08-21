"use client";

import * as React from "react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { loadDraft, saveDraft } from "@/lib/chat/draft-store";
import { useReactRenderTelemetry } from "@/lib/preview/telemetry";
import { useAgentChat } from "@/hooks/sessions/use-agent-chat";
import { useEditorState } from "@/lib/editor-state-context";
import { useScrollToBottom } from "@/hooks/use-scroll-to-bottom";
import { useFileUpload } from "@/lib/queries/files";
import ChatComposer from "./chat-composer";
import ChatMessage from "./chat-message";
import ScrollToBottomPill from "./scroll-to-bottom-pill";
import { Skeleton } from "@/components/ui/skeleton";
import { Play, X } from "lucide-react";
import {
  ONBOARDING_DEMO_PROMPT,
  RUN_ONBOARDING_DEMO_EVENT,
} from "@/lib/onboarding/demo";
import { interceptCommand } from "@/lib/chat/slash-commands";
import { trackEvent } from "@/lib/analytics/client";
import type { McpToolId } from "@/lib/agents/mcp-tool-id";

interface ChatPanelProps {
  sessionId: string | null;
  pieceId: string;
  onToolResult?: (toolId: McpToolId | null, rawTitle: string, result: unknown) => void;
  onNavigate?: (event: { target: string; pieceId: string; fileId?: string }) => void;
  onRefreshQuery?: (event: { queryKey: string; pieceId?: string }) => void;
  onSessionsChanged?: () => void;
  /** Open a chat-message file attachment in the assets panel. The parent
   *  (editor page) switches to the file's piece, flips the editor to the
   *  Assets tab, and selects the file. Receives the live `FileRecord` so
   *  pieceId is reliable even after the file was reassigned. */
  onOpenAsset?: (file: import("@/lib/db/schema/types").FileRecord) => void;
  /** Start a new chat session (the sidebar's New-chat action). Used by the
   *  client-side /clear intercept. */
  onNewChat?: () => void;
}

function PulsingLabel({ label }: { label: string }) {
  return (
    <div className="animate-message-in text-sm text-muted-foreground">
      <span className="inline-flex gap-1">
        <span className="animate-pulse">{label}</span>
        <span className="animate-pulse delay-100">.</span>
        <span className="animate-pulse delay-200">.</span>
        <span className="animate-pulse delay-300">.</span>
      </span>
    </div>
  );
}

function AgentThinkingTag() {
  return (
    <div className="animate-message-in flex items-start">
      <span className="inline-flex items-center gap-2 rounded-full border border-border bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
        {/* Animated waveform / equalizer bars */}
        <svg
          width="16"
          height="10"
          viewBox="0 0 16 10"
          className="shrink-0 text-primary/70"
          fill="currentColor"
          aria-hidden="true"
        >
          <rect x="0" y="3" width="2.5" height="4" rx="1.25">
            <animate attributeName="height" values="4;8;2;4" dur="1s" repeatCount="indefinite" begin="0s" />
            <animate attributeName="y" values="3;1;4;3" dur="1s" repeatCount="indefinite" begin="0s" />
          </rect>
          <rect x="4.5" y="1" width="2.5" height="8" rx="1.25">
            <animate attributeName="height" values="8;2;6;8" dur="1s" repeatCount="indefinite" begin="0.2s" />
            <animate attributeName="y" values="1;4;2;1" dur="1s" repeatCount="indefinite" begin="0.2s" />
          </rect>
          <rect x="9" y="2" width="2.5" height="6" rx="1.25">
            <animate attributeName="height" values="6;3;8;6" dur="1s" repeatCount="indefinite" begin="0.35s" />
            <animate attributeName="y" values="2;3.5;1;2" dur="1s" repeatCount="indefinite" begin="0.35s" />
          </rect>
          <rect x="13.5" y="4" width="2.5" height="2" rx="1.25">
            <animate attributeName="height" values="2;7;4;2" dur="1s" repeatCount="indefinite" begin="0.1s" />
            <animate attributeName="y" values="4;1.5;3;4" dur="1s" repeatCount="indefinite" begin="0.1s" />
          </rect>
        </svg>
        generating
      </span>
    </div>
  );
}

function ChatPanel({ sessionId, pieceId, onToolResult, onNavigate, onRefreshQuery, onSessionsChanged, onOpenAsset, onNewChat }: ChatPanelProps) {
  useReactRenderTelemetry("ChatPanel");
  const chat = useAgentChat(sessionId, { onToolResult, onNavigate, onRefreshQuery, onSessionsChanged });
  const { containerRef, isAtBottom, scrollToBottom, restoreSavedPosition } = useScrollToBottom(sessionId ?? undefined);
  const { upload } = useFileUpload(pieceId);

  // The composer draft survives a page reload: every change mirrors into the
  // per-session draft store, and a failed send backs its text up there too
  // (see use-agent-chat) — so reloading after a stuck send no longer destroys
  // what the user typed.
  const [inputValue, setInputValueState] = useState(() => loadDraft(sessionId));
  const setInputValue = useCallback(
    (value: string) => {
      setInputValueState(value);
      saveDraft(sessionId, value);
    },
    [sessionId],
  );

  // Restore the persisted draft when the session changes. The outgoing
  // session's draft is already saved (mirrored on every change), so this is
  // a pure swap.
  useEffect(() => {
    setInputValueState(loadDraft(sessionId));
  }, [sessionId]);

  const { activeProviderId, prefilledMessage, setPrefilledMessage, onboardingDemoOffer, setOnboardingDemoOffer } =
    useEditorState();

  useEffect(() => {
    if (prefilledMessage === null) return;
    setInputValue(prefilledMessage);
    setPrefilledMessage(null);
  }, [prefilledMessage, setPrefilledMessage]);

  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Track which message IDs existed on mount — only animate new ones
  const initialMessageIdsRef = useRef<Set<string> | null>(null);
  if (initialMessageIdsRef.current === null) {
    initialMessageIdsRef.current = new Set(chat.messages.map((m) => m.id));
  }

  const showNoSession = !sessionId && chat.messages.length === 0;

  // Show the skeleton whenever the chat is connecting and we have nothing to
  // render yet. The empty-state placeholder ("Describe the video…") must NOT
  // render while connecting — otherwise it flashes for sessions that have
  // history, which looks broken. A short debounce avoids flicker when the
  // cache is already warm and the fetch resolves almost instantly.
  const isLoadingHistory =
    !!sessionId && chat.status === "connecting" && chat.messages.length === 0;

  const [showSessionSkeleton, setShowSessionSkeleton] = useState(false);

  useEffect(() => {
    if (!isLoadingHistory) {
      setShowSessionSkeleton(false);
      return;
    }
    const timer = setTimeout(() => setShowSessionSkeleton(true), 150);
    return () => clearTimeout(timer);
  }, [isLoadingHistory]);

  // When session becomes ready and there's a queued message, send it
  useEffect(() => {
    if (chat.sessionReady && pendingMessage) {
      chat.sendMessage(pendingMessage);
      setPendingMessage(null);
    }
  }, [chat.sessionReady, pendingMessage, chat.sendMessage]);

  // Listen for the onboarding demo trigger dispatched by the onboarding panel
  // ("Show me how it works" button). When fired, send a fixed trigger message
  // to the active agent. If the session isn't ready yet, queue it exactly like
  // a normal user message so it fires once the agent connects.
  useEffect(() => {
    const handler = () => {
      if (chat.sessionReady) {
        chat.sendMessage(ONBOARDING_DEMO_PROMPT);
      } else if (sessionId) {
        setPendingMessage(ONBOARDING_DEMO_PROMPT);
      }
    };
    window.addEventListener(RUN_ONBOARDING_DEMO_EVENT, handler);
    return () => window.removeEventListener(RUN_ONBOARDING_DEMO_EVENT, handler);
  }, [chat.sessionReady, chat.sendMessage, sessionId]);

  // Single effect for all scroll behavior — no competing effects.
  // First load: restore saved position. Subsequent updates: auto-scroll if at bottom.
  const hasRestoredRef = useRef(false);
  useEffect(() => {
    hasRestoredRef.current = false;
  }, [sessionId]);

  useEffect(() => {
    if (chat.messages.length === 0) return;

    if (!hasRestoredRef.current) {
      // First time messages are available — restore saved position
      hasRestoredRef.current = true;
      restoreSavedPosition();
      return;
    }

    // Subsequent changes (streaming, new messages) — follow if at bottom
    if (isAtBottom) {
      scrollToBottom();
    }
  }, [chat.messages, isAtBottom, scrollToBottom, restoreSavedPosition]);

  // Receives a plain `File[]` snapshot from ChatComposer — see the
  // `onFilesSelected` JSDoc on ChatComposerProps for why we never accept a
  // live FileList here.
  const handleFileSelect = (files: File[]) => {
    if (files.length === 0) return;
    setPendingFiles((prev) => [...prev, ...files]);
  };

  const removePendingFile = (index: number) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const text = inputValue.trim();
    if ((!text && pendingFiles.length === 0) || isSubmitting) return;

    // Client-side command intercepts + analytics. /clear maps to New chat
    // (the agent never sees it); every other /command is sent verbatim.
    if (text.startsWith("/")) {
      const BUILTIN = new Set([
        "clear", "compact", "model", "init", "review", "review-branch", "review-commit",
      ]);
      const name = text.slice(1).split(/\s/, 1)[0];
      trackEvent("chat_slash_command", {
        command: BUILTIN.has(name) ? name : "custom",
      });
    }
    if (interceptCommand(text) === "new-chat") {
      setInputValue("");
      setPendingFiles([]);
      onNewChat?.();
      return;
    }

    setInputValue("");
    const filesToUpload = [...pendingFiles];
    setPendingFiles([]);
    scrollToBottom();

    if (filesToUpload.length > 0) {
      setIsSubmitting(true);
      try {
        const records = await Promise.all(filesToUpload.map((f) => upload(f)));
        const attachments = records.map((r) => ({
          fileId: r.id,
          filename: r.filename,
          contentType: r.contentType,
          size: r.size,
          mediaDuration: r.mediaDuration,
          mediaWidth: r.mediaWidth,
          mediaHeight: r.mediaHeight,
        }));

        if (chat.sessionReady) {
          chat.sendMessage(text, attachments);
        } else if (sessionId) {
          setPendingMessage(text);
        }
      } finally {
        setIsSubmitting(false);
      }
    } else {
      if (chat.sessionReady) {
        chat.sendMessage(text);
      } else if (sessionId) {
        setPendingMessage(text);
      }
    }
  };

  // isDisabled covers connection-level blocking (no session, session initialising,
  // uploading files). It does NOT include chat.isLoading — streaming is handled
  // by the Stop button, and sending while streaming triggers the steering path.
  const isDisabled = !!pendingMessage || showNoSession || isSubmitting;
  const canSend =
    (!!inputValue.trim() || pendingFiles.length > 0) &&
    !isSubmitting &&
    !showNoSession;

  // Determine if the agent is streaming but has no text yet (show thinking indicator)
  const lastMessage = chat.messages[chat.messages.length - 1];
  const isStreamingWithoutText =
    chat.isLoading &&
    !pendingMessage &&
    (!lastMessage ||
      lastMessage.role !== "agent" ||
      !lastMessage.parts.some((p) => p.type === "text"));

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* Messages area — isolated scroll */}
      <div
        ref={containerRef}
        className="relative flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-4"
      >
        {showNoSession && (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-muted-foreground">
              {activeProviderId
                ? "Starting a chat session…"
                : "Select an agent to start chatting."}
            </p>
          </div>
        )}

        {showSessionSkeleton && (
          <div className="space-y-4">
            <div className="flex justify-end">
              <Skeleton className="h-9 w-48 rounded-lg" />
            </div>
            <div className="flex justify-start">
              <Skeleton className="h-16 w-64 rounded-lg" />
            </div>
            <div className="flex justify-end">
              <Skeleton className="h-7 w-32 rounded-lg" />
            </div>
            <div className="flex justify-start">
              <Skeleton className="h-24 w-72 rounded-lg" />
            </div>
          </div>
        )}

        {!showNoSession &&
          !showSessionSkeleton &&
          !isLoadingHistory &&
          chat.messages.length === 0 &&
          !pendingMessage && (
            <div className="flex h-full items-center justify-center">
              <p className="text-sm text-muted-foreground">
                Describe the video you want to create.
              </p>
            </div>
          )}

        {/* Chat messages */}
        <div className="space-y-4">
          {chat.messages.map((message) => (
            <ChatMessage
              key={message.id}
              message={message}
              animate={!initialMessageIdsRef.current?.has(message.id)}
              sessionId={sessionId}
              onOpenAsset={onOpenAsset}
              onRetry={chat.retryMessage}
            />
          ))}

          {pendingMessage && (
            <>
              <div className="flex justify-end animate-message-in">
                <div className="max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm leading-relaxed text-primary-foreground">
                  <p className="whitespace-pre-wrap">{pendingMessage}</p>
                </div>
              </div>
              <PulsingLabel label="Initializing agent" />
            </>
          )}

          {isStreamingWithoutText && <div className="-mt-2"><AgentThinkingTag /></div>}
        </div>

        {/* Scroll to bottom pill */}
        <ScrollToBottomPill
          visible={!isAtBottom && chat.messages.length > 0}
          onScrollToBottom={scrollToBottom}
        />
      </div>

      {/* First-run demo suggestion — shown once after the user connects an
          agent out of onboarding. Opt-in: tapping it kicks off the demo, the
          dismiss (×) just clears it. Either way it never shows again. */}
      {onboardingDemoOffer && (
        <div className="relative mx-3 mb-2 rounded-2xl border border-primary/30 bg-[color:var(--accent-soft)] p-4 shadow-sm">
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setOnboardingDemoOffer(false)}
            className="absolute right-2.5 top-2.5 cursor-pointer rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </button>
          <div className="flex flex-col gap-1 pr-6">
            <span className="text-sm font-semibold text-foreground">You&apos;re all set! 🎬</span>
            <span className="text-[13px] leading-relaxed text-muted-foreground">
              Want a quick tour? I&apos;ll build a short example video in
              seconds — no setup needed.
            </span>
          </div>
          <button
            type="button"
            onClick={() => {
              window.dispatchEvent(new CustomEvent(RUN_ONBOARDING_DEMO_EVENT));
              setOnboardingDemoOffer(false);
            }}
            className="mt-3 flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground shadow-sm transition hover:opacity-90 active:scale-[0.99]"
          >
            <Play className="size-4" strokeWidth={2.5} fill="currentColor" />
            Show me how it works
          </button>
        </div>
      )}

      {/* Input */}
      <ChatComposer
        sessionId={sessionId}
        inputValue={inputValue}
        onInputChange={setInputValue}
        pendingFiles={pendingFiles}
        onFilesSelected={handleFileSelect}
        onRemoveFile={removePendingFile}
        onClearFiles={() => setPendingFiles([])}
        onSubmit={handleSubmit}
        onCancel={chat.cancelMessage}
        disabled={isDisabled}
        canSend={canSend}
        isStreaming={chat.isLoading}
      />
    </div>
  );
}

/**
 * Memoized so the editor's 30 Hz playback re-render (driven by `transport.frame`
 * in the editor page) does NOT reconcile the entire chat conversation tree every
 * frame — that full-tree reconciliation was the dominant allocation churn behind
 * the preview's ~1 Hz GC stutter (see `lib/preview/telemetry.ts`). Every prop
 * passed by the editor page is referentially stable on a frame tick (useCallback
 * handlers + scalar ids), so the shallow compare bails. ChatPanel still
 * re-renders normally on its OWN state / SSE updates (new messages, tool calls).
 */
export default React.memo(ChatPanel);
