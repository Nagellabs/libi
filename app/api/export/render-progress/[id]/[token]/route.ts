import { NextResponse } from "next/server";
import { recordRenderProgress } from "@/lib/export/render-jobs";

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string; token: string }> },
): Promise<Response> {
  const { id, token } = await context.params;
  let body: { done?: unknown; total?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (typeof body.done !== "number" || typeof body.total !== "number") {
    return NextResponse.json({ error: "missing done/total" }, { status: 400 });
  }
  recordRenderProgress(id, token, body.done, body.total);
  return NextResponse.json({ ok: true });
}
