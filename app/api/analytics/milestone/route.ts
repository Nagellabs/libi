// Marks an activation milestone server-side (once) and fires its first_* event
// on the server transport when newly marked. Client calls this so activation is
// recorded exactly once per install regardless of which surface triggered it.
import { NextResponse } from "next/server";
import { z } from "zod/v3";
import { markAnalyticsMilestoneOnce } from "@/lib/db/settings";
import { trackServerEvent } from "@/lib/analytics/server";
import { isEventName } from "@/lib/analytics/events";

const bodySchema = z.object({ name: z.string(), event: z.string() });

export async function POST(req: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success || !isEventName(parsed.data.event)) {
    return NextResponse.json({ error: "invalid milestone" }, { status: 400 });
  }
  const added = markAnalyticsMilestoneOnce(parsed.data.name);
  if (added) void trackServerEvent(parsed.data.event);
  return NextResponse.json({ fired: added });
}
