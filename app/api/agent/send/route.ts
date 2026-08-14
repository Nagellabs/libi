import { NextResponse } from "next/server";
import { getSessionManager } from "@/lib/sessions/session-manager";
import { formatFileSize } from "@/lib/utils/format";
import { trackServerEvent } from "@/lib/analytics/server";
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
  if (!sm.hasActiveSession(sessionId)) {
    return NextResponse.json(
      { error: "No active session" },
      { status: 400 },
    );
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

  return NextResponse.json({ success: true });
}
