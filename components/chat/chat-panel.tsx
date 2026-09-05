"use client";

import * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { loadDraft, saveDraft } from "@/lib/chat/draft-store";
import { useReactRenderTelemetry } from "@/lib/preview/telemetry";
import { useAgentChat, type AgentMessage } from "@/hooks/sessions/use-agent-chat";
import { useEditorState } from "@/lib/editor-state-context";
import { useScrollToBottom, type TranscriptSize } from "@/hooks/use-scroll-to-bottom";
import { toast } from "sonner";
import { useFileUpload } from "@/lib/queries/files";
import ChatComposer from "./chat-composer";
import ChatMessage from "./chat-message";
import ScrollToBottomPill from "./scroll-to-bottom-pill";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Play, X } from "lucide-react";
import {
  ONBOARDING_DEMO_PROMPT,
  RUN_ONBOARDING_DEMO_EVENT,
} from "@/lib/onboarding/demo";
import { interceptCommand } from "@/lib/chat/slash-commands";
import { trackEvent } from "@/lib/analytics/client";
import type { McpToolId } from "@/lib/agents/mcp-tool-id";
import { AgentSetupCard, type AgentSetupMode } from "@/components/agents/agent-setup-card";
import { getAgentSetup } from "@/lib/agents/setup/registry";
import { useAgentSetupCardState } from "@/hooks/agents/use-agent-setup-card-state";
import type { AgentReadiness } from "@/lib/agents/agent-readiness";

const UNKNOWN_READINESS: AgentReadiness = { state: "unknown" };

/** How long we let "waiting for a session" look like ordinary progress
 *  before we admit it may never finish. Chosen to comfortably clear a real
 *  session/new round-trip (session start route's own standby wait is 4s)
 *  without making a genuinely stuck chat sit silent for too long. */
const SESSION_START_GRACE_MS = 10_000;

/** The COMMAND libi would actually run to sign this agent in on THIS
 *  machine — only ever populated from an OBSERVED auth rejection
 *  (`needs-auth`), never guessed. Mirrors onboarding-panel.tsx's
 *  `remedyCommand`. */
function remedyCommand(readiness: AgentReadiness): string | undefined {
  return readiness.state === "needs-auth" ? (readiness.remedy?.command ?? undefined) : undefined;
}

