import { NextResponse } from "next/server";
import { z } from "zod/v3";
import { isEventName } from "@/lib/analytics/events";
import { trackServerEvent } from "@/lib/analytics/server";

const bodySchema = z.object({
  name: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(req: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success || !isEventName(parsed.data.name)) {
    return NextResponse.json({ error: "invalid event" }, { status: 400 });
  }
  void trackServerEvent(parsed.data.name, parsed.data.params);
  return NextResponse.json({ ok: true });
}
