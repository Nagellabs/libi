import { NextResponse } from "next/server";
import * as fs from "node:fs";
import * as path from "node:path";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { skills } from "@/lib/db/schema";
import { getLibiSkillsDir } from "@/lib/libi-home";
import { parseSkillBody, serializeSkillBody } from "@/mcp/skills/frontmatter";
import { syncSkillsToWorkspace } from "@/mcp/skills/sync-workspace";
import type { SkillFrontmatter } from "@/mcp/skills/types";

interface Params {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: Request, { params }: Params) {
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as
    | { enabled?: boolean; name?: string; description?: string; body?: string; tags?: string[] }
    | null;
  if (!body) {
    return NextResponse.json({ error: "Body required" }, { status: 400 });
  }
  const row = getDb().select().from(skills).where(eq(skills.id, id)).get();
  if (!row) return NextResponse.json({ error: "Skill not found" }, { status: 404 });

  // Body/name/description updates are only allowed for user skills.
  const wantsContentUpdate =
    typeof body.body === "string" ||
    typeof body.name === "string" ||
    typeof body.description === "string";

  if (wantsContentUpdate) {
    if (row.source !== "user") {
      return NextResponse.json(
        { error: "Cannot edit bundled skills — disable instead" },
        { status: 403 },
      );
    }
    if (typeof body.body !== "string" || !body.body.trim()) {
      return NextResponse.json(
        { error: "SKILL.md body is required", field: "body" },
        { status: 400 },
      );
    }
    if (typeof body.name !== "string" || !body.name.trim()) {
      return NextResponse.json({ error: "Name is required", field: "name" }, { status: 400 });
    }
    if (typeof body.description !== "string" || !body.description.trim()) {
      return NextResponse.json(
        { error: "Description is required", field: "description" },
        { status: 400 },
      );
    }
    let parsed;
    try {
      parsed = parseSkillBody(body.body);
    } catch (err) {
      const message = (err as Error).message;
      const match = message.match(/^([a-z_-]+):\s*(.*)$/i);
      const fieldFromError = match?.[1];
      const field =
        fieldFromError === "name" || fieldFromError === "description"
          ? fieldFromError
          : "body";
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
    // Renaming a user skill: ensure no collision with another user skill.
    if (body.name !== row.name) {
      const collision = getDb()
        .select()
        .from(skills)
        .where(eq(skills.name, body.name))
        .all()
        .some((r) => r.source === "user" && r.id !== id);
      if (collision) {
        return NextResponse.json(
          { error: "A user skill with that name already exists", field: "name" },
          { status: 409 },
        );
      }
    }

    const enabledUpdate = typeof body.enabled === "boolean" ? body.enabled : row.enabled;
    getDb()
      .update(skills)
      .set({
        name: body.name,
        description: body.description,
        body: body.body,
        frontmatter: JSON.stringify(parsed.frontmatter),
        tags: JSON.stringify(parsed.frontmatter.tags ?? []),
        enabled: enabledUpdate,
        updatedAt: new Date(),
      })
      .where(eq(skills.id, id))
      .run();

    // Rewrite on-disk SKILL.md; if the name changed, MOVE the directory so
    // any sibling supporting files (scripts/, references/, assets/) survive.
    const oldDir = path.join(getLibiSkillsDir(), row.name);
    const newDir = path.join(getLibiSkillsDir(), body.name);
    if (oldDir !== newDir && fs.existsSync(oldDir)) {
      fs.renameSync(oldDir, newDir);
    }
    fs.mkdirSync(newDir, { recursive: true });
    const skillPath = path.join(newDir, "SKILL.md");
    const tmpPath = `${skillPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmpPath, body.body);
    fs.renameSync(tmpPath, skillPath);
    await syncSkillsToWorkspace();
    return NextResponse.json({
      skill: { id, name: body.name, description: body.description, enabled: enabledUpdate },
    });
  }

  // Tags-only update (works for bundled + user — DB column is the source of truth).
  if (Array.isArray(body.tags) && !wantsContentUpdate) {
    const tags = body.tags.map((t) => String(t).trim()).filter(Boolean);

    // For user skills, keep the on-disk SKILL.md frontmatter consistent with the tags.
    let nextBody: string | undefined;
    let nextFm: SkillFrontmatter | undefined;
    if (row.source === "user" && row.body) {
      try {
        const { frontmatter, body: md } = parseSkillBody(row.body);
        nextFm = { ...frontmatter, tags };
        nextBody = serializeSkillBody(nextFm, md);
      } catch {
        // serialize is best-effort; fall back to tags-only DB update
      }
    }

    getDb()
      .update(skills)
      .set({
        tags: JSON.stringify(tags),
        ...(nextBody && nextFm ? { body: nextBody, frontmatter: JSON.stringify(nextFm) } : {}),
        updatedAt: new Date(),
      })
      .where(eq(skills.id, id))
      .run();

    if (nextBody) {
      const skillPath = path.join(getLibiSkillsDir(), row.name, "SKILL.md");
      const tmp = `${skillPath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, nextBody);
      fs.renameSync(tmp, skillPath);
    }

    await syncSkillsToWorkspace();
    return NextResponse.json({ skill: { id, tags } });
  }

  // Pure enabled toggle (legacy path — works for bundled + user).
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled (boolean) required" }, { status: 400 });
  }
  getDb()
    .update(skills)
    .set({ enabled: body.enabled, updatedAt: new Date() })
    .where(eq(skills.id, id))
    .run();
  await syncSkillsToWorkspace();
  return NextResponse.json({ skill: { id, enabled: body.enabled } });
}

export async function DELETE(_request: Request, { params }: Params) {
  const { id } = await params;
  const row = getDb().select().from(skills).where(eq(skills.id, id)).get();
  if (!row) return NextResponse.json({ error: "Skill not found" }, { status: 404 });
  if (row.source === "bundled") {
    return NextResponse.json({ error: "Cannot delete bundled skills — disable instead" }, { status: 403 });
  }
  getDb().delete(skills).where(eq(skills.id, id)).run();
  fs.rmSync(path.join(getLibiSkillsDir(), row.name), { recursive: true, force: true });
  await syncSkillsToWorkspace();
  return NextResponse.json({ success: true });
}
