import { syncSkillsToWorkspace } from "@/mcp/skills/sync-workspace";
import { getSessionManager } from "@/lib/sessions/session-manager";
import { serverLogger as logger } from "@/lib/logger";

/**
 * Single entry point for "I just changed a skill row — make agents see it":
 *   1. Re-write `.claude/skills`, `.agents/skills` from current DB.
 *   2. Schedule a reload of every active ACP session so it re-reads the workspace.
 *
 * Mirrors the pattern used by `libi.restart_mcp_server` (whole-session reload).
 * Errors are logged but never thrown — caller's mutation must still succeed
 * even if reload scheduling fails.
 */
export async function syncAndReloadSkills(opts?: { reason?: string }): Promise<void> {
  try {
    await syncSkillsToWorkspace();
  } catch (err) {
    logger.error({ err, tag: "skill-override", op: "sync_failed" }, "skills.sync_failed");
  }
  try {
    const mgr = getSessionManager();
    const ids = mgr.getActiveSessionIds();
    for (const id of ids) {
      mgr.scheduleSessionReload(id);
    }
    mgr.invalidateStandbySession();
    logger.info(
      { tag: "skill-override", op: "reload_scheduled", count: ids.length, reason: opts?.reason },
      "skills.reload_scheduled",
    );
  } catch (err) {
    logger.warn({ err, tag: "skill-override", op: "reload_failed" }, "skills.reload_failed");
  }
}
