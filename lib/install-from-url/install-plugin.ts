/**
 * Claude-plugin installer.
 *
 * Walks `manifest.skills[]` and `manifest.mcpServers{}`, installing each
 * via the corresponding low-level helper. Collects per-item success/failure
 * into an `InstallResult` — the caller (the API route / UI) decides what to
 * show the user.
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { mcpServers } from "@/lib/db/schema";
import { invalidateMcpConfig } from "@/lib/mcp-config";
import { serverLogger as logger } from "@/lib/logger";
import { parseSkillBody } from "@/mcp/skills/frontmatter";
import { collectMultiSkill } from "./detect";
import { installSingleSkill } from "./install-skill";
import { SkillCollisionError, type ClaudePluginManifest, type InstallResult, type McpServerEntry } from "./types";

export type InstallClaudePluginParams = {
  basePath: string;
  manifest: ClaudePluginManifest;
};

/**
 * Read a SKILL.md inside the plugin's basePath and derive the canonical
 * skill name from its frontmatter. Used so the installer logs the
 * frontmatter-name (not just the relative path) on success/failure.
 */
async function inferSkillName(
  basePath: string,
  skillRelPath: string,
): Promise<string> {
  const skillFile = path.join(basePath, skillRelPath, "SKILL.md");
  const body = await fs.readFile(skillFile, "utf-8");
  const parsed = parseSkillBody(body);
  return parsed.frontmatter.name;
}

/**
 * Resolve a collision-free name for a new MCP server row. If the
 * requested name is already taken, suffix with ` (from <pluginName>)`.
 */
function resolveMcpName(requested: string, pluginName: string): string {
  const db = getDb();
  const exists = db
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.name, requested))
    .all();
  if (exists.length === 0) return requested;
  return `${requested} (from ${pluginName})`;
}

/**
 * Insert one MCP server row from a manifest entry.
 */
function insertMcpRow(name: string, entry: McpServerEntry): void {
  const db = getDb();
  const type: "stdio" | "http" = entry.url ? "http" : "stdio";
  db.insert(mcpServers)
    .values({
      name,
      description: null,
      type,
      command: entry.command ?? null,
      args: entry.args ? JSON.stringify(entry.args) : null,
      url: entry.url ?? null,
      headers: entry.headers ? JSON.stringify(entry.headers) : null,
      envVars: entry.env ? JSON.stringify(entry.env) : null,
      enabled: true,
      requireApproval: true,
      bundled: false,
      installStatus: "not_required",
    })
    .run();
}

export async function installClaudePlugin(
  params: InstallClaudePluginParams,
): Promise<InstallResult> {
  const { basePath, manifest } = params;
  const result: InstallResult = { installed: [], failed: [] };

  // Real-world plugins (e.g. obra/superpowers) omit `manifest.skills`
  // entirely because Claude Code auto-discovers `skills/*/SKILL.md`.
  // Mirror that behavior so libi installs them too.
  let skillRelPaths = manifest.skills ?? [];
  if (skillRelPaths.length === 0) {
    const discovered = await collectMultiSkill(basePath);
    skillRelPaths = discovered.map((d) => d.relPath);
  }

  logger.info(
    {
      tag: "install-from-url",
      op: "install_plugin_start",
      pluginName: manifest.name,
      skills: skillRelPaths.length,
      skillsFromManifest: (manifest.skills ?? []).length,
      mcpServers: Object.keys(manifest.mcpServers ?? {}).length,
    },
    "Installing claude plugin",
  );

  // -- skills --
  for (const skillRelPath of skillRelPaths) {
    let inferredName = skillRelPath;
    try {
      inferredName = await inferSkillName(basePath, skillRelPath);
      await installSingleSkill({
        basePath,
        skillRelPath,
        name: inferredName,
      });
      result.installed.push({ kind: "skill", name: inferredName });
    } catch (err) {
      const isCollision = err instanceof SkillCollisionError;
      result.failed.push({
        kind: "skill",
        name: inferredName,
        error: isCollision
          ? `already installed — remove the existing user skill or rename`
          : (err as Error).message,
      });
      logger.warn(
        {
          tag: "install-from-url",
          op: "install_plugin_skill_failed",
          name: inferredName,
          err,
        },
        "Plugin skill install failed",
      );
    }
  }

  // -- MCP servers --
  const mcpEntries = Object.entries(manifest.mcpServers ?? {});
  let mcpRowsAdded = 0;
  for (const [requestedName, entry] of mcpEntries) {
    try {
      const finalName = resolveMcpName(requestedName, manifest.name);
      insertMcpRow(finalName, entry);
      mcpRowsAdded += 1;
      result.installed.push({
        kind: "mcp",
        name: finalName,
        note:
          finalName === requestedName
            ? undefined
            : `renamed from "${requestedName}" to avoid collision`,
      });
    } catch (err) {
      result.failed.push({
        kind: "mcp",
        name: requestedName,
        error: (err as Error).message,
      });
      logger.warn(
        {
          tag: "install-from-url",
          op: "install_plugin_mcp_failed",
          name: requestedName,
          err,
        },
        "Plugin MCP install failed",
      );
    }
  }

  if (mcpRowsAdded > 0) {
    try {
      invalidateMcpConfig({ reason: "install-from-url" });
    } catch (err) {
      logger.warn(
        { tag: "install-from-url", op: "invalidate_failed", err },
        "Failed to invalidate MCP config after plugin install",
      );
    }
  }

  logger.info(
    {
      tag: "install-from-url",
      op: "install_plugin_done",
      pluginName: manifest.name,
      installed: result.installed.length,
      failed: result.failed.length,
    },
    "Plugin install complete",
  );
  return result;
}
