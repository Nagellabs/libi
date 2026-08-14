import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { skills } from "@/lib/db/schema";
import { listSkillPrompts, addSkillPrompt } from "@/mcp/tools/skill-tools";

interface Params {
  params: Promise<{ id: string }>;
}

const ctx = { pieceId: "" };
const payload = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const row = getDb().select().from(skills).where(eq(skills.id, id)).get();
  if (!row) return NextResponse.json({ error: "Skill not found" }, { status: 404 });
  const res = payload(await listSkillPrompts(ctx, { skillName: row.name }));
  if (res.error) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json(res);
}

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const row = getDb().select().from(skills).where(eq(skills.id, id)).get();
  if (!row) return NextResponse.json({ error: "Skill not found" }, { status: 404 });
  const body = (await request.json().catch(() => null)) as
    | { name?: string; body?: string }
    | null;
  if (!body?.name || !body?.body) {
    return NextResponse.json({ error: "name and body are required" }, { status: 400 });
  }
  const res = payload(
    await addSkillPrompt(ctx, { skillName: row.name, name: body.name, body: body.body }),
  );
  if (res.error) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json(res, { status: 201 });
}
