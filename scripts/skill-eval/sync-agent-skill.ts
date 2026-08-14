import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Mirror the canonical orchestration skill to both coding-agent skill dirs so
 * the harness is discoverable whether the developer drives Claude Code or Codex.
 * Idempotent (plain copy). Returns the destination paths written.
 */
export function syncAgentSkill(repoRoot = process.cwd()): string[] {
  const src = resolve(repoRoot, "skill-eval", "agent-skill", "SKILL.md");
  if (!existsSync(src)) throw new Error(`canonical agent skill not found: ${src}`);
  const dests = [
    resolve(repoRoot, ".claude", "skills", "skill-eval", "SKILL.md"),
    resolve(repoRoot, ".agents", "skills", "skill-eval", "SKILL.md"),
  ];
  for (const dest of dests) {
    mkdirSync(resolve(dest, ".."), { recursive: true });
    copyFileSync(src, dest);
  }
  return dests;
}
