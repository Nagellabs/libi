import { NextResponse } from "next/server";
import { z } from "zod/v3";
import { getSocialSettings } from "@/lib/db/settings";
import { withAdapter } from "@/lib/social/service";
import { linkForPost, touchLinkStatus } from "@/lib/social/links";
import { navigationEmitter } from "@/lib/navigation-events";
import { trackServerEvent } from "@/lib/analytics/server";
import { socialRoute, jsonBody } from "@/lib/social/route-helpers";
import { createPostSchema, postLibiSchema } from "@/app/api/social/posts/route";
import { serverLogger as logger } from "@/lib/logger";
import { browserOnlyRefusal } from "@/lib/security/request-guard";
import { goneCatalogTrack, goneTrackMessage } from "@/lib/social/music-validate";
import { musicOfTarget } from "@/lib/social/post-music";
import type { CreatePostInput, SocialPost } from "@/lib/social/types";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ postId: string }> }): Promise<Response> {
  return socialRoute("posts.get", async () => {
    const { postId } = await params;
    const providerId = getSocialSettings().providerId!;
    const post = await withAdapter((a) => a.getPost(postId));
    return NextResponse.json({ ...post, link: linkForPost(providerId, postId) });
  });
}

const updatePostSchema = z.object({
  requestId: z.string().uuid(),
  content: z.string().max(2200).optional(),
  // Media has to be RE-SENT on an update: the provider carries none over, and
  // the URL it echoes back on a read is a promoted copy that 404s (see
  // `toUpdateBody`). The caller sends the original upload URL, which is why
  // this takes the same shape as create's.
  media: createPostSchema.shape.media.optional(),
  targets: createPostSchema.shape.targets.optional(),
  when: z.union([createPostSchema.shape.when, z.object({ mode: z.literal("cancel") })]).optional(),
  // The post's OWN existing `metadata.libi`, echoed back by the caller so the
  // write can extend it (`targetOptions`, derived server-side from `targets`
  // in `toUpdateBody`) rather than replacing it — see `toUpdateBody`'s own
  // comment for why omitting this on a write that touches metadata erases
  // `pieceId` / `requestId` from the post.
  libi: postLibiSchema.extend({ requestId: z.string().optional(), mediaUrl: z.string().optional() }).optional(),
  /** Same closed default as `POST /api/social/posts`: absent means AGENT, so
   *  the rule below fails closed. libi's own UI sends `"ui"` from
   *  `useUpdateSocialPost`. */
  createdBy: createPostSchema.shape.createdBy,
});

function actionFor(when: z.infer<typeof updatePostSchema>["when"]): "schedule" | "publish" | "cancel" | "edit" {
  if (when?.mode === "cancel") return "cancel";
  if (when?.mode === "now") return "publish";
  if (when?.mode === "schedule") return "schedule";
  return "edit";
}

/** An existing post's targets with the music libi stamped on them
 *  (`metadata.libi.targetOptions`) — only the ones that carry a stamp. */
function stampedTargets(post: SocialPost): CreatePostInput["targets"] {
  return post.targets.flatMap((t, i) => {
    const music = musicOfTarget(post, i);
    const stamped = post.libi?.targetOptions?.[i];
    return music && stamped ? [{ platform: stamped.platform, accountId: t.accountId, options: { ...stamped, music } }] : [];
  });
}

/** Editing, scheduling, publishing and cancelling an existing post are the
 *  user's, from libi's own page (`browserOnlyRefusal`). No agent tool edits a
 *  post — `libi.post_piece` only creates drafts — so the `createdBy: "agent"`
 *  backstop below is defence in depth behind this check, not the agent path. */
export async function PATCH(req: Request, { params }: { params: Promise<{ postId: string }> }): Promise<Response> {
  const refused = browserOnlyRefusal(req);
  if (refused) {
    logger.warn({ tag: "social", op: "posts.update_refused", reason: refused }, "post edit refused: not from libi's own page");
    return NextResponse.json({ error: "Posts are edited only on libi's own page.", code: "browser_only" }, { status: 403 });
  }
  return socialRoute("posts.update", async () => {
    const { postId } = await params;
    const b = await jsonBody(req, updatePostSchema);
    if (!b.ok) return b.res;
    const { createdBy, ...patch } = b.data;
    // The SAME backstop `POST /api/social/posts` carries, on the route that
    // can take an existing draft public. `libi.post_piece` cannot express a
    // publish, but that is the tool's shape, not this route's rule — and this
    // route accepts `{mode: "now"}` and `{mode: "schedule"}` from anyone. An
    // agent may edit a draft, cancel a schedule or push it back to draft;
    // deciding when something goes out is the user's.
    if (createdBy === "agent" && (patch.when?.mode === "now" || patch.when?.mode === "schedule")) {
      return NextResponse.json(
        { error: "agent_draft_only", message: "An agent can only create a draft. Publishing and scheduling are the user's to do." },
        { status: 422 },
      );
    }
    // The same check `POST /api/social/posts` makes, when this write
    // schedules or publishes. A reschedule of an existing draft carries no targets (the
    // composer sends only `{requestId, when}`), so the post's own stamped
    // targets are read back and checked instead.
    if (patch.when?.mode === "schedule" || patch.when?.mode === "now") {
      const bodyTargets = patch.targets;
      const gone = await withAdapter(async (a) =>
        goneCatalogTrack(a, bodyTargets ?? stampedTargets(await a.getPost(postId))),
      );
      if (gone) return NextResponse.json({ error: "validation", message: goneTrackMessage(gone) }, { status: 422 });
    }
    const providerId = getSocialSettings().providerId!;
    const result = await withAdapter((a) => a.updatePost(postId, patch));
    touchLinkStatus(providerId, result.post.id, result.post.status);
    navigationEmitter.emit("refresh_query", { queryKey: "social" });
    trackServerEvent("social_post_action", { provider: providerId, action: actionFor(patch.when) });
    return NextResponse.json(result);
  });
}

/** Deleting a post is the user's, from libi's own page (`browserOnlyRefusal`). */
export async function DELETE(req: Request, { params }: { params: Promise<{ postId: string }> }): Promise<Response> {
  const refused = browserOnlyRefusal(req);
  if (refused) {
    logger.warn({ tag: "social", op: "posts.delete_refused", reason: refused }, "post delete refused: not from libi's own page");
    return NextResponse.json({ error: "Posts are deleted only on libi's own page.", code: "browser_only" }, { status: 403 });
  }
  return socialRoute("posts.delete", async () => {
    const { postId } = await params;
    const providerId = getSocialSettings().providerId!;
    await withAdapter((a) => a.deletePost(postId));
    touchLinkStatus(providerId, postId, "deleted");
    navigationEmitter.emit("refresh_query", { queryKey: "social" });
    trackServerEvent("social_post_action", { provider: providerId, action: "delete" });
    return NextResponse.json({ ok: true });
  });
}
