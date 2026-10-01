import { NextResponse } from "next/server";
import { z } from "zod/v3";
import { socialRoute, jsonBody } from "@/lib/social/route-helpers";
import { planPieceMusic } from "@/lib/social/music-plan";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  pieceId: z.string().min(1),
  targets: z
    .array(
      z.object({
        platform: z.enum(["instagram", "tiktok", "youtube", "facebook", "twitter"]),
        accountId: z.string().min(1).optional(),
        music: z
          .object({
            mode: z.enum(["attach", "draft", "include", "strip"]).optional(),
            trackId: z.string().optional(),
            soundName: z.string().max(100).optional(),
          })
          .optional(),
      }),
    )
    .max(10),
});

/** The music plan for a piece's targets (spec §6). Read-only: nothing is posted. */
export async function POST(req: Request): Promise<Response> {
  return socialRoute("music.plan", async () => {
    const b = await jsonBody(req, bodySchema);
    if (!b.ok) return b.res;
    return NextResponse.json(await planPieceMusic(b.data.pieceId, b.data.targets));
  });
}
