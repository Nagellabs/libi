import { NextResponse } from "next/server";
import { detectProviders } from "@/lib/providers/detect";
import { clearLegacyKeysForConnected } from "@/lib/providers/legacy";
import { serverLogger as logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/** What the user's agents already have. Never returns a key.
 *
 *  `?refresh=1` is the tab's Retry: codex is asked again instead of answering
 *  from a listing it failed a moment ago, joining a listing already running.
 *
 *  The one write on this path is the reverse: a provider the user has
 *  reconnected themselves is a provider whose rescued legacy key libi has no
 *  business still holding, so seeing it here drops it. Only a row read just now
 *  counts: a Codex row served from codex's last good listing (`stale`) does not.
 *  It never throws and never blocks the answer.
 *
 *  `codex` says when Codex's rows are not a fresh answer — see
 *  `ProviderDetection` in lib/providers/detect.ts. */
export async function GET(request: Request): Promise<Response> {
  const refresh = new URL(request.url).searchParams.get("refresh") === "1";
  try {
    const detection = await (refresh ? detectProviders({ refresh: true }) : detectProviders());
    clearLegacyKeysForConnected(detection.connected.filter((row) => !row.stale));
    return NextResponse.json(detection);
  } catch (err) {
    // Detection is best-effort: an empty list with an error note lets the
    // panel render instead of blanking behind React Query's retry.
    logger.warn({ err, tag: "providers", op: "detect_failed" }, "provider detection failed");
    return NextResponse.json({ connected: [], error: "detection failed" }, { status: 200 });
  }
}
