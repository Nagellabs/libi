import { NextResponse } from "next/server";
import { getSessionManager } from "@/lib/sessions/session-manager";
import { serverLogger as logger } from "@/lib/logger";
import { browserOnlyRefusal } from "@/lib/security/request-guard";

/**
 * POST /api/sessions/:sessionId/forget — "Remove from list" on a chat whose history is gone, or
 * that the agent's listing no longer has (an unlisted row, SES-4).
 *
 * libi keeps its own index of the chats it has shown (`lib/sessions/session-index.ts`), so a chat
 * whose transcript was deleted stays listed and opens into its "history isn't on this computer any
 * more" note. This deletes that index entry and drops the row (`SessionManager.forgetSession`). It
 * never touches a transcript. Refused (409) for a chat the agent still lists; 404 for one libi does
 * not hold in memory (nothing to vouch its history is gone, so its index entry is kept).
 *
 * User-only (`browserOnlyRefusal`), like Restart session: the agent's shell must not hide chats
 * from the user's list with a header-less curl. Its one caller is the session menu.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  const refused = browserOnlyRefusal(req);
  if (refused) {
    logger.warn(
      { tag: "session-manager", op: "session_forget_refused", reason: refused },
      "remove-from-list refused: not from libi's own page",
    );
    return NextResponse.json(
      { error: "A chat is removed from the list only from libi's own window.", code: "browser_only" },
      { status: 403 },
    );
  }
  const { sessionId } = await params;
  const outcome = getSessionManager().forgetSession(sessionId);
  if (outcome === "forgotten") return NextResponse.json({ ok: true });
  if (outcome === "not_found") {
    return NextResponse.json({ error: "libi doesn't know this chat.", code: "not_found" }, { status: 404 });
  }
  return NextResponse.json(
    { error: "Only a chat whose history is gone, or that the agent no longer lists, can be removed from the list.", code: "has_history" },
    { status: 409 },
  );
}
