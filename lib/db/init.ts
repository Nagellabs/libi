import * as fs from "node:fs";
import * as path from "node:path";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { mcpServers, skills as skillsTable } from "@/lib/db/schema/sqlite";
import { BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";
import { BUNDLED_SKILLS } from "@/mcp/skills/registry";
import { getBundledSkillsDir } from "@/lib/libi-home";
import { parseSkillBody } from "@/mcp/skills/frontmatter";

function readBundledSkillTags(name: string): string {
  try {
    const raw = fs.readFileSync(path.join(getBundledSkillsDir(), name, "SKILL.md"), "utf-8");
    const { frontmatter } = parseSkillBody(raw);
    return JSON.stringify(frontmatter.tags ?? []);
  } catch {
    return "[]";
  }
}

/**
 * Post-migration initialization: seeds bundled MCP rows (including the
 * special `libi` core entry). Called from createClient() after migrations
 * succeed — runs on every fresh DB and after a hard reset.
 */
export function seedDatabase(db: BetterSQLite3Database<Record<string, unknown>>): void {
  for (const def of BUNDLED_MCP_SERVERS) {
    // Brand-new rows start "pending"; the DependencyManager re-derives the
    // real status at runtime. No def needs configuration — libi holds no
    // provider key — so "needs_config" is never seeded.
    const initialInstallStatus = "pending";

    db.insert(mcpServers)
      .values({
        id: def.id,
        name: def.name,
        description: def.description,
        npmUrl: def.npmUrl,
        type: def.type,
        command: def.command,
        args: JSON.stringify(def.args),
        url: null,
        headers: null,
        bundled: true,
        // Core entries are never gated — force requireApproval=false.
        requireApproval: def.core ? false : def.requireApproval,
        installStatus: initialInstallStatus,
      })
      .onConflictDoUpdate({
        target: mcpServers.id,
        set: {
          name: def.name,
          description: def.description,
          npmUrl: def.npmUrl,
          type: def.type,
          command: def.command,
          args: JSON.stringify(def.args),
          url: null,
          headers: null,
          // On conflict we preserve the user's requireApproval choice, their
          // installStatus and their envVars. Core rows always reset.
          ...(def.core ? { requireApproval: false } : {}),
          updatedAt: new Date(),
        },
      })
      .run();
  }

  for (const def of BUNDLED_SKILLS) {
    db.insert(skillsTable)
      .values({
        id: def.id,
        name: def.name,
        description: def.description,
        source: "bundled",
        enabled: true,
        body: null,
        frontmatter: "{}",
        tags: readBundledSkillTags(def.name),
      })
      .onConflictDoUpdate({
        target: skillsTable.id,
        set: {
          name: def.name,
          description: def.description,
          source: "bundled",
          updatedAt: new Date(),
        },
      })
      .run();
  }
}
