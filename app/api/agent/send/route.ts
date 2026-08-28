import { NextResponse } from "next/server";
import { getSessionManager } from "@/lib/sessions/session-manager";
import { formatFileSize } from "@/lib/utils/format";
import { trackServerEvent } from "@/lib/analytics/server";
import { markAnalyticsMilestoneOnce } from "@/lib/db/settings";
import { serverLogger as logger } from "@/lib/logger";

interface AttachmentInfo {
  fileId: string;
  filename: string;
  contentType: string | null;
  size: number;
  mediaDuration?: number | null;
  mediaWidth?: number | null;
  mediaHeight?: number | null;
}

function formatAttachments(attachments: AttachmentInfo[]): string {
  const lines = attachments.map((a) => {
    const parts: string[] = [];
    if (a.contentType) parts.push(a.contentType);
    parts.push(formatFileSize(a.size));
    if (a.mediaWidth && a.mediaHeight) parts.push(`${a.mediaWidth}x${a.mediaHeight}`);
    if (a.mediaDuration) parts.push(`${a.mediaDuration.toFixed(1)}s`);
    return `- ${a.filename} (${parts.join(", ")}) — fileId: ${a.fileId}`;
  });
  return `\n\n[Attached files]\n${lines.join("\n")}`;
}

export async function POST(request: Request) {
  const body = await request.json();
  const { text, sessionId, attachments } = body as {
    text?: string;
    sessionId?: string;
    attachments?: AttachmentInfo[];
  };

  if (!sessionId || (!text && (!attachments || attachments.length === 0))) {
    return NextResponse.json(
      { error: "sessionId and (text or attachments) required" },
      { status: 400 },
    );
  }

  const sm = getSessionManager();
  if (!sm.getSession(sessionId)) {
    return NextResponse.json(
      { error: "Unknown session" },
      { status: 404 },
    );
  }

  // Known but not attached — switching agents away and back clears the
  // session map and re-lists every persisted session as INACTIVE, while the
  // chat panel keeps displaying one of them. This used to be a dead-end 400
  // ("No active session") that the per-message Retry could never escape.
  // Reattach on demand through the ONE activation path — `activateSession`
  // dedupes against any concurrent activation (e.g. the sidebar's
  // GET /api/agent/messages) and is a warm-cache no-op when a race already
  // activated it.
  if (!sm.hasActiveSession(sessionId)) {
    try {
      await sm.activateSession(sessionId);
    } catch (err) {
      logger.warn(
        { tag: "session-manager", op: "send_reactivate_failed", sessionId, err },
        `Could not re-activate ${sessionId} for send`,
      );
      // Non-OK so the client flags the optimistic message `sendFailed` and
      // offers Retry — which comes back through this same path and succeeds
      // once activation does.
      return NextResponse.json(
        { error: "Could not reconnect this chat session — try sending again." },
        { status: 503 },
      );
    }
  }

  let messageText = text ?? "";
  if (attachments && attachments.length > 0) {
    messageText += formatAttachments(attachments);
  }

  sm.sendMessage(sessionId, messageText).catch((err) => {
    logger.error(
      { tag: "session-manager", op: "send_message_failed", sessionId, err },
      `Send error for ${sessionId}`,
    );
  });

  void trackServerEvent("agent_message_sent", {
    provider: sm.getSession(sessionId)?.agentId ?? "unknown",
    has_attachments: !!(attachments && attachments.length),
  });

  // Funnel step 11 (Task 14): the first message this INSTALL ever sent —
  // mark-once through the same primitive `POST /api/analytics/milestone`
  // wraps for client callers (this route is already server-side, so it
  // calls it directly rather than looping back through its own HTTP API —
  // same pattern as `first_launch` in instrumentation.ts). Deliberately NOT
  // `agent_message_sent` above: that fires every send, which would make this
  // step a message counter instead of a funnel step. Wrapped — a DB hiccup
  // here must never fail a send, same discipline as `markAgentConnected`
  // (lib/sessions/session-manager.ts).
  try {
    if (markAnalyticsMilestoneOnce("first_message")) {
      trackServerEvent("first_message_sent");
    }
  } catch {
    // best-effort; never break the send path
  }

  return NextResponse.json({ success: true });
}
