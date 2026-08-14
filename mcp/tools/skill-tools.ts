/** Skill management + MCP discovery tools.
 *
 * Unlike the older composition tools (which return `{ success, data, error }`
 * and are wrapped by `makeContent` in `mcp/server.ts`), these tools return
 * the MCP wire-format directly: `{ content: [{ type: "text", text: <json> }],
 * error?: string }`. The `mcp/server.ts` registrations forward the result
 * verbatim — no `makeContent` wrapping.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { skills as skillsTable, mcpServers } from "@/lib/db/schema";
import { getLibiSkillsDir, getBundledSkillsDir } from "@/lib/libi-home";
import { mcpLogger as logger } from "@/lib/logger";
import { parseSkillBody } from "@/mcp/skills/frontmatter";
import { readPromptFiles, writePromptFile, promptFileExists, removePromptFile } from "@/mcp/skills/prompt-files";
import { syncSkillsToWorkspace } from "@/mcp/skills/sync-workspace";
import { createSkillOverride, getOverrideBaseDir } from "@/mcp/skills/create-override";
import { computeOverrideStatus } from "@/mcp/skills/override-status";
import { getBundledSkillDigests, listChangedFiles } from "@/mcp/skills/digest";
import type { ToolContext } from "./types";
import type {
  ListSkillsParams,
  AddSkillParams,
  UpdateSkillParams,
  RemoveSkillParams,
  SetSkillEnabledParams,
  ListMcpServersParams,
  ListSkillPromptsParams,
  AddSkillPromptParams,
  UpdateSkillPromptParams,
  RemoveSkillPromptParams,
  SetSkillsEnabledByTagParams,
  ForkSkillParams,
  DiffSkillOverrideParams,
} from "./schemas";

export type SkillToolResult = {
  content: { type: "text"; text: string }[];
  error?: string;
};

function ok(payload: unknown): SkillToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function err(message: string): SkillToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }) }],
    error: message,
  };
}

export async function listSkills(
  _ctx: ToolContext,
  _params: ListSkillsParams,
): Promise<SkillToolResult> {
  const rows = getDb().select().from(skillsTable).all();
  const overrideStatus = computeOverrideStatus(rows);
  return ok({
    skills: rows.map((r) => {
      const status = r.source === "user" ? overrideStatus.get(r.name) : undefined;
      return {
        id: r.id,
        name: r.name,
        description: r.description,
        source: r.source,
        enabled: r.enabled,
        ...(status
          ? {
              overridesBundled: true,
              bundledUpdatedSinceFork: status.bundledUpdatedSinceFork,
            }
          : {}),
      };
    }),
  });
}

export async function addSkill(
  _ctx: ToolContext,
  params: AddSkillParams,
): Promise<SkillToolResult> {
  let parsed;
  try {
    parsed = parseSkillBody(params.body);
  } catch (e) {
    return err(`SKILL.md is invalid: ${(e as Error).message}`);
  }
  if (parsed.frontmatter.name !== params.name) {
    return err(
      `Frontmatter name "${parsed.frontmatter.name}" does not match params.name "${params.name}". They must match.`,
    );
  }

  const existing = getDb()
    .select()
    .from(skillsTable)
    .where(eq(skillsTable.name, params.name))
    .all();
  if (existing.some((r) => r.source === "user")) {
    return err(
      `A user skill named "${params.name}" already exists. Remove it first.`,
    );
  }

  const id = randomUUID();
  getDb()
    .insert(skillsTable)
    .values({
      id,
      name: params.name,
      description: params.description,
      source: "user",
      enabled: true,
      body: params.body,
      frontmatter: JSON.stringify(parsed.frontmatter),
      tags: JSON.stringify(parsed.frontmatter.tags ?? []),
    })
    .run();

  const dir = path.join(getLibiSkillsDir(), params.name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), params.body);

  await syncSkillsToWorkspace();
  return ok({ id, name: params.name });
}

export async function updateSkill(
  _ctx: ToolContext,
  params: UpdateSkillParams,
): Promise<SkillToolResult> {
  logger.info(
    { tag: "skill-tools", op: "update", name: params.name, bodyLength: params.body.length },
    "update_skill",
  );

  let parsed;
  try {
    parsed = parseSkillBody(params.body);
  } catch (e) {
    return err(`SKILL.md is invalid: ${(e as Error).message}`);
  }
  if (parsed.frontmatter.name !== params.name) {
    return err(
      `Frontmatter name "${parsed.frontmatter.name}" does not match params.name "${params.name}". They must match.`,
    );
  }

  const row = getDb()
    .select()
    .from(skillsTable)
    .where(and(eq(skillsTable.name, params.name), eq(skillsTable.source, "user")))
    .get();
  if (!row) {
    // Tool contract: a bundled skill with no override gets a new override row
    // that shadows the bundled body. createSkillOverride stamps the bundled
    // digest + base snapshot so fork-staleness is tracked for this path too.
    const res = await createSkillOverride(params.name, { body: params.body });
    if (!res.ok) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              error: res.error,
              data: { name: params.name },
            }),
          },
        ],
        error: res.error,
      };
    }
    await syncSkillsToWorkspace();
    logger.info(
      { tag: "skill-tools", op: "update_create_override", name: params.name, id: res.id },
      "update_skill",
    );
    return ok({
      success: true,
      data: {
        name: params.name,
        source: "user",
        overrodeBundled: true,
        message:
          "Bundled skill overridden — a user copy now shadows it. New sessions will see the change.",
      },
    });
  }
  getDb()
    .update(skillsTable)
    .set({
      body: params.body,
      description: parsed.frontmatter.description,
      frontmatter: JSON.stringify(parsed.frontmatter),
      tags: JSON.stringify(parsed.frontmatter.tags ?? []),
      updatedAt: new Date(),
    })
    .where(eq(skillsTable.id, row.id))
    .run();

  const dir = path.join(getLibiSkillsDir(), params.name);
  fs.mkdirSync(dir, { recursive: true });
  const finalPath = path.join(dir, "SKILL.md");
  const tmpPath = `${finalPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, params.body);
  fs.renameSync(tmpPath, finalPath);

  await syncSkillsToWorkspace();

  return ok({
    success: true,
    data: {
      name: params.name,
      source: "user",
      message: "Skill updated. New sessions will see the change.",
    },
  });
}

export async function removeSkill(
  _ctx: ToolContext,
  params: RemoveSkillParams,
): Promise<SkillToolResult> {
  const row = getDb()
    .select()
    .from(skillsTable)
    .where(eq(skillsTable.id, params.id))
    .get();
  if (!row) return err("Skill not found");
  if (row.source === "bundled") {
    return err("Cannot remove a bundled skill — disable it instead");
  }
  getDb().delete(skillsTable).where(eq(skillsTable.id, params.id)).run();
  fs.rmSync(path.join(getLibiSkillsDir(), row.name), {
    recursive: true,
    force: true,
  });
  fs.rmSync(getOverrideBaseDir(row.name), { recursive: true, force: true });
  await syncSkillsToWorkspace();
  return ok({ removed: row.name });
}

export async function setSkillEnabled(
  _ctx: ToolContext,
  params: SetSkillEnabledParams,
): Promise<SkillToolResult> {
  const row = getDb()
    .select()
    .from(skillsTable)
    .where(eq(skillsTable.id, params.id))
    .get();
  if (!row) return err("Skill not found");
  getDb()
    .update(skillsTable)
    .set({ enabled: params.enabled, updatedAt: new Date() })
    .where(eq(skillsTable.id, params.id))
    .run();
  await syncSkillsToWorkspace();
  return ok({ id: row.id, enabled: params.enabled });
}

export async function listMcpServersTool(
  _ctx: ToolContext,
  _params: ListMcpServersParams,
): Promise<SkillToolResult> {
  const rows = getDb().select().from(mcpServers).all();
  return ok({
    servers: rows
      .filter((r) => r.enabled)
      .map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        type: r.type,
        installStatus: r.installStatus,
        bundled: r.bundled,
      })),
  });
}

// ---------------------------------------------------------------------------
// Skill prompt-file tools
// ---------------------------------------------------------------------------

/** Resolve a USER skill's on-disk dir, or an error result if missing/bundled.
 *  A forked skill has BOTH a bundled and a user row sharing the name, so we
 *  must look up the user row explicitly (a name-only query could return the
 *  bundled twin and wrongly reject an editable fork). */
