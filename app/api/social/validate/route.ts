import { NextResponse } from "next/server";
import { z } from "zod/v3";
import { withAdapter } from "@/lib/social/service";
import { socialRoute, jsonBody } from "@/lib/social/route-helpers";
import { createPostSchema } from "@/app/api/social/posts/route";

export const dynamic = "force-dynamic";

const validateBodySchema = createPostSchema.omit({ exportPath: true, createdBy: true }).extend({
  /**
   * TikTok's own pre-flight, which is a DIFFERENT provider call from
   * `validatePost`: `posts_create_post` with `dry_run: true` answers
   * `{ dryRun, canPublish, tiktok[] }` and creates nothing (verified live,
   * `.superpowers/sdd/zernio-live-shapes.md`). The composer asks for it
   * before a schedule or a publish — never before a draft, which reaches no
   * platform.
   */
  dryRun: z.boolean().optional(),
});

export async function POST(req: Request): Promise<Response> {
  return socialRoute("validate", async () => {
    const b = await jsonBody(req, validateBodySchema);
    if (!b.ok) return b.res;
    const { dryRun, ...input } = b.data;
    if (dryRun) return NextResponse.json({ dryRun: true, ...(await withAdapter((a) => a.dryRunTikTok(input))) });
    const result = await withAdapter((a) => a.validatePost(input));
    return NextResponse.json(result);
  });
}
