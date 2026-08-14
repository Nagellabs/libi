import * as fs from "node:fs";
import * as path from "node:path";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { skills as skillsTable } from "@/lib/db/schema";
import { getBundledSkillsDir, getLibiSkillsDir } from "@/lib/libi-home";
import { serverLogger as logger } from "@/lib/logger";
import { parseSkillBody } from "./frontmatter";
import type { Skill, SkillSupportFile } from "./types";

const TEXT_EXTENSIONS = /\.(md|txt|json|ya?ml|toml|csv|tsv|html?|xml|js|ts|tsx|jsx|css|sh|py|rb|go|rs)$/i;

function readSupportingFiles(skillDir: string): SkillSupportFile[] {
  const out: SkillSupportFile[] = [];
  if (!fs.existsSync(skillDir)) return out;
  const walk = (rel: string): void => {
    const abs = path.join(skillDir, rel);
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const childRel = path.join(rel, entry.name);
      if (entry.isDirectory()) {
        walk(childRel);
      } else if (entry.isFile() && childRel !== "SKILL.md") {
        const isText = TEXT_EXTENSIONS.test(entry.name);
        out.push({
          relPath: childRel,
          contents: isText
            ? fs.readFileSync(path.join(skillDir, childRel), "utf-8")
            : fs.readFileSync(path.join(skillDir, childRel)),
        });
      }
    }
  };
  walk(".");
  return out;
}

function loadFromDisk(
  rootDir: string,
  name: string,
): { body: string; supportingFiles: SkillSupportFile[] } | null {
  const dir = path.join(rootDir, name);
  const skillFile = path.join(dir, "SKILL.md");
  if (!fs.existsSync(skillFile)) return null;
  return {
    body: fs.readFileSync(skillFile, "utf-8"),
    supportingFiles: readSupportingFiles(dir),
  };
}

export async function loadEnabledSkills(): Promise<Skill[]> {
  const db = getDb();
  const rows = db
    .select()
    .from(skillsTable)
    .where(eq(skillsTable.enabled, true))
    .orderBy(skillsTable.source)
    .all();

  const byName = new Map<string, Skill>();

  for (const row of rows) {
    let body: string;
    let supportingFiles: SkillSupportFile[] = [];
    if (row.source === "bundled") {
      const disk = loadFromDisk(getBundledSkillsDir(), row.name);
      if (!disk) {
        logger.warn({ name: row.name }, "skills.bundled_missing_on_disk");
        continue;
      }
      body = disk.body;
      supportingFiles = disk.supportingFiles;
    } else {
      if (!row.body) {
        logger.warn({ name: row.name }, "skills.user_missing_body");
        continue;
      }
      body = row.body;
      const disk = loadFromDisk(getLibiSkillsDir(), row.name);
      supportingFiles = disk?.supportingFiles ?? [];
    }
    let frontmatter;
    try {
      ({ frontmatter } = parseSkillBody(body));
    } catch (err) {
      logger.error({ err, name: row.name }, "skills.parse_failed");
      continue;
    }
    const existing = byName.get(row.name);
    if (existing) {
      // user always wins regardless of arrival order
      if (existing.source === "user" && row.source === "bundled") continue;
      if (existing.source === "bundled" && row.source === "user") {
        // fall through to overwrite below
      } else {
        // same source — keep first (deterministic)
        continue;
      }
    }
    byName.set(row.name, {
      id: row.id,
      name: row.name,
      description: row.description,
      source: row.source,
      enabled: row.enabled,
      body,
      frontmatter,
      supportingFiles,
      tags: Array.isArray(frontmatter.tags) ? frontmatter.tags : [],
    });
  }

  return Array.from(byName.values());
}
