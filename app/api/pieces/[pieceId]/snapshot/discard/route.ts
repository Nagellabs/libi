import { NextResponse } from "next/server";
import { discardDraft } from "@/lib/composition/lifecycle";

interface RouteParams {
  params: Promise<{ pieceId: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  const { pieceId } = await params;
  const body = await req.json().catch(() => ({}));
  if (body.confirm !== true) {
    return NextResponse.json({ error: "confirm:true required" }, { status: 400 });
  }
  try {
    await discardDraft(pieceId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
