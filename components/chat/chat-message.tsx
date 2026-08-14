"use client";

import { memo, useMemo, useState } from "react";
import type { AgentMessage } from "@/hooks/sessions/use-agent-chat";
import type { AgentMessagePart } from "@/lib/agents/message-types";
import type { FileRecord } from "@/lib/db/schema/types";
import { AlertCircle, Check, Copy, RotateCcw } from "lucide-react";
import MarkdownMessage from "./markdown-message";
import ThoughtSection from "./thought-section";
import ToolCallGroup, { type ToolCallPart, type ToolResultPart } from "./tool-call-group";
import { SubagentCard } from "./subagent-card";
import { PermissionRequestCard } from "./permission-request-card";
import FileAttachmentChip from "./file-attachment-chip";
import { ChatMediaCard } from "./chat-media-card";
import {
  extractChatMedia,
  isShowInChatCall,
  type ChatMediaPayload,
} from "@/lib/chat/chat-media";

interface ChatMessageProps {
  message: AgentMessage;
  animate: boolean;
  /** Session this message belongs to — needed by interactive parts (e.g.
   *  permission-request cards POST their answer to a session-scoped route). */
  sessionId: string | null;
  /** Opens the attachment in the assets panel — the parent (ChatPanel) plumbs
   *  this up to the editor page which switches piece + tab + selected asset. */
  onOpenAsset?: (file: FileRecord) => void;
  /** Re-sends a user message whose POST never reached the server
   *  (`message.sendFailed`). Plumbed from `useAgentChat.retryMessage`. */
  onRetry?: (messageId: string) => void;
}

type GroupedPart =
  | { type: "text"; text: string; isThought: boolean }
  | { type: "tool-group"; entries: Array<{ call: ToolCallPart; result?: ToolResultPart }> }
  | { type: "chat-media"; payload: ChatMediaPayload }
  | { type: "file-attachment"; fileId: string; filename: string; contentType: string | null; size: number }
  | { type: "subagent"; part: Extract<AgentMessagePart, { type: "subagent" }> }
  | { type: "permission-request"; part: Extract<AgentMessagePart, { type: "permission-request" }> };

function groupParts(parts: AgentMessagePart[]): GroupedPart[] {
  const groups: GroupedPart[] = [];

  const resultMap = new Map<string, ToolResultPart>();
  for (const p of parts) {
    if (p.type === "tool-result") {
      resultMap.set(p.toolCallId, p);
    }
  }

  let currentToolGroup: Array<{ call: ToolCallPart; result?: ToolResultPart }> | null = null;

  for (const part of parts) {
    if (part.type === "text" || part.type === "thought") {
      // Whitespace-only chunks (e.g. a "\n\n" separator between content
      // blocks) carry nothing to render — an empty MarkdownMessage would
      // show just a streaming cursor and an empty ThoughtSection just a
      // bare "thinking" header. Skip them; they also must not split an
      // adjacent run of tool calls into two groups.
      if (part.text.trim().length === 0) continue;
      if (currentToolGroup) {
        groups.push({ type: "tool-group", entries: currentToolGroup });
        currentToolGroup = null;
      }
      groups.push({
        type: "text",
        text: part.text,
        isThought: part.type === "thought",
      });
    } else if (part.type === "file-attachment") {
      if (currentToolGroup) {
        groups.push({ type: "tool-group", entries: currentToolGroup });
        currentToolGroup = null;
      }
      groups.push({
        type: "file-attachment",
        fileId: part.fileId,
        filename: part.filename,
        contentType: part.contentType,
        size: part.size,
      });
    } else if (part.type === "subagent") {
      if (currentToolGroup) {
        groups.push({ type: "tool-group", entries: currentToolGroup });
        currentToolGroup = null;
      }
      groups.push({ type: "subagent", part });
    } else if (part.type === "permission-request") {
      if (currentToolGroup) {
        groups.push({ type: "tool-group", entries: currentToolGroup });
        currentToolGroup = null;
      }
      groups.push({ type: "permission-request", part });
    } else if (part.type === "tool-call") {
      // show_in_chat is a pure presentation tool — suppress its chip and, once
      // its result has arrived, render an inline media card in its place.
      if (isShowInChatCall(part)) {
        const result = resultMap.get(part.toolCallId);
        const payload = extractChatMedia(part, result);
        if (payload) {
          if (currentToolGroup) {
            groups.push({ type: "tool-group", entries: currentToolGroup });
            currentToolGroup = null;
          }
          groups.push({ type: "chat-media", payload });
        }
        // No result yet (tool still running) → render nothing; the card
        // appears when the file is ready. Never add it to the tool group.
        continue;
      }
      if (!currentToolGroup) currentToolGroup = [];
      currentToolGroup.push({
        call: part,
        result: resultMap.get(part.toolCallId),
      });
    }
  }

  if (currentToolGroup) {
    groups.push({ type: "tool-group", entries: currentToolGroup });
  }

  return groups;
}

