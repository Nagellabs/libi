import { NextResponse } from "next/server";
import { getTerminalManager } from "@/lib/terminal/instance";

/** PATCH /api/terminal/sessions/[id] — rename `{ title }`. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let title: unknown;
  try {
    ({ title } = (await request.json()) as { title?: unknown });
  } catch {
    title = undefined;
  }
  if (typeof title !== "string" || !title.trim()) {
    return NextResponse.json({ error: "title required" }, { status: 400 });
  }
  if (!getTerminalManager().rename(id, title)) {
    return NextResponse.json({ error: "terminal session not found" }, { status: 404 });
  }
  return NextResponse.json({ success: true });
}

/** DELETE /api/terminal/sessions/[id] — kill the PTY and remove the session. */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!getTerminalManager().close(id)) {
    return NextResponse.json({ error: "terminal session not found" }, { status: 404 });
  }
  return NextResponse.json({ success: true });
}
