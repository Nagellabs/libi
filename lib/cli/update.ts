import fs from "fs";
import path from "path";
import { LIBI_SKILL_VERSION } from "@/mcp/version";
import {
  upsertInstructions,
  parseInstructionVersion,
} from "@/mcp/instructions";

export async function updateProject() {
  const cwd = process.cwd();
  const claudeMdPath = path.join(cwd, "CLAUDE.md");

  if (!fs.existsSync(claudeMdPath)) {
    console.error("Not a Libi project (no CLAUDE.md found). Run `libi studio --connect-agent` first.");
    process.exit(1);
  }

  // Check current installed version from CLAUDE.md marker
  const currentVersion = readInstalledVersion(cwd);

  if (currentVersion === LIBI_SKILL_VERSION) {
    console.log(`✓ Already up to date (v${LIBI_SKILL_VERSION})`);
    return;
  }

  console.log(
    `Updating: v${currentVersion ?? "unknown"} → v${LIBI_SKILL_VERSION}`
  );

  // Update agent instruction templates using marker-based upsert
  upsertInstructions(path.join(cwd, "CLAUDE.md"));
  console.log("  Updated CLAUDE.md");

  upsertInstructions(path.join(cwd, "AGENTS.md"));
  console.log("  Updated AGENTS.md");

  console.log(`\n✓ Updated to v${LIBI_SKILL_VERSION}`);
}

/**
 * Read the installed instruction version from CLAUDE.md markers.
 * Falls back to null if no CLAUDE.md or no marker found.
 */
function readInstalledVersion(projectDir: string): string | null {
  const claudeMdPath = path.join(projectDir, "CLAUDE.md");
  if (fs.existsSync(claudeMdPath)) {
    const content = fs.readFileSync(claudeMdPath, "utf-8");
    return parseInstructionVersion(content);
  }
  return null;
}
