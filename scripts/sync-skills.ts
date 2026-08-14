#!/usr/bin/env tsx
/**
 * One-shot sync of bundled SKILL.md files into the libi workspace mirrors
 * (`~/.libi/agent/.claude/skills`, `~/.libi/agent/.agents/skills`).
 * Use after editing `mcp/skills/<name>/SKILL.md` when libi is already running.
 *
 * Resolves LIBI_HOME the same way the running server does (env var or
 * `~/.libi` default). For a worktree-scoped run, the wrapper script in
 * `bin/libi.js` exports the worktree's LIBI_HOME — invoke this through
 * `node bin/libi.js exec npx tsx scripts/sync-skills.ts`, OR pass it
 * explicitly: `LIBI_HOME=~/.libi/worktrees/<name> npx tsx scripts/sync-skills.ts`.
 *
 * Next new chat session picks up the updated SKILL.md content automatically.
 * Already-open sessions need to be reopened to see changes.
 */
import { syncSkillsToWorkspace } from "@/mcp/skills/sync-workspace";
import { getLibiAgentDir, getLibiHome } from "@/lib/libi-home";

async function main() {
  console.log(`libi home: ${getLibiHome()}`);
  console.log(`agent workspace: ${getLibiAgentDir()}`);
  console.log("Syncing skill files…");
  await syncSkillsToWorkspace();
  console.log("Done. New sessions will see the updated skills.");
}

main().catch((err) => {
  console.error("Sync failed:", err);
  process.exit(1);
});
