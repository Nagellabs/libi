import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { files } from "@/lib/db/schema";
import { getCurrentPort } from "@/lib/libi-home";
import { classifyChatMedia } from "@/lib/chat/chat-media";
import type { ToolResult } from "./types";

/**
 * `libi.show_in_chat` — render an agent-created asset (image / video / audio)
 * inline in the in-app chat for a salient result. Surface-gated: registered
 * only for the in-app ACP chat (see mcp/server.ts + lib/mcp-config.ts). The
 * result carries a `chatMedia` payload the chat turns into an inline card, plus
 * an absolute `url` (clickable in a terminal's link addon for the BYO-CLI
 * fallback path).
 */
export async function showInChat(params: {
  fileId: string;
  caption?: string;
}): Promise<ToolResult> {
  const { fileId, caption } = params;
  const db = getDb();
  const [row] = db.select().from(files).where(eq(files.id, fileId)).limit(1).all();
  if (!row) {
    return { success: false, error: "file_not_found" };
  }

  const kind = classifyChatMedia(row.contentType);

  let url: string | undefined;
  try {
    url = `http://localhost:${getCurrentPort()}/api/files/by-id/${fileId}/content`;
  } catch {
    // Port file unavailable (server not fully up) — omit the URL; the in-app
    // card still renders from the relative content route.
    url = undefined;
  }

  return {
    success: true,
    data: {
      chatMedia: {
        fileId,
        kind,
        contentType: row.contentType ?? null,
        filename: row.filename,
        ...(caption ? { caption } : {}),
      },
      ...(url ? { url } : {}),
    },
  };
}
