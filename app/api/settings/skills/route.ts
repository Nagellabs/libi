import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { skills } from "@/lib/db/schema";
import { getBundledSkillsDir, getLibiSkillsDir } from "@/lib/libi-home";
import { parseSkillBody } from "@/mcp/skills/frontmatter";
import { readPromptFiles } from "@/mcp/skills/prompt-files";
import { syncSkillsToWorkspace } from "@/mcp/skills/sync-workspace";
import { computeOverrideStatus } from "@/mcp/skills/override-status";

export async function GET() {
  const rows = getDb().select().from(skills).all();
  const overrideStatus = computeOverrideStatus(rows);
  return NextResponse.json({
    skills: rows.map((r) => {
      const baseDir = r.source === "bundled" ? getBundledSkillsDir() : getLibiSkillsDir();
      let tags: string[] = [];
      try {
        tags = JSON.parse(r.tags) as string[];
      } catch {
        tags = [];
      }
      const status = r.source === "user" ? overrideStatus.get(r.name) : undefined;
      return {
        id: r.id,
        name: r.name,
        description: r.description,
        source: r.source,
        enabled: r.enabled,
        body: r.source === "user" ? r.body : null,
        tags,
        prompts: readPromptFiles(path.join(baseDir, r.name)),
        ...(status ? { bundledUpdatedSinceFork: status.bundledUpdatedSinceFork } : {}),
      };
    }),
  });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { name?: string; description?: string; body?: string; enabled?: boolean } | null;
  if (!body?.name) {
    return NextResponse.json({ error: "Name is required", field: "name" }, { status: 400 });
  }
  if (!body?.description) {
    return NextResponse.json({ error: "Description is required", field: "description" }, { status: 400 });
  }
  if (!body?.body) {
    return NextResponse.json({ error: "SKILL.md body is required", field: "body" }, { status: 400 });
  }
  let parsed;
  try {
    parsed = parseSkillBody(body.body);
  } catch (err) {
    const message = (err as Error).message;
    // parseSkillBody prefixes with "<field>: " when the failure maps to a frontmatter field
    const match = message.match(/^([a-z_-]+):\s*(.*)$/i);
    const field = match && match[1] === "name" ? "name" : "body";
    const cleanMessage = match ? match[2] : message;
    return NextResponse.json({ error: cleanMessage, field }, { status: 400 });
  }
  if (parsed.frontmatter.name !== body.name) {
    return NextResponse.json(
      {
        error: `Name "${body.name}" doesn't match the SKILL.md frontmatter name "${parsed.frontmatter.name}". Update one to match the other.`,
        field: "name",
      },
      { status: 400 },
    );
  }
  const existing = getDb().select().from(skills).where(eq(skills.name, body.name)).all();
  if (existing.some((r) => r.source === "user")) {
    return NextResponse.json({ error: "A user skill with that name already exists", field: "name" }, { status: 409 });
  }
  const id = randomUUID();
  getDb()
    .insert(skills)
    .values({
      id,
      name: body.name,
      description: body.description,
      source: "user",
      // Default-disabled (RC-A defense-in-depth): a skill created through this
      // HTTP route must not auto-activate. The user (or an explicit
      // enabled:true in the request) enables it afterward.
      enabled: body.enabled === true,
      body: body.body,
      frontmatter: JSON.stringify(parsed.frontmatter),
      tags: JSON.stringify(parsed.frontmatter.tags ?? []),
    })
    .run();
  const dir = path.join(getLibiSkillsDir(), body.name);
  fs.mkdirSync(dir, { recursive: true });
  const skillPath = path.join(dir, "SKILL.md");
  const tmpPath = `${skillPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, body.body);
  fs.renameSync(tmpPath, skillPath);
  await syncSkillsToWorkspace();
  return NextResponse.json({ skill: { id, name: body.name } }, { status: 201 });
}
