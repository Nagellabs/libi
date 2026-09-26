import { NextResponse } from "next/server";
import { detectProviders } from "@/lib/providers/detect";
import { clearLegacyKeysForConnected } from "@/lib/providers/legacy";
import { serverLogger as logger } from "@/lib/logger";
import { isTestMode } from "@/lib/test-mode";
import { TEST_MODE_STDIO_FAKE_NAMES, testModeFakesEnabled } from "@/lib/mcp-config";

export const dynamic = "force-dynamic";

/** What the user's agents already have. Never returns a key.
 *
 *  `?refresh=1` is the tab's Retry: codex is asked again instead of answering
 *  from a listing it failed a moment ago, joining a listing already running.
 *
 *  `?revalidate=1` says the user just looked (the tab opened or came back into
 *  view): Claude Code is asked again about each entry whose answer is not
 *  "signed in" and not recent (`lib/providers/claude-signin-probe.ts`). A Retry
 *  does the same.
 *
 *  The one write on this path is the reverse: a provider the user has
 *  reconnected themselves is a provider whose rescued legacy key libi has no
 *  business still holding, so seeing it here drops it. Only a row read just now
 *  counts: a Codex row served from codex's last good listing (`stale`) does not.
 *  It never throws and never blocks the answer.
 *
 *  `codex` says when Codex's rows are not a fresh answer — see
 *  `ProviderDetection` in lib/providers/detect.ts.
 *
 *  `testModeCodexFakes`, in test mode with the fakes on only: the names libi's stdio fakes are
 *  attached to Codex under, which a real HTTP entry in Codex's config must not
 *  have (`TEST_MODE_STDIO_FAKE_NAMES` in lib/mcp-config.ts). */
export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const refresh = params.get("refresh") === "1";
  const revalidate = refresh || params.get("revalidate") === "1";
  try {
    const detection = await detectProviders({
      ...(refresh ? { refresh: true } : {}),
      ...(revalidate ? { revalidateClaude: true } : {}),
    });
    clearLegacyKeysForConnected(detection.connected.filter((row) => !row.stale));
    const fakesOn = isTestMode() && testModeFakesEnabled();
    return NextResponse.json(fakesOn ? { ...detection, testModeCodexFakes: [...TEST_MODE_STDIO_FAKE_NAMES] } : detection);
  } catch (err) {
    // Detection is best-effort: an empty list with an error note lets the
    // panel render instead of blanking behind React Query's retry.
    logger.warn({ err, tag: "providers", op: "detect_failed" }, "provider detection failed");
    return NextResponse.json({ connected: [], error: "detection failed" }, { status: 200 });
  }
}
