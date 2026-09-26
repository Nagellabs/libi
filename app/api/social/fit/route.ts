import { NextResponse } from "next/server";
import { z } from "zod/v3";
import { socialRoute, jsonBody } from "@/lib/social/route-helpers";
import { checkFit, probeExport } from "@/lib/social/fit-check";

export const dynamic = "force-dynamic";

const fitTargetSchema = z.object({
  platform: z.enum(["instagram", "tiktok"]),
  postType: z.string().min(1),
});

const fitBodySchema = z.object({
  exportPath: z.string().min(1),
  targets: z.array(fitTargetSchema).min(1),
});

/** `POST /api/social/fit` — the local, offline export fit check. No provider
 *  connection needed: reads the export with ffprobe and judges it against
 *  each requested target's platform limits, before anything is uploaded or
 *  sent. */
export async function POST(req: Request): Promise<Response> {
  return socialRoute("fit", async () => {
    const b = await jsonBody(req, fitBodySchema);
    if (!b.ok) return b.res;
    const probe = await probeExport(b.data.exportPath);
    const verdicts = b.data.targets.map((t) => checkFit(probe, t));
    return NextResponse.json({ probe, verdicts });
  });
}
