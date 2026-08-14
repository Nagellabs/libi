import { NextResponse } from "next/server";
import { readMemories, writeMemories, MEMORIES_MAX_CHARS } from "@/lib/instructions/memories";
import { regenerateAndRestart } from "@/mcp/workspace";
import { emitSecuritySettingsChanged } from "@/lib/navigation-events";
import { serverLogger as logger } from "@/lib/logger";

export async function GET(): Promise<Response> {
  return NextResponse.json({ content: readMemories() });
}

export async function PUT(request: Request): Promise<Response> {
  let body: { content?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const content = typeof body.content === "string" ? body.content : "";
  if (content.length > MEMORIES_MAX_CHARS) {
    return NextResponse.json(
      { error: `Memories exceed ${MEMORIES_MAX_CHARS} chars` },
      { status: 400 },
    );
  }
  writeMemories(content);
  logger.warn(
    { tag: "security", op: "memories_http_write" },
    "agent memories written via HTTP settings route",
  );
  emitSecuritySettingsChanged({ kind: "memories", via: "http" });
  const { sessionsTerminated } = await regenerateAndRestart();
  return NextResponse.json({ ok: true, sessionsTerminated });
}
