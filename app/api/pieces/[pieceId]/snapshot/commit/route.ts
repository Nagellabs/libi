import { NextResponse } from "next/server";
import { storyboardBusyResponse } from "@/lib/storyboard/busy-response";
import { commitDraft } from "@/lib/composition/lifecycle";

interface RouteParams {
  params: Promise<{ pieceId: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  const { pieceId } = await params;
  const body = await req.json().catch(() => ({}));
  const summary = typeof body.summary === "string" ? body.summary : "Manual edits";
  try {
    const result = await commitDraft(pieceId, { summary, actor: "user" });
    return NextResponse.json(result);
  } catch (err) {
    return storyboardBusyResponse(err) ?? NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
