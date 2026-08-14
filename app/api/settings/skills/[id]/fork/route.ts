import { NextResponse } from "next/server";
import { forkSkill } from "@/mcp/tools/skill-tools";

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(_request: Request, { params }: Params) {
  const { id } = await params;
  const res = JSON.parse((await forkSkill({ pieceId: "" }, { id })).content[0].text);
  if (res.error) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json(res, { status: 201 });
}
