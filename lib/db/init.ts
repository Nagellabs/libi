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
    // For brand-new rows, choose an initial installStatus that reflects
    // whether configuration is required. The DependencyManager re-derives
    // status at runtime, but seeding "needs_config" up front lets the UI
    // show the correct Configure-button styling immediately.
    const needsConfigOnInsert =
      !def.core &&
      Array.isArray(def.requiredEnvVars) &&
      def.requiredEnvVars.length > 0;
    const initialInstallStatus = needsConfigOnInsert ? "needs_config" : "pending";

    db.insert(mcpServers)
      .values({
        id: def.id,
        name: def.name,
        description: def.description,
        npmUrl: def.npmUrl,
        type: def.type,
        command: def.command,
        args: JSON.stringify(def.args),
        url: def.url ?? null,
        headers: def.headers ? JSON.stringify(def.headers) : null,
        bundled: true,
        // Core entries cannot be disabled — force enabled=true, requireApproval=false.
        enabled: true,
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
          url: def.url ?? null,
          headers: def.headers ? JSON.stringify(def.headers) : null,
          // On conflict we preserve the user's enabled/requireApproval choices,
          // their installStatus (could be "installed" if they configured the
          // row, or "needs_config" if not), and their envVars. Core rows always reset.
          ...(def.core
            ? { enabled: true, requireApproval: false }
            : {}),
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
