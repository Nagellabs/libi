import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { skills as skillsTable } from "@/lib/db/schema";
import { getBundledSkillsDir, getLibiSkillsDir } from "@/lib/libi-home";
import { parseSkillBody } from "./frontmatter";
import { computeSkillDirDigest, getBundledSkillDigests } from "./digest";

/** Base snapshot of the bundled skill at override time. Lives OUTSIDE the
 *  skill folder — readSupportingFiles/writeSkillsToWorkspace walk the skill
 *  dir, and the snapshot must never leak into the agent workspace. */
export function getOverrideBaseDir(name: string): string {
  return path.join(getLibiSkillsDir(), ".bases", name);
}

export type CreateOverrideResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

/**
 * The ONLY way an override (user row shadowing a bundled skill) is created.
 * Used by libi.fork_skill (body = bundled verbatim) and libi.update_skill's
 * bundled-with-no-override branch (body = the agent's edited SKILL.md).
 *
 * Copies the bundled folder to ~/.libi/skills/<name>/, snapshots the bundled
 * folder to .bases/<name>/, stamps forkedFromDigest from the version-keyed
 * digest cache, and inserts the user row. Does NOT sync the workspace —
 * callers do.
 */
export async function createSkillOverride(
  name: string,
  opts: { body?: string } = {},
): Promise<CreateOverrideResult> {
  const db = getDb();

  const bundledRow = db
    .select()
    .from(skillsTable)
    .where(and(eq(skillsTable.name, name), eq(skillsTable.source, "bundled")))
    .get();
  if (!bundledRow) return { ok: false, error: `No bundled skill named "${name}"` };

  const alreadyForked = db
    .select()
    .from(skillsTable)
    .where(and(eq(skillsTable.name, name), eq(skillsTable.source, "user")))
    .get();
  if (alreadyForked) {
    return { ok: false, error: `"${name}" is already forked into a user skill` };
  }

  const bundledDir = path.join(getBundledSkillsDir(), name);
  if (!fs.existsSync(path.join(bundledDir, "SKILL.md"))) {
    return { ok: false, error: `Bundled skill files for "${name}" not found on disk` };
  }

  const body = opts.body ?? fs.readFileSync(path.join(bundledDir, "SKILL.md"), "utf-8");
  let parsed;
  try {
    parsed = parseSkillBody(body);
  } catch (e) {
    return { ok: false, error: `SKILL.md is invalid: ${(e as Error).message}` };
  }
  if (parsed.frontmatter.name !== name) {
    return {
      ok: false,
      error: `Frontmatter name "${parsed.frontmatter.name}" does not match "${name}"`,
    };
  }

  // User copy: bundled folder, then the (possibly edited) SKILL.md on top.
  const userDir = path.join(getLibiSkillsDir(), name);
  fs.mkdirSync(path.dirname(userDir), { recursive: true });
  fs.cpSync(bundledDir, userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, "SKILL.md"), body);

  // Base snapshot: the bundled folder exactly as it was at override time.
  const baseDir = getOverrideBaseDir(name);
  fs.rmSync(baseDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(baseDir), { recursive: true });
  fs.cpSync(bundledDir, baseDir, { recursive: true });

  const digest =
    getBundledSkillDigests()[name] ?? computeSkillDirDigest(bundledDir);

  const id = randomUUID();
  db.insert(skillsTable)
    .values({
      id,
      name,
      description: parsed.frontmatter.description,
      source: "user",
      enabled: true,
      body,
      frontmatter: JSON.stringify(parsed.frontmatter),
      tags: JSON.stringify(parsed.frontmatter.tags ?? []),
      forkedFromDigest: digest,
    })
    .run();

  return { ok: true, id };
}