function resolveUserSkillDir(skillName: string): { dir: string } | { error: SkillToolResult } {
  const userRow = getDb()
    .select()
    .from(skillsTable)
    .where(and(eq(skillsTable.name, skillName), eq(skillsTable.source, "user")))
    .get();
  if (userRow) return { dir: path.join(getLibiSkillsDir(), skillName) };
  const bundledRow = getDb()
    .select()
    .from(skillsTable)
    .where(and(eq(skillsTable.name, skillName), eq(skillsTable.source, "bundled")))
    .get();
  if (bundledRow) {
    return { error: err(`"${skillName}" is a bundled skill — fork it first with libi.fork_skill before editing its prompts.`) };
  }
  return { error: err(`No skill named "${skillName}". Create it first with libi.add_skill.`) };
}

export async function listSkillPrompts(
  _ctx: ToolContext,
  params: ListSkillPromptsParams,
): Promise<SkillToolResult> {
  // Prefer the user row when a fork shadows a bundled skill of the same name,
  // so the listing reflects the editable (user) copy's prompts.
  const rows = getDb().select().from(skillsTable).where(eq(skillsTable.name, params.skillName)).all();
  if (rows.length === 0) return err(`No skill named "${params.skillName}"`);
  const row = rows.find((r) => r.source === "user") ?? rows[0];
  const baseDir = row.source === "bundled" ? getBundledSkillsDir() : getLibiSkillsDir();
  return ok({ prompts: readPromptFiles(path.join(baseDir, params.skillName)) });
}

