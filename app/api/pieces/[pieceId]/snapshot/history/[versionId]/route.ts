import { NextResponse } from "next/server";
import { getVersionDiff } from "@/lib/composition/lifecycle";

interface RouteParams {
  params: Promise<{ pieceId: string; versionId: string }>;
}

export async function GET(_req: Request, { params }: RouteParams) {
  const { pieceId, versionId } = await params;
  try {
    const result = await getVersionDiff(pieceId, versionId);
    return NextResponse.json(result);
  } catch (err) {
    const message = (err as Error).message;
    // A version id matching no row (e.g. history shifted between the list and
    // detail fetch) is a not-found, not a server error.
    const status = /not found/i.test(message) ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
