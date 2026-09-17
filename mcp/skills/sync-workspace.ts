import { getLibiAgentDir } from "@/lib/libi-home";
import { serverLogger as logger } from "@/lib/logger";
import { loadEnabledSkills } from "./loader";
import { ownAgentDirWriteOptions, syncSkillInstalls } from "./installs";
import { sanitizeErrForLog, writeSkillsToWorkspace } from "./writer";

/**
 * Re-write the agent workspace's skill files (`.claude/skills/`, `.agents/skills/`)
 * from the current DB state, then every recorded install for the user's own
 * agents. Call this after install / toggle / delete so every copy stays in
 * sync without a server restart.
 *
 * Errors are logged and swallowed — caller mutations should still succeed even
 * if a write fails (e.g. disk full, permission issues).
 *
 * Note: an already-running agent session may have loaded the skill set at
 * session start. Newly added skills are visible to NEW sessions started after
 * this call returns; existing sessions may need to be reopened.
 */
export async function syncSkillsToWorkspace(): Promise<void> {
  try {
    const skills = await loadEnabledSkills();
    await writeSkillsToWorkspace(getLibiAgentDir(), skills, ownAgentDirWriteOptions());
  } catch (err) {
    logger.error({ err, tag: "skills", op: "sync_workspace_failed" }, "skills.sync_workspace_failed");
  }
  try {
    await syncSkillInstalls("skills-changed");
  } catch (err) {
    logger.error(
      { err: sanitizeErrForLog(err), tag: "skills", op: "installs_sync_after_change_failed" },
      "skills.installs_sync_after_change_failed",
    );
  }
}
