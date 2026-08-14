import { NextResponse } from "next/server";
import { getVersionHistory } from "@/lib/composition/lifecycle";

interface RouteParams {
  params: Promise<{ pieceId: string }>;
}

export async function GET(_req: Request, { params }: RouteParams) {
  const { pieceId } = await params;
  try {
    const versions = await getVersionHistory(pieceId);
    return NextResponse.json({ versions });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
