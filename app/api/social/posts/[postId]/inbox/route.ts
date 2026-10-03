import { NextResponse } from "next/server";
import { z } from "zod/v3";
import { getSocialSettings } from "@/lib/db/settings";
import { withAdapter } from "@/lib/social/service";
import { touchLinkStatus } from "@/lib/social/links";
import { planInboxSend } from "@/lib/social/inbox";
import { navigationEmitter } from "@/lib/navigation-events";
import { trackServerEvent } from "@/lib/analytics/server";
import { socialRoute, jsonBody } from "@/lib/social/route-helpers";
import { serverLogger as logger } from "@/lib/logger";
import { browserOnlyRefusal } from "@/lib/security/request-guard";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ requestId: z.string().uuid() });

/**
 * "Send to inbox": take a draft to the platform's own inbox (TikTok's inbox
 * upload), where the user finishes it in the app. It sends the draft to the
 * provider, so like publish it is the user's, from libi's own page
 * (`browserOnlyRefusal`). No agent tool reaches it — an agent points the user
 * at the Posting tab's button and never calls the provider's publish itself.
 *
 * It only ever sends a draft whose every target has an inbox: a draft that
 * also goes to a platform with no inbox would be PUBLISHED there by the same
 * provider call, so that is refused with the reason (`planInboxSend`).
 */
export async function POST(req: Request, { params }: { params: Promise<{ postId: string }> }): Promise<Response> {
  const refused = browserOnlyRefusal(req);
  if (refused) {
    logger.warn({ tag: "social", op: "posts.inbox_refused", reason: refused }, "send to inbox refused: not from libi's own page");
    return NextResponse.json({ error: "A draft is sent to an inbox only on libi's own page.", code: "browser_only" }, { status: 403 });
  }
  return socialRoute("posts.inbox", async () => {
    const { postId } = await params;
    const b = await jsonBody(req, bodySchema);
    if (!b.ok) return b.res;
    const providerId = getSocialSettings().providerId!;
    const post = await withAdapter((a) => a.getPost(postId));
    const plan = planInboxSend(post);
    if (!plan.ok) {
      logger.info({ tag: "social", op: "posts.inbox_not_possible", code: plan.code }, "send to inbox not possible");
      return NextResponse.json({ error: plan.code, message: plan.message }, { status: 422 });
    }
    const result = await withAdapter((a) => a.updatePost(postId, { requestId: b.data.requestId, ...plan.patch }));
    touchLinkStatus(providerId, result.post.id, result.post.status);
    navigationEmitter.emit("refresh_query", { queryKey: "social" });
    trackServerEvent("social_post_action", { provider: providerId, action: "send_to_inbox" });
    logger.info({ tag: "social", op: "posts.inbox_sent", platforms: plan.platforms }, "draft sent to the inbox");
    return NextResponse.json(result);
  });
}