export async function addSkillPrompt(
  _ctx: ToolContext,
  params: AddSkillPromptParams,
): Promise<SkillToolResult> {
  const resolved = resolveUserSkillDir(params.skillName);
  if ("error" in resolved) return resolved.error;
  if (promptFileExists(resolved.dir, params.name)) {
    return err(`Prompt "${params.name}" already exists on "${params.skillName}". Use update_skill_prompt.`);
  }
  try {
    writePromptFile(resolved.dir, params.name, params.body);
  } catch (e) {
    return err((e as Error).message);
  }
  await syncSkillsToWorkspace();
  return ok({ skillName: params.skillName, relPath: `prompts/${params.name}.md` });
}

export async function updateSkillPrompt(
  _ctx: ToolContext,
  params: UpdateSkillPromptParams,
): Promise<SkillToolResult> {
  const resolved = resolveUserSkillDir(params.skillName);
  if ("error" in resolved) return resolved.error;
  if (!promptFileExists(resolved.dir, params.name)) {
    return err(`Prompt "${params.name}" does not exist on "${params.skillName}". Use add_skill_prompt.`);
  }
  try {
    writePromptFile(resolved.dir, params.name, params.body);
  } catch (e) {
    return err((e as Error).message);
  }
  await syncSkillsToWorkspace();
  return ok({ skillName: params.skillName, relPath: `prompts/${params.name}.md` });
}

export async function removeSkillPrompt(
  _ctx: ToolContext,
  params: RemoveSkillPromptParams,
): Promise<SkillToolResult> {
  const resolved = resolveUserSkillDir(params.skillName);
  if ("error" in resolved) return resolved.error;
  try {
    removePromptFile(resolved.dir, params.name);
  } catch (e) {
    return err((e as Error).message ?? "Invalid prompt name");
  }
  await syncSkillsToWorkspace();
  return ok({ removed: `prompts/${params.name}.md` });
}

// ---------------------------------------------------------------------------
// Bulk tag tools
// ---------------------------------------------------------------------------

export async function setSkillsEnabledByTag(
  _ctx: ToolContext,
  params: SetSkillsEnabledByTagParams,
): Promise<SkillToolResult> {
  const want = new Set(params.tags);
  const rows = getDb().select().from(skillsTable).all();
  const affected: string[] = [];
  for (const row of rows) {
    let rowTags: string[] = [];
    try {
      rowTags = JSON.parse(row.tags) as string[];
    } catch {
      rowTags = [];
    }
    if (!rowTags.some((t) => want.has(t))) continue;
    affected.push(row.name);
    getDb()
      .update(skillsTable)
      .set({ enabled: params.enabled, updatedAt: new Date() })
      .where(eq(skillsTable.id, row.id))
      .run();
  }
  await syncSkillsToWorkspace();
  return ok({ affected, enabled: params.enabled });
}

// ---------------------------------------------------------------------------
// Fork tool
// ---------------------------------------------------------------------------

export async function forkSkill(
  _ctx: ToolContext,
  params: ForkSkillParams,
): Promise<SkillToolResult> {
  const row = getDb().select().from(skillsTable).where(eq(skillsTable.id, params.id)).get();
  if (!row) return err("Skill not found");
  if (row.source !== "bundled") return err("Only bundled skills can be forked");

  const res = await createSkillOverride(row.name);
  if (!res.ok) return err(res.error);

  await syncSkillsToWorkspace();
  logger.info({ tag: "skill-tools", op: "fork", name: row.name, id: res.id }, "fork_skill");
  return ok({ id: res.id, name: row.name, forkedFrom: "bundled" });
}

export async function diffSkillOverride(
  _ctx: ToolContext,
  params: DiffSkillOverrideParams,
): Promise<SkillToolResult> {
  const rows = getDb()
    .select()
    .from(skillsTable)
    .where(eq(skillsTable.name, params.name))
    .all();
  const userRow = rows.find((r) => r.source === "user");
  const bundledRow = rows.find((r) => r.source === "bundled");
  if (!bundledRow) return err(`No bundled skill named "${params.name}"`);
  if (!userRow) {
    return err(`"${params.name}" has no user override — nothing to diff`);
  }

  const bundledDir = path.join(getBundledSkillsDir(), params.name);
  if (!fs.existsSync(path.join(bundledDir, "SKILL.md"))) {
    return err(`Bundled skill files for "${params.name}" not found on disk`);
  }
  const baseDir = getOverrideBaseDir(params.name);
  const hasBase = fs.existsSync(path.join(baseDir, "SKILL.md"));

  const currentDigest = getBundledSkillDigests()[params.name] ?? null;
  const upstreamChanged: boolean | "unknown" =
    userRow.forkedFromDigest && currentDigest
      ? userRow.forkedFromDigest !== currentDigest
      : "unknown";

  return ok({
    name: params.name,
    upstreamChanged,
    baseDigest: userRow.forkedFromDigest,
    currentBundledDigest: currentDigest,
    changedFiles: hasBase ? listChangedFiles(baseDir, bundledDir) : null,
    skillMd: {
      base: hasBase ? fs.readFileSync(path.join(baseDir, "SKILL.md"), "utf-8") : null,
      currentBundled: fs.readFileSync(path.join(bundledDir, "SKILL.md"), "utf-8"),
      userCopy: userRow.body,
    },
  });
}
