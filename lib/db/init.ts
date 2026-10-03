import * as fs from "node:fs";
import * as path from "node:path";
import { and, eq, notInArray } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { mcpServers, skills as skillsTable } from "@/lib/db/schema/sqlite";
import { BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";
import { BUNDLED_SKILLS } from "@/mcp/skills/registry";
import { getBundledSkillsDir } from "@/lib/libi-home";
import { parseSkillBody } from "@/mcp/skills/frontmatter";

/**
 * A bundled skill's description and tags, read from its SKILL.md frontmatter — the single source for both
 * (the registry lists folders only). A folder whose SKILL.md cannot be read yields a null description: it is
 * seeded under its id and never overwrites a description already stored.
 */
export function readBundledSkillMeta(name: string): { description: string | null; tags: string } {
  try {
    const raw = fs.readFileSync(path.join(getBundledSkillsDir(), name, "SKILL.md"), "utf-8");
    const { frontmatter } = parseSkillBody(raw);
    return { description: frontmatter.description, tags: JSON.stringify(frontmatter.tags ?? []) };
  } catch {
    return { description: null, tags: "[]" };
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

  // A bundled skill that left the registry (merged into another, or folded into the manual) must leave the DB
  // too: its folder is gone from the bundle, so a surviving row would still be listed by `libi.skill({ action: "list" })` and the
  // Skills page, and `loadEnabledSkills` would warn about it on every sync. Only `source = "bundled"` rows go; a
  // user's own skill, or a fork of the removed one, is theirs and stays. The agent roots lose the folder through the
  // normal sync: the loader no longer returns the skill, so the writer treats its manifest-listed dir as an orphan.
  db.delete(skillsTable)
    .where(and(eq(skillsTable.source, "bundled"), notInArray(skillsTable.id, BUNDLED_SKILLS.map((d) => d.id))))
    .run();

  for (const def of BUNDLED_SKILLS) {
    const meta = readBundledSkillMeta(def.name);
    db.insert(skillsTable)
      .values({
        id: def.id,
        name: def.name,
        description: meta.description ?? def.name,
        source: "bundled",
        enabled: true,
        body: null,
        frontmatter: "{}",
        tags: meta.tags,
      })
      .onConflictDoUpdate({
        target: skillsTable.id,
        set: {
          name: def.name,
          ...(meta.description === null ? {} : { description: meta.description }),
          source: "bundled",
          updatedAt: new Date(),
        },
      })
      .run();
  }
}
