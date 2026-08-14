import { NextResponse } from "next/server";
import * as fs from "node:fs";
import * as path from "node:path";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { skills } from "@/lib/db/schema";
import { getBundledSkillsDir, getLibiSkillsDir } from "@/lib/libi-home";
import { readPromptFiles } from "@/mcp/skills/prompt-files";

interface Params {
  params: Promise<{ name: string }>;
}

/**
 * Full effective-skill detail for the skill detail page. Unlike the lean list
 * endpoint, this returns the SKILL.md body for BUNDLED skills too (read from
 * disk) so the page can display and seed an override draft. When both a bundled
 * and a user row share the name, the user row wins (overriddenFromBundled).
 */
export async function GET(_request: Request, { params }: Params) {
  const { name: raw } = await params;
  const name = decodeURIComponent(raw);

  const rows = getDb().select().from(skills).where(eq(skills.name, name)).all();
  if (rows.length === 0) {
    return NextResponse.json({ error: "Skill not found" }, { status: 404 });
  }

  const userRow = rows.find((r) => r.source === "user");
  const bundledRow = rows.find((r) => r.source === "bundled");
  const row = userRow ?? bundledRow!;
  const overriddenFromBundled = Boolean(userRow && bundledRow);

  const baseDir = row.source === "bundled" ? getBundledSkillsDir() : getLibiSkillsDir();
  const dir = path.join(baseDir, row.name);

  let body: string | null = null;
  try {
    body = fs.readFileSync(path.join(dir, "SKILL.md"), "utf-8");
  } catch {
    body = row.body ?? null;
  }

  let tags: string[] = [];
  try {
    tags = JSON.parse(row.tags) as string[];
  } catch {
    tags = [];
  }

  return NextResponse.json({
    skill: {
      id: row.id,
      name: row.name,
      description: row.description,
      source: row.source,
      enabled: row.enabled,
      body,
      tags,
      prompts: readPromptFiles(dir),
      overriddenFromBundled,
    },
  });
}
