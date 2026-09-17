import { NextResponse } from "next/server";
import { serverLogger as logger } from "@/lib/logger";
import { isSetupAgentId } from "@/lib/agents/setup/registry";
import { SkillInstallError, addSkillInstall, shortInstallError, skillInstallsResponse } from "@/mcp/skills/installs";
import { sanitizeErrForLog } from "@/mcp/skills/writer";
import type { AddSkillInstallInput } from "@/lib/agents/skill-installs-types";

export const dynamic = "force-dynamic";

/** Where libi installed its skills for the user's own Claude Code / Codex, with status computed on read. */
export async function GET(): Promise<Response> {
  try {
    return NextResponse.json(await skillInstallsResponse());
  } catch (err) {
    logger.error({ err: sanitizeErrForLog(err), tag: "skills", op: "installs_list_failed" }, "skills.installs_list_failed");
    return NextResponse.json({ error: "install_failed", message: shortInstallError(err) }, { status: 500 });
  }
}

/** Record an install and write it now. Pressing Install / Add is the consent. */
export async function POST(req: Request): Promise<Response> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body", message: "Invalid JSON" }, { status: 400 });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return NextResponse.json({ error: "invalid_body", message: "Expected a JSON object." }, { status: 400 });
  }
  const body = parsed as { agentId?: unknown; scope?: unknown; folderPath?: unknown };
  const agentId = body.agentId;
  if (typeof agentId !== "string" || !isSetupAgentId(agentId)) {
    return NextResponse.json({ error: "unknown_agent", message: "Unknown agent." }, { status: 400 });
  }
  let input: AddSkillInstallInput;
  if (body.scope === "user") {
    input = { agentId, scope: "user", source: "ui" };
  } else if (body.scope === "folder" && typeof body.folderPath === "string") {
    input = { agentId, scope: "folder", folderPath: body.folderPath, source: "ui" };
  } else {
    return NextResponse.json({ error: "invalid_body", message: "Choose Every folder or a specific folder." }, { status: 400 });
  }
  try {
    return NextResponse.json({ install: await addSkillInstall(input) });
  } catch (err) {
    if (err instanceof SkillInstallError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: 400 });
    }
    // A raw failure (e.g. a filesystem error while an "every folder" install
    // tears down that agent's existing folder installs) must never escape as
    // an unhandled 500 with a stack — log it, answer a short message instead.
    logger.error(
      { err: sanitizeErrForLog(err), agentId: input.agentId, scope: input.scope, tag: "skills", op: "install_add_failed" },
      "skills.install_add_failed",
    );
    return NextResponse.json({ error: "install_failed", message: shortInstallError(err) }, { status: 500 });
  }
}
