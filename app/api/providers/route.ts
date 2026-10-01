import { NextResponse } from "next/server";
import { __clearProviderMemo, detectProviders, type ProviderDetection } from "@/lib/providers/detect";
import { getSessionManager } from "@/lib/sessions/session-manager";
import { crossSiteSubresourceRefusal } from "@/lib/security/request-guard";
import { clearLegacyKeysForConnected } from "@/lib/providers/legacy";
import { serverLogger as logger } from "@/lib/logger";
import { isTestMode } from "@/lib/test-mode";
import { TEST_MODE_STDIO_FAKE_NAMES, testModeFakesEnabled } from "@/lib/mcp-config";

export const dynamic = "force-dynamic";

/**
 * A Codex row whose launcher was installed after the running Codex process started (`launcherAfterStart`): an IDLE
 * process is restarted to pick it up (`SessionManager.restartIdleAgentForLauncher`, only when the new process would
 * find that launcher), and while that is under way the row no longer says to restart libi. Once the new process is
 * up, detection's memo is dropped so the next poll reads the row against the process as it now is. A process a chat
 * is using is kept, and so is the hint.
 *
 * Never for a cross-site subresource request (`crossSiteSubresourceRefusal`): this GET answers any page's poll, but
 * skips the restart when the browser marks the request cross-site or same-site (it reads Sec-Fetch-Site). That is
 * not "only the studio's own pages": a header-less local client (curl, an MCP child) has no Sec-Fetch-Site at all
 * and restarts a process just like the studio's own pages do — only a cross-site/same-site browser fetch is turned
 * away. Such a request still gets the answer, hint included.
 */
async function withIdleCodexRestarted(request: Request, detection: ProviderDetection): Promise<ProviderDetection> {
  const flagged = detection.connected.filter((row) => row.agent === "codex" && row.launcherAfterStart);
  if (flagged.length === 0) return detection;
  if (crossSiteSubresourceRefusal(request) !== null) return detection;
  const launchers = [...new Set(flagged.map((row) => row.launcher).filter((name): name is string => typeof name === "string"))];
  let answer: Awaited<ReturnType<ReturnType<typeof getSessionManager>["restartIdleAgentForLauncher"]>>;
  try {
    answer = await getSessionManager().restartIdleAgentForLauncher("codex", launchers);
  } catch (err) {
    logger.warn({ err, tag: "providers", op: "launcher_restart_error" }, "could not ask for the idle Codex restart");
    return detection;
  }
  if (!("restarting" in answer)) return detection;
  void answer.restarting.then(() => __clearProviderMemo());
  return {
    ...detection,
    connected: detection.connected.map((row) => {
      if (row.agent !== "codex" || !row.launcherAfterStart) return row;
      const rest = { ...row };
      delete rest.launcherAfterStart;
      delete rest.launcher;
      return rest;
    }),
  };
}

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
    const detection = await withIdleCodexRestarted(
      request,
      await detectProviders({
        ...(refresh ? { refresh: true } : {}),
        ...(revalidate ? { revalidateClaude: true } : {}),
      }),
    );
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
