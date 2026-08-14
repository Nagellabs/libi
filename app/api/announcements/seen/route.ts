import { NextResponse } from "next/server";
import { markSeen } from "@/lib/announcements/seen-store";

const MAX_IDS = 50;
const MAX_ID_LENGTH = 128;

/**
 * POST /api/announcements/seen { ids: string[] } — record that this install
 * has displayed these announcements. Idempotent; bounded so a buggy client
 * cannot bloat the table.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const ids = (body as { ids?: unknown })?.ids;
  const valid =
    Array.isArray(ids) &&
    ids.length <= MAX_IDS &&
    ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= MAX_ID_LENGTH);
  if (!valid) {
    return NextResponse.json({ error: "Expected { ids: string[] }." }, { status: 400 });
  }

  markSeen(ids as string[]);
  return new NextResponse(null, { status: 204 });
}
