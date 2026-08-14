import { getLibiAgentDir } from "@/lib/libi-home";
import { serverLogger as logger } from "@/lib/logger";
import { loadEnabledSkills } from "./loader";
import { writeSkillsToWorkspace } from "./writer";

/**
 * Re-write the agent workspace's skill files (`.claude/skills/`, `.agents/skills/`)
 * from the current DB state. Call this after install / toggle /
 * delete so the workspace stays in sync without requiring a server restart.
 *
 * Errors are logged and swallowed — caller mutations should still succeed even
 * if the workspace write fails (e.g. disk full, permission issues).
 *
 * Note: an already-running agent session may have loaded the skill set at
 * session start. Newly added skills are visible to NEW sessions started after
 * this call returns; existing sessions may need to be reopened.
 */
export async function syncSkillsToWorkspace(): Promise<void> {
  try {
    const skills = await loadEnabledSkills();
    await writeSkillsToWorkspace(getLibiAgentDir(), skills);
  } catch (err) {
    logger.error({ err }, "skills.sync_workspace_failed");
  }
}
