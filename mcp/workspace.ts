import fs from "fs";
import path from "path";
import { serverLogger as logger } from "@/lib/logger";
import { LIBI_SKILL_VERSION } from "@/mcp/version";
import { getInstructions } from "@/mcp/instructions";
import { getDb } from "@/lib/db/client";
import { mcpServers } from "@/lib/db/schema/sqlite";
import { buildExternalToolsSection } from "@/mcp/registry/instruction-builder";
import { writeAllAgentConfigs } from "@/mcp/settings";
import { loadEnabledSkills } from "@/mcp/skills/loader";
import { writeSkillsToWorkspace } from "@/mcp/skills/writer";
import { getLibiAgentDir, getAgentDirWriteTargets } from "@/lib/libi-home";
import { mergeMarkerSection } from "@/lib/instructions/marker-merge";

/**
 * Prepares an agent directory with agent instructions and MCP config.
 *
 * Two modes depending on whether the target is libi-owned or user-owned:
 *
 * - **Owned mode** (`dir === getLibiAgentDir()`): plain overwrite of
 *   CLAUDE.md / AGENTS.md (today's behaviour). Manual edits there are
 *   intentionally clobbered; the supported customization path is the
 *   Instructions override feature.
 *
 * - **Merge mode** (any other dir, e.g. a connected external project): libi
 *   writes its instructions into a marker-bracketed section so user content
 *   outside the markers survives every regeneration.
 *
 * In both modes the rest of the files (.version, agent configs, skills) are
 * always written the same way.
 *
 * @param workspaceDir - Directory to write files to
 */
export async function prepareAgentDir(workspaceDir: string): Promise<void> {
  fs.mkdirSync(workspaceDir, { recursive: true });

  // Build the external-tools section once — it's dialect-neutral and appended
  // to whichever dialect-rendered instructions each file gets below.
  let externalSection: string | null = null;
  try {
    const db = getDb();
    const rows = db.select().from(mcpServers).all();
    externalSection = buildExternalToolsSection(rows) || null;
  } catch (err) {
    logger.warn({ err }, "Failed to build external tools section");
  }

  // Render per-file dialect: CLAUDE.md ← claude wording, AGENTS.md ← codex
  // wording. This ends the byte-identical invariant deliberately — the only
  // divergence is the dialect-conditional blocks in the template (e.g. how a
  // skill is invoked). Memories + TEST MODE banner remain dialect-neutral.
  const withExternal = (instructions: string): string => {
    if (!externalSection) return instructions;
    const endMarker = "<!-- libi-instructions-end -->";
    const endIdx = instructions.indexOf(endMarker);
    if (endIdx !== -1) {
      return instructions.slice(0, endIdx) + externalSection + "\n" + instructions.slice(endIdx);
    }
    return instructions + "\n" + externalSection;
  };

  // Write instruction files. The default agent dir is fully libi-owned →
  // plain overwrite (manual edits there are intentionally clobbered; the
  // supported customization path is the Instructions override feature).
  // A connected (external) dir is user-owned → merge into a marker section.
  const owned = path.resolve(workspaceDir) === path.resolve(getLibiAgentDir());
  const dialectByFile = { "CLAUDE.md": "claude", "AGENTS.md": "codex" } as const;
  for (const file of ["CLAUDE.md", "AGENTS.md"] as const) {
    const filePath = path.join(workspaceDir, file);
    const instructions = withExternal(getInstructions(dialectByFile[file]));
    if (owned) {
      fs.writeFileSync(filePath, instructions);
    } else {
      const existing = fs.existsSync(filePath)
        ? fs.readFileSync(filePath, "utf-8")
        : null;
      fs.writeFileSync(filePath, mergeMarkerSection(existing, instructions));
    }
  }

  // Write version marker
  fs.writeFileSync(path.join(workspaceDir, ".version"), LIBI_SKILL_VERSION);

  // Write agent config files (MCP server settings + future codex configs)
  writeAllAgentConfigs(workspaceDir);

  // Write skills (SKILL.md per dialect). Failure to write skills must not
  // prevent the rest of workspace prep from succeeding.
  try {
    const skills = await loadEnabledSkills();
    await writeSkillsToWorkspace(workspaceDir, skills);
  } catch (err) {
    logger.error({ err }, "skills.write_failed_during_workspace_prep");
  }
}

/**
 * Regenerate the agent workspace files (CLAUDE.md / AGENTS.md / agent configs)
 * after a settings change, then terminate every running agent session so they
 * pick up the new instructions on next activation.
 *
 * Returns the number of sessions that were running before reset.
 */
export async function regenerateAndRestart(): Promise<{ sessionsTerminated: number }> {
  // Lazy-import to avoid pulling agent-process modules into MCP/CLI bundles.
  const { getProcessManager } = await import("@/lib/agents/process-manager");
  const { getSessionManager } = await import("@/lib/sessions/session-manager");

  // 1. Re-emit agent-dir files (template + memories are read fresh on every
  //    call) — both the default dir and, in connect-agent mode, the
  //    connected external dir.
  const sm = getSessionManager();
  for (const dir of getAgentDirWriteTargets()) {
    await prepareAgentDir(dir);
  }

  // 2. Terminate processes and reset session state.
  const pm = getProcessManager();
  const sessionsTerminated = await pm.terminateAll();
  sm.resetAll(sessionsTerminated);

  logger.info({ sessionsTerminated }, "workspace.regenerate");
  return { sessionsTerminated };
}
