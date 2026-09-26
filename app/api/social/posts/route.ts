import { NextResponse } from "next/server";
import { z } from "zod/v3";
import { getSocialSettings } from "@/lib/db/settings";
import { withAdapter } from "@/lib/social/service";
import { linkForPost, insertLink, touchLinkStatus } from "@/lib/social/links";
import { navigationEmitter } from "@/lib/navigation-events";
import { trackServerEvent } from "@/lib/analytics/server";
import { socialRoute, jsonBody } from "@/lib/social/route-helpers";
import { serverLogger as logger } from "@/lib/logger";
import { browserOnlyRefusal } from "@/lib/security/request-guard";
import type { PostListFilter } from "@/lib/social/types";

export const dynamic = "force-dynamic";

const listQuery = (u: URL): PostListFilter => ({
  status: u.searchParams.get("status")?.split(",").filter(Boolean) as PostListFilter["status"],
  platform: (u.searchParams.get("platform") as PostListFilter["platform"]) ?? undefined,
  accountId: u.searchParams.get("accountId") ?? undefined,
  from: u.searchParams.get("from") ?? undefined,
  to: u.searchParams.get("to") ?? undefined,
  page: Number(u.searchParams.get("page") ?? 1),
  limit: Math.min(Number(u.searchParams.get("limit") ?? 50), 100),
});

/** `GET /api/social/posts` — every post decorated with its local link row
 *  (`null` when the post was never linked to a piece, e.g. posted straight
 *  from Zernio's own dashboard). */
export async function GET(req: Request): Promise<Response> {
  return socialRoute("posts.list", async () => {
    const providerId = getSocialSettings().providerId!;
    const page = await withAdapter((a) => a.listPosts(listQuery(new URL(req.url))));
    return NextResponse.json({ ...page, posts: page.posts.map((p) => ({ ...p, link: linkForPost(providerId, p.id) })) });
  });
}

const targetOptions = z.discriminatedUnion("platform", [
  z.object({
    platform: z.literal("instagram"),
    instagram: z.object({
      contentType: z.enum(["reel", "feed", "story"]),
      shareToFeed: z.boolean().optional(),
      commentsEnabled: z.boolean().optional(),
      isAiGenerated: z.boolean().optional(),
      collaborators: z.array(z.string()).max(3).optional(),
      firstComment: z.string().optional(),
    }),
  }),
  z.object({
    platform: z.literal("tiktok"),
    tiktok: z.object({
      privacyLevel: z.string().min(1),
      allowComment: z.boolean(),
      allowDuet: z.boolean(),
      allowStitch: z.boolean(),
      commercialContentType: z.enum(["none", "brand_organic", "brand_content"]),
      madeWithAi: z.boolean().optional(),
      coverTimestampMs: z.number().int().nonnegative().optional(),
      contentPreviewConfirmed: z.literal(true),
      expressConsentGiven: z.literal(true),
    }),
  }),
]);

/** `metadata.libi`'s own fields (never `targetOptions` — that is always
 *  derived server-side from `targets`, in `toCreateBody` / `toUpdateBody`, so
 *  a client can never send one that disagrees with the targets it also
 *  sent). Exported so `PATCH /:postId` extends it with `requestId` rather
 *  than declaring its own, separate shape for the fields both writes share. */
export const postLibiSchema = z.object({ pieceId: z.string().min(1), pieceName: z.string().optional(), exportFile: z.string().optional(), appVersion: z.string().optional() });

/** The shared body of every write route on this feature — exported so
 *  `PATCH /:postId` (`.shape`) and `POST /validate` (`.omit`) build on the
 *  same schema instead of drifting from it. */
export const createPostSchema = z.object({
  requestId: z.string().uuid(),
  content: z.string().max(2200),
  media: z.array(z.object({ url: z.string().url(), type: z.enum(["video", "image"]), filename: z.string().optional(), sizeBytes: z.number().optional(), mimeType: z.string().optional() })),
  targets: z.array(z.object({ platform: z.enum(["instagram", "tiktok"]), accountId: z.string().min(1), options: targetOptions })),
  when: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("draft") }),
    z.object({ mode: z.literal("schedule"), scheduledFor: z.string().min(1), timezone: z.string().min(1) }),
    z.object({ mode: z.literal("now") }),
  ]),
  libi: postLibiSchema,
  republishConfirmedByUser: z.literal(true).optional(),
  exportPath: z.string().optional(),
  /**
   * **Defaults to `"agent"`, the restricted value.** It used to default to
   * `"ui"`, which made the agent-draft-only rule below fail OPEN: any caller
   * that simply omitted the field — a future agent-facing route, a replayed
   * body, a bug — was waved through as the user. libi's own composer says
   * `createdBy: "ui"` explicitly (`composer.tsx`), so the strict default
   * costs the UI nothing and a caller that forgets it gets the drafts-only
   * rule rather than a publish.
   */
  createdBy: z.enum(["ui", "agent"]).default("agent"),
});

/** `POST /api/social/posts` — writes the local link row for the piece
 *  (`social_post_links`, keyed by the provider's post id) so the piece's
 *  Posting tab can list its own posts without a provider-side filter, and
 *  emits/tracks on success only — a dedupe (`deduped: true`) still counts as
 *  success here; it is not a new post but it is not a failure either. */
export async function POST(req: Request): Promise<Response> {
  return socialRoute("posts.create", async () => {
    const b = await jsonBody(req, createPostSchema);
    if (!b.ok) return b.res;
    const { exportPath, createdBy, ...input } = b.data;
    // `createdBy: "ui"` is the user acting from the composer, so it takes the
    // browser-only checks: a header-less loopback caller (an agent's shell, a
    // curl) that merely CLAIMS to be the UI is refused. An agent's draft
    // (`createdBy: "agent"`, from `libi.post_piece`) is not a user-only action
    // and keeps working from the MCP child; the draft-only rule below covers it.
    if (createdBy === "ui") {
      const refused = browserOnlyRefusal(req);
      if (refused) {
        logger.warn({ tag: "social", op: "posts.create_refused", reason: refused }, "post as the user refused: not from libi's own page");
        return NextResponse.json({ error: "Posting as you happens only on libi's own page.", code: "browser_only" }, { status: 403 });
      }
    }
    // An agent may only ever create a DRAFT. Today that is already true by
    // construction — `libi.post_piece` is the one agent-facing writer and its
    // schema cannot express a publish — but that is the tool's shape, not this
    // route's rule, so a second agent-facing caller could regress it in
    // silence. The backstop lives here, where the decision actually lands.
    if (createdBy === "agent" && input.when.mode !== "draft") {
      return NextResponse.json(
        { error: "agent_draft_only", message: "An agent can only create a draft. Publishing and scheduling are the user's to do." },
        { status: 422 },
      );
    }
    const providerId = getSocialSettings().providerId!;
    const result = await withAdapter((a) => a.createPost(input));
    insertLink({ providerId, providerPostId: result.post.id, pieceId: input.libi.pieceId, exportPath: exportPath ?? null, requestId: input.requestId, createdBy });
    touchLinkStatus(providerId, result.post.id, result.post.status);
    navigationEmitter.emit("refresh_query", { queryKey: "social", pieceId: input.libi.pieceId });
    trackServerEvent("social_post_created", {
      provider: providerId,
      platform_count: input.targets.length >= 3 ? "3+" : String(input.targets.length),
      mode: input.when.mode,
      source: createdBy,
    });
    return NextResponse.json(result);
  });
}
