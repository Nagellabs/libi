import { NextResponse } from "next/server";
import { getJobManager } from "@/lib/jobs/manager";
import { JobNotFoundError } from "@/lib/jobs/types";

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const mgr = getJobManager();
  try {
    const snap = await mgr.getStatus(id);
    return NextResponse.json(snap);
  } catch (err) {
    if (err instanceof JobNotFoundError) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "internal error" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const mgr = getJobManager();
  try {
    await mgr.cancel(id);
    return NextResponse.json({ accepted: true });
  } catch (err) {
    if (err instanceof JobNotFoundError) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "internal error" },
      { status: 500 },
    );
  }
}
