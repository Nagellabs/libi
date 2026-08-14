/**
 * Single-skill installer for the install-from-URL pipeline.
 *
 * Mirrors `mcp/tools/skill-tools.ts#addSkill` but takes the skill body
 * (and optional supporting files) from an extracted-tarball directory
 * instead of an inline string.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { skills as skillsTable } from "@/lib/db/schema";
import { getLibiSkillsDir } from "@/lib/libi-home";
import { serverLogger as logger } from "@/lib/logger";
import { parseSkillBody } from "@/mcp/skills/frontmatter";
import { syncSkillsToWorkspace } from "@/mcp/skills/sync-workspace";
import { SkillCollisionError } from "./types";

/**
 * Walk a directory tree and throw if any entry is a symlink.
 *
 * A hostile repo can ship `my-skill/prompts/leak.md` as a symlink to
 * `~/.ssh/id_rsa` (or anywhere else readable by this process). Dereferencing
 * it on copy would materialize the real secret bytes into
 * `~/.libi/skills/...`, where `GET /api/settings/skills` returns them
 * verbatim and, once the skill is enabled, they get injected into agent
 * instructions. Refuse the whole install instead.
 */
async function assertNoSymlinks(dir: string): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`refusing to install skill: symlink found at ${entryPath}`);
    }
    if (entry.isDirectory()) {
      await assertNoSymlinks(entryPath);
    }
  }
}

/**
 * Recursively copy a directory tree. Uses `fs.cp` with `recursive:true`,
 * available on Node 16.7+. Refuses (rather than dereferences) any symlink
 * found anywhere in `src` — see `assertNoSymlinks`.
 */
async function copyDirRecursive(src: string, dst: string): Promise<void> {
  await assertNoSymlinks(src);
  await fs.cp(src, dst, { recursive: true, force: true });
}

export type InstallSingleSkillParams = {
  /** The extracted-tarball root that `detectCandidate` returned. */
  basePath: string;
  /**
   * Relative path inside `basePath` where the skill folder lives. `"."`
   * for a root-level SKILL.md; `"skills/foo"` for a multi-skill repo.
   */
  skillRelPath: string;
  /**
   * The expected name. We validate that the SKILL.md's frontmatter
   * matches and (when wrapped by the plugin installer) raises on drift.
   */
  name: string;
};

/**
 * Install a single skill from an extracted-tarball directory. Throws
 * `SkillCollisionError` on user-skill name collision. Other errors
 * (bad frontmatter, missing file) surface as plain `Error`.
 */
export async function installSingleSkill(
  params: InstallSingleSkillParams,
): Promise<{ kind: "skill"; name: string }> {
  const { basePath, skillRelPath, name } = params;
  logger.info(
    { tag: "install-from-url", op: "install_skill_start", name, skillRelPath },
    "Installing skill from URL",
  );

  // Defeat traversal — skillRelPath must resolve inside basePath.
  const skillDir = path.resolve(basePath, skillRelPath);
  if (
    !skillDir.startsWith(basePath + path.sep) &&
    skillDir !== basePath
  ) {
    throw new Error(`skillRelPath escapes basePath: ${skillRelPath}`);
  }
  // Refuse the whole tree up front — before SKILL.md is even read — so a
  // symlinked SKILL.md or supporting file never gets this far, and a
  // rejected install never leaves an orphaned DB row behind it.
  await assertNoSymlinks(skillDir);
  const skillMdPath = path.join(skillDir, "SKILL.md");
  let body: string;
  try {
    body = await fs.readFile(skillMdPath, "utf-8");
  } catch (err) {
    logger.error(
      { tag: "install-from-url", op: "install_skill_error", name, err },
      "Failed to read SKILL.md",
    );
    throw new Error(`SKILL.md not found at ${skillMdPath}: ${(err as Error).message}`);
  }

  let parsed;
  try {
    parsed = parseSkillBody(body);
  } catch (err) {
    throw new Error(`SKILL.md is invalid: ${(err as Error).message}`);
  }
  if (parsed.frontmatter.name !== name) {
    throw new Error(
      `Frontmatter name "${parsed.frontmatter.name}" does not match expected "${name}"`,
    );
  }

  // Collision check on user skills.
  const db = getDb();
  const existing = db
    .select()
    .from(skillsTable)
    .where(and(eq(skillsTable.name, name), eq(skillsTable.source, "user")))
    .all();
  if (existing.length > 0) {
    logger.warn(
      { tag: "install-from-url", op: "install_skill_collision", name },
      "User skill already exists",
    );
    throw new SkillCollisionError(name);
  }

  // Insert DB row.
  const id = randomUUID();
  db.insert(skillsTable)
    .values({
      id,
      name,
      description: parsed.frontmatter.description,
      source: "user",
      // Install disabled (RC-A defense-in-depth): a skill installed from a URL
      // must never auto-activate. The user enables it explicitly from the UI.
      enabled: false,
      body,
      frontmatter: JSON.stringify(parsed.frontmatter),
    })
    .run();

  // Copy the skill folder (including supporting files) to ~/.libi/skills/<name>/
  const dst = path.join(getLibiSkillsDir(), name);
  await fs.mkdir(getLibiSkillsDir(), { recursive: true });
  // If a stale dir exists (e.g. a leftover from a previous failed install),
  // wipe it first — the DB row was the source of truth for collision detection.
  await fs.rm(dst, { recursive: true, force: true }).catch(() => {});
  await copyDirRecursive(skillDir, dst);

  await syncSkillsToWorkspace();

  logger.info(
    { tag: "install-from-url", op: "install_skill_done", name, id },
    "Skill installed",
  );
  return { kind: "skill", name };
}