function formatTimestamp(ts: number): string {
  const now = Date.now();
  const diffMs = now - ts;
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;

  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default memo(function ChatMessage({ message, animate, sessionId, onOpenAsset, onRetry }: ChatMessageProps) {
  const [copied, setCopied] = useState(false);
  const isUser = message.role === "user";
  const isStreaming = !isUser && message.isStreaming;

  const groups = useMemo(() => {
    if (isUser) return null;
    return groupParts(message.parts);
  }, [isUser, message.parts]);

  const handleCopy = () => {
    const text = message.parts
      .filter((p): p is Extract<AgentMessagePart, { type: "text" }> => p.type === "text")
      .map((p) => p.text)
      .join("\n\n");
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // --- User message ---
  if (isUser) {
    const textParts = message.parts.filter(
      (p): p is Extract<AgentMessagePart, { type: "text" }> => p.type === "text",
    );
    const fileParts = message.parts.filter(
      (p): p is Extract<AgentMessagePart, { type: "file-attachment" }> =>
        p.type === "file-attachment",
    );
    const text = textParts.map((p) => p.text).join("\n");

    return (
      <div className={`group ${animate ? "animate-message-in" : ""}`}>
        <div className="flex justify-end">
          <div className="max-w-[75%] space-y-1.5">
            {fileParts.length > 0 && (
              <div className="flex flex-wrap justify-end gap-1.5">
                {fileParts.map((f) => (
                  <FileAttachmentChip
                    key={f.fileId}
                    fileId={f.fileId}
                    filename={f.filename}
                    contentType={f.contentType}
                    size={f.size}
                    onOpen={onOpenAsset}
                  />
                ))}
              </div>
            )}
            {text && (
              <div
                className={`rounded-2xl bg-[color:var(--user-bubble)] px-4 py-2.5 text-[15px] leading-relaxed text-[color:var(--user-bubble-foreground)] ${
                  message.sendFailed ? "opacity-60" : ""
                }`}
              >
                <p className="whitespace-pre-wrap">{text}</p>
              </div>
            )}
            {message.sendFailed && (
              <div className="flex items-center justify-end gap-2 text-xs text-destructive">
                <AlertCircle className="h-3.5 w-3.5" />
                <span>Not sent</span>
                {onRetry && (
                  <button
                    type="button"
                    onClick={() => onRetry(message.id)}
                    className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-destructive/40 px-2 py-0.5 font-medium text-destructive transition-colors hover:bg-destructive/10"
                  >
                    <RotateCcw className="h-3 w-3" />
                    Retry
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="mt-0.5 flex justify-end opacity-0 transition-opacity group-hover:opacity-100">
          <span className="text-xs text-muted-foreground">
            {formatTimestamp(message.timestamp)}
          </span>
        </div>
      </div>
    );
  }

  // --- Agent message ---
  // An agent message with nothing renderable (e.g. the empty placeholder
  // `sendMessage` pushes before the reply streams, or a turn that produced
  // no text/tool parts) must NOT render its wrapper + timestamp footer —
  // that empty block is the "big gap" between messages. The live "thinking"
  // indicator is owned separately by ChatPanel (`isStreamingWithoutText`).
  if (!groups || groups.length === 0) return null;

  const hasTextContent = message.parts.some((p) => p.type === "text");

  return (
    <div className={`group relative ${animate ? "animate-message-in" : ""}`}>
      {/* Copy button — top right, hover only */}
      {hasTextContent && (
        <button
          onClick={handleCopy}
          className="absolute right-0 top-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
          title="Copy message"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-emerald-500" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </button>
      )}

      {groups?.map((group, i) => {
        if (group.type === "text" && group.isThought) {
          // Active = still streaming and no non-thought text follows
          const hasFollowingText = groups
            .slice(i + 1)
            .some((g) => g.type === "text" && !g.isThought);
          const active = isStreaming === true && !hasFollowingText;

          return (
            <ThoughtSection key={i} text={group.text} active={active} />
          );
        }

        if (group.type === "text") {
          const isLastText =
            isStreaming === true &&
            groups.slice(i + 1).every((g) => g.type !== "text");

          return (
            <MarkdownMessage
              key={i}
              content={group.text}
              streaming={isLastText}
            />
          );
        }

        if (group.type === "tool-group") {
          // Active = still streaming and no non-thought text follows this group
          const hasFollowingText = groups
            .slice(i + 1)
            .some((g) => g.type === "text" && !g.isThought);
          const toolsActive = isStreaming === true && !hasFollowingText;

          return <ToolCallGroup key={i} entries={group.entries} active={toolsActive} />;
        }

        if (group.type === "subagent") {
          return <SubagentCard key={group.part.toolCallId} part={group.part} />;
        }

        if (group.type === "permission-request") {
          if (!sessionId) return null;
          return (
            <PermissionRequestCard
              key={group.part.pendingId}
              sessionId={sessionId}
              pendingId={group.part.pendingId}
              toolCall={group.part.toolCall}
              options={group.part.options}
              reason={group.part.reason}
              status={group.part.status}
              outcome={group.part.outcome}
            />
          );
        }

        if (group.type === "chat-media") {
          return <ChatMediaCard key={i} payload={group.payload} />;
        }

        if (group.type === "file-attachment") {
          return (
            <FileAttachmentChip
              key={i}
              fileId={group.fileId}
              filename={group.filename}
              contentType={group.contentType}
              size={group.size}
              onOpen={onOpenAsset}
            />
          );
        }

        return null;
      })}

      <div className="mt-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <span className="text-xs text-muted-foreground">
          {formatTimestamp(message.timestamp)}
        </span>
      </div>
    </div>
  );
});