interface ChatPanelProps {
  sessionId: string | null;
  onToolResult?: (toolId: McpToolId | null, rawTitle: string, result: unknown) => void;
  onNavigate?: (event: { target: string; pieceId: string; fileId?: string }) => void;
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

/** How much transcript there is, as the two numbers that can grow: the message
 *  count, and the size of the tail message. A turn already underway appends to
 *  the LAST message rather than adding one, so counting messages alone would
 *  miss the case the pill exists for most — the user scrolls up mid-answer and
 *  the answer keeps growing under them. */
/** djb2 fold. Progress strings are compared for INEQUALITY rather than growth
 *  (see `transcriptSize`), so what is needed is a value that moves when the
 *  string does — not a length. Bounded by the last message's parts, and a few
 *  hundred char reads is nothing against re-rendering the transcript itself. */
function foldProgress(seed: number, text: string): number {
  let hash = seed;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return hash;
}

function transcriptSize(messages: AgentMessage[]): TranscriptSize {
  const last = messages[messages.length - 1];
  if (!last) return { count: messages.length, tail: 0, progress: 0 };
  let tail = last.parts.length;
  let progress = 0;
  for (const part of last.parts) {
    if ("text" in part) tail += part.text.length;
    // A tool call reporting on itself grows neither the message count nor any
    // text, so a long run used to read as "nothing arrived" and the pill
    // offered to jump to a latest that had in fact moved. `stream-state`
    // REPLACES the progress string on each update rather than appending, so
    // the commonest shape — "Rendering frame 12/50" → "13/50" — does not even
    // change length. Length cannot see it; a checksum can.
    if ("progress" in part && part.progress) {
      progress = foldProgress(progress, part.progress);
    }
  }
  return { count: messages.length, tail, progress };
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

function ChatPanel({ sessionId, onToolResult, onNavigate, onSessionsChanged, onOpenAsset, onNewChat }: ChatPanelProps) {
  useReactRenderTelemetry("ChatPanel");
  const chat = useAgentChat(sessionId, { onToolResult, onNavigate, onSessionsChanged });
  // Measured once per messages array and shared: the pill compares it against
  // where the user left the bottom, and the scroll hook saves it next to the
  // offset so a return to this session can tell "nothing happened while I was
  // gone" from "the agent kept working". Memoised so the hook's save effect
  // does not re-arm on every unrelated render.
  const transcript = useMemo(() => transcriptSize(chat.messages), [chat.messages]);
  const { containerRef, isAtBottom, scrollToBottom, restoreSavedPosition } = useScrollToBottom(
    sessionId ?? undefined,
    transcript,
  );
  // Attachments upload as UNASSIGNED, never straight into the open piece.
  // Attaching a file shows the agent something; it does not decide that the
  // file belongs to this piece. The agent moves it in with libi.assign_file
  // if it decides it does — and overlays already accept unassigned files, so
  // nothing is blocked in the meantime.
  const { upload } = useFileUpload(null);

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

  const {
    activeProviderId,
    prefilledMessage,
    setPrefilledMessage,
    onboardingDemoOffer,
    setOnboardingDemoOffer,
    sessionList,
    selectAgent,
  } = useEditorState();

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

  // The readiness of the agent this chat is actually waiting on — not the
  // *active* agent per se, since `activeProviderId` can be an optimistic
  // target mid-switch (see editor-state-context's `pendingProviderId`).
  // `readinessFor` (not the single `.readiness`) matches how every other
  // consumer of readiness reads it per-agent (agent-selector.tsx,
  // onboarding-panel.tsx). Tolerate a context that predates readiness (and
  // mocked contexts in older tests) rather than crashing the panel.
  const readinessForFn = sessionList?.readinessFor;
  const readiness: AgentReadiness = activeProviderId
    ? (readinessForFn?.(activeProviderId) ?? UNKNOWN_READINESS)
    : UNKNOWN_READINESS;
  const agentSetup = activeProviderId ? getAgentSetup(activeProviderId) : null;

  // What this agent NEEDS, from what has actually been observed about it —
  // independent of whether the empty state is currently showing, so the
  // install poll below has a stable mode to key off.
  const needsInstall =
    readiness.state === "not-installed" && agentSetup !== null && agentSetup.install !== null;
  const setupMode: AgentSetupMode = needsInstall ? "install" : "sign-in";

  // Chat's own recovery for a finished install. Every surface needs
  // `refreshAgentProviders` + a detect invalidation (the hook does both);
  // chat additionally derives its card from READINESS, which neither of
  // those touches — it is written only by the `agent-readiness` SSE
  // broadcast and the `/api/agent/start` response. Re-selecting the agent is
  // what actually re-runs that route, so it is the recovery that matches
  // this surface's input. Without it the completed install left the card
  // saying "Install Claude Code" on a machine where it now was installed,
  // and pressing it hit `matching_completed` and did nothing.
  const handleInstallCompleted = useCallback(() => {
    if (activeProviderId) void selectAgent(activeProviderId);
  }, [activeProviderId, selectAgent]);

  const agentSetupCard = useAgentSetupCardState(activeProviderId, setupMode, {
    surface: "chat",
    onInstallCompleted: handleInstallCompleted,
    // This card is rendered BECAUSE the agent rejected on auth, so the remedy
    // is exactly the thing its button should run.
    remedy: readiness.state === "needs-auth" ? readiness.remedy : null,
  });

  const showSignIn = showNoSession && readiness.state === "needs-auth" && agentSetup !== null;
  const showInstall = showNoSession && needsInstall && !agentSetupCard.installCompleted;

  // After SESSION_START_GRACE_MS with no session and no sign-in/install fix
  // to offer, the "Starting a chat session…" sentence stops being honest —
  // it must never claim progress it cannot demonstrate. Resets whenever the
  // wait restarts (a fresh activeProviderId, or the no-longer-waiting case).
  const isWaitingForSession = showNoSession && !!activeProviderId && !showSignIn && !showInstall;
  const [graceExpired, setGraceExpired] = useState(false);
  useEffect(() => {
    if (!isWaitingForSession) {
      setGraceExpired(false);
      return;
    }
    const timer = setTimeout(() => setGraceExpired(true), SESSION_START_GRACE_MS);
    return () => clearTimeout(timer);
  }, [isWaitingForSession, activeProviderId]);
  const showStuck = isWaitingForSession && graceExpired;
  const showWaitingSkeleton = isWaitingForSession && !graceExpired;

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

  // The pill is only allowed to say "New messages" when something actually
  // arrived after the user left the bottom. No unread bookkeeping exists
  // anywhere in the app, so the signal is local and cheap: snapshot the
  // transcript's size the moment they leave the bottom, compare against it
  // until they come back. Without this, scrolling up through an idle chat the
  // user has already read announces messages that do not exist.
  const [hasNewMessages, setHasNewMessages] = useState(false);
  // Derived from the measure rather than restated, so adding a dimension to
  // `transcriptSize` can never leave the mark silently narrower than the
  // snapshots being compared against it.
  const sizeAtLeaveRef = useRef<TranscriptSize | null>(null);

  useEffect(() => {
    if (isAtBottom) {
      // Back at the latest — everything above it counts as read.
      sizeAtLeaveRef.current = null;
      setHasNewMessages(false);
      return;
    }
    const size = transcript;
    const mark = sizeAtLeaveRef.current;
    if (!mark) {
      // This is the moment they left; nothing has arrived since, by definition.
      sizeAtLeaveRef.current = size;
      return;
    }
    // Progress only counts while the message COUNT is unchanged: a growing
    // transcript is already caught by the first clause, and a shrinking one is
    // a reset (an emptied list folds to progress 0), which must not read as
    // arriving content.
    if (
      size.count > mark.count ||
      (size.count === mark.count &&
        (size.tail > mark.tail || size.progress !== mark.progress))
    ) {
      setHasNewMessages(true);
    }
  }, [isAtBottom, transcript]);

  // Single effect for all scroll behavior — no competing effects.
  // First load: restore saved position. Subsequent updates: auto-scroll if at bottom.
  const hasRestoredRef = useRef(false);
  // `useAgentChat` clears its messages in an EFFECT, so a switch A→B produces a
  // commit where `sessionId` is already B but A's transcript is still mounted.
  // Anything that re-runs the effect below on that commit (a scroll event
  // flipping `isAtBottom` is the easy one — trackpad momentum alone will do it)
  // would restore A's DOM to B's saved offset and spend the one shot, leaving
  // B's real messages unrestored. The reset always empties the list, so the
  // first non-empty batch AFTER an empty commit is the incoming session's own.
  const sawClearRef = useRef(false);
  useEffect(() => {
    hasRestoredRef.current = false;
    sawClearRef.current = false;
    // A different chat's unread state means nothing here.
    sizeAtLeaveRef.current = null;
    setHasNewMessages(false);
  }, [sessionId]);

  useEffect(() => {
    if (chat.messages.length === 0) {
      sawClearRef.current = true;
      return;
    }

    if (!hasRestoredRef.current) {
      // Still the outgoing session's DOM — wait for the clear.
      if (!sawClearRef.current) return;
      // First time THIS session's messages are available — restore saved position
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
      } catch (err) {
        // The composer is cleared BEFORE the upload starts, so without this the
        // user's text and their attachments were both destroyed by a failed
        // upload and nothing was shown — the failure reached them only as an
        // unhandled rejection in a console they never open. Put the message
        // back exactly as it was so Send simply works on the retry.
        setInputValue(text);
        setPendingFiles(filesToUpload);
        toast.error(err instanceof Error ? err.message : "Upload failed");
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
        {showNoSession && !activeProviderId && (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-muted-foreground">Select an agent to start chatting.</p>
          </div>
        )}

        {(showSignIn || showInstall) && activeProviderId && agentSetup && (
          <div className="flex h-full items-center justify-center">
            <div className="w-full max-w-sm">
              <AgentSetupCard
                setup={agentSetup}
                mode={setupMode}
                state={agentSetupCard.state}
                surface="chat"
                resolvedCommand={remedyCommand(readiness)}
                onAction={agentSetupCard.onAction}
                onRetry={agentSetupCard.onRetry}
                onCancel={agentSetupCard.onCancel}
              />
            </div>
          </div>
        )}

        {showWaitingSkeleton && (
          <div className="flex h-full items-center justify-center">
            <div className="w-full max-w-xs space-y-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-4 w-56" />
            </div>
          </div>
        )}

        {showStuck && (
          <div className="flex h-full items-center justify-center">
            <div className="flex max-w-xs flex-col items-center gap-3 text-center">
              <p className="text-sm text-muted-foreground">
                libi is still waiting for {agentSetup?.name ?? activeProviderId} to open a chat
                session. It hasn&apos;t responded.
              </p>
              <Button
                type="button"
                className="cursor-pointer"
                onClick={() => activeProviderId && void selectAgent(activeProviderId)}
              >
                Retry
              </Button>
            </div>
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

        {/* Scroll to bottom pill — shown only when there is a REASON for it.
            Being scrolled up is not one: re-reading a finished conversation is
            a normal thing to do and does not deserve a permanent badge over the
            composer. The two reasons are the agent still writing (content is
            about to land below you) and content having already landed since you
            left the bottom. The second half is not redundant: without it the
            pill would disappear the instant a turn ended, stranding a user who
            is scrolled up with genuinely unread output and no way down. It
            cannot bring the nagging back either — `hasNewMessages` resets to
            false the moment they return to the bottom. */}
        <ScrollToBottomPill
          visible={!isAtBottom && chat.messages.length > 0 && (chat.isLoading || hasNewMessages)}
          hasNewMessages={hasNewMessages}
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
