import { NextRequest, NextResponse } from "next/server";
import { searchFrames } from "@/lib/analysis/manager";
import { analysisSearchFramesSchema } from "@/mcp/tools/schemas";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ fileId: string }> },
) {
  const { fileId } = await params;
  const body = await req.json();
  const parsed = analysisSearchFramesSchema.safeParse({ fileId, ...body });
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }
  const matches = await searchFrames(parsed.data);
  return NextResponse.json({ matches });
}
