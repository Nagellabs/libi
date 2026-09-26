import { NextResponse } from "next/server";
import { withAdapter } from "@/lib/social/service";
import { socialRoute } from "@/lib/social/route-helpers";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  return socialRoute("tiktok.creator_info", async () => {
    const accountId = new URL(req.url).searchParams.get("accountId");
    if (!accountId) return NextResponse.json({ error: "accountId required" }, { status: 400 });
    const info = await withAdapter((a) => a.tiktokCreatorInfo(accountId));
    return NextResponse.json(info);
  });
}
