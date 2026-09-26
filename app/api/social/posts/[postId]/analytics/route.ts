import { NextResponse } from "next/server";
import { withAdapter } from "@/lib/social/service";
import { socialRoute } from "@/lib/social/route-helpers";
import type { SocialTarget, StoryInsights } from "@/lib/social/types";

export const dynamic = "force-dynamic";

/** A target that is an Instagram Story AND is live on Instagram, so its media id exists. */
function storyTargets(targets: SocialTarget[]): Array<SocialTarget & { platformPostId: string }> {
  return targets.filter(
    (t): t is SocialTarget & { platformPostId: string } =>
      t.platform === "instagram" &&
      t.options?.platform === "instagram" &&
      t.options.instagram.contentType === "story" &&
      !!t.platformPostId,
  );
}

/**
 * `GET /api/social/posts/:id/analytics`
 *
 * Post analytics, plus — for an Instagram STORY — the numbers the post
 * analytics endpoint structurally cannot carry.
 *
 * Measured 2026-09-21: a Story published at 07:59 was still
 * `syncStatus: "pending"` eight hours later, with `analytics: null`, after a
 * sync cycle had completed at 08:10; the account's own analytics list did not
 * contain the post at all. Stories are simply not in that sync. Their metrics
 * live behind Instagram's own story-insights endpoint, keyed by the story's
 * INSTAGRAM media id — which is the target's `platformPostId`.
 *
 * So a pending answer is not automatically "wait a little longer": it is the
 * permanent state for a Story, and the UI was telling the user to check back
 * in a few minutes forever. The extra `getPost` runs ONLY while the post
 * analytics are pending — once they are ready there is nothing to supplement,
 * and the common path stays a single provider call.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ postId: string }> }): Promise<Response> {
  return socialRoute("posts.analytics", async () => {
    const { postId } = await params;
    const analytics = await withAdapter((a) => a.postAnalytics(postId));
    if (analytics.syncStatus === "ready") return NextResponse.json(analytics);

    const post = await withAdapter((a) => a.getPost(postId));
    const stories = storyTargets(post.targets);
    if (stories.length === 0) return NextResponse.json(analytics);

    const insights: Array<{ accountId: string; platformPostId: string; insights: StoryInsights }> = await withAdapter((a) =>
      Promise.all(
        stories.map(async (t) => ({
          accountId: t.accountId,
          platformPostId: t.platformPostId,
          insights: await a.storyInsights(t.accountId, t.platformPostId),
        })),
      ),
    );
    return NextResponse.json({ ...analytics, stories: insights });
  });
}
