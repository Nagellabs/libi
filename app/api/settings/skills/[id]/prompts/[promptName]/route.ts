import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { skills } from "@/lib/db/schema";
import { updateSkillPrompt, removeSkillPrompt } from "@/mcp/tools/skill-tools";

interface Params {
  params: Promise<{ id: string; promptName: string }>;
}

const ctx = { pieceId: "" };
const payload = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);

async function resolveSkillName(id: string): Promise<string | null> {
  const row = getDb().select().from(skills).where(eq(skills.id, id)).get();
  return row?.name ?? null;
}

export async function PUT(request: Request, { params }: Params) {
  const { id, promptName } = await params;
  const name = await resolveSkillName(id);
  if (!name) return NextResponse.json({ error: "Skill not found" }, { status: 404 });
  const body = (await request.json().catch(() => null)) as { body?: string } | null;
  if (!body?.body) return NextResponse.json({ error: "body is required" }, { status: 400 });
  const res = payload(
    await updateSkillPrompt(ctx, { skillName: name, name: promptName, body: body.body }),
  );
  if (res.error) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json(res);
}

export async function DELETE(_request: Request, { params }: Params) {
  const { id, promptName } = await params;
  const name = await resolveSkillName(id);
  if (!name) return NextResponse.json({ error: "Skill not found" }, { status: 404 });
  const res = payload(await removeSkillPrompt(ctx, { skillName: name, name: promptName }));
  if (res.error) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json(res);
}
