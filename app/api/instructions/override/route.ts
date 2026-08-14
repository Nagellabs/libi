import { NextResponse } from "next/server";
import {
  saveInstructionsOverride,
  revertInstructionsOverride,
} from "@/lib/instructions/override";
import { regenerateAndRestart } from "@/mcp/workspace";
import { emitSecuritySettingsChanged } from "@/lib/navigation-events";
import { serverLogger as logger } from "@/lib/logger";

export async function POST(request: Request): Promise<Response> {
  let body: { content?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const content = typeof body.content === "string" ? body.content : "";
  if (content.trim().length === 0) {
    return NextResponse.json({ error: "Override content must not be empty" }, { status: 400 });
  }
  saveInstructionsOverride(content);
  logger.warn(
    { tag: "security", op: "instructions_override_http_write" },
    "agent instructions override written via HTTP settings route",
  );
  emitSecuritySettingsChanged({ kind: "instructions-override", via: "http" });
  const { sessionsTerminated } = await regenerateAndRestart();
  return NextResponse.json({ ok: true, sessionsTerminated });
}

export async function DELETE(): Promise<Response> {
  revertInstructionsOverride();
  logger.warn(
    { tag: "security", op: "instructions_override_http_revert" },
    "agent instructions override reverted via HTTP settings route",
  );
  emitSecuritySettingsChanged({ kind: "instructions-override", via: "http", reverted: true });
  const { sessionsTerminated } = await regenerateAndRestart();
  return NextResponse.json({ ok: true, sessionsTerminated });
}
