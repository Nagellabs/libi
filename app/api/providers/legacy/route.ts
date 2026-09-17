import { NextResponse } from "next/server";
import { pendingLegacyKeyNotices, acknowledgeLegacyKey } from "@/lib/providers/legacy";
import { serverLogger as logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * The one-time "here is the key you gave libi" notice. GET lists
 * what is still unacknowledged — command text with the key substituted, so
 * this response is the one place a provider secret crosses to the browser,
 * and only until the user says they have copied it. POST clears it for good.
 */
export async function GET(): Promise<Response> {
  return NextResponse.json({ notices: pendingLegacyKeyNotices() });
}

export async function POST(req: Request): Promise<Response> {
  let body: { rowId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.rowId !== "string" || body.rowId.length === 0) {
    return NextResponse.json({ error: "rowId required" }, { status: 400 });
  }
  // Same failure modes GET degrades on (an unreadable table): answer with a
  // structured 500 rather than letting Next render the throw. Never log the
  // key value — the rowId is all this route ever knows by name.
  try {
    acknowledgeLegacyKey(body.rowId);
  } catch (err) {
    logger.warn({ err, tag: "providers", op: "legacy_ack_failed", rowId: body.rowId }, "legacy provider key could not be cleared");
    return NextResponse.json({ error: "legacy-ack-failed" }, { status: 500 });
  }
  // The key value is gone from here on — say so, and never log the value.
  logger.info(
    { tag: "providers", op: "legacy_acknowledged", rowId: body.rowId },
    "legacy provider key cleared",
  );
  return NextResponse.json({ ok: true });
}
