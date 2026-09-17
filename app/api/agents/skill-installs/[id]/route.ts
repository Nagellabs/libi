import { NextResponse } from "next/server";
import { serverLogger as logger } from "@/lib/logger";
import { SkillInstallError, removeSkillInstall, shortInstallError } from "@/mcp/skills/installs";
import { sanitizeErrForLog } from "@/mcp/skills/writer";

export const dynamic = "force-dynamic";

/** Remove libi's files from that install, then forget it. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  try {
    const result = await removeSkillInstall(id);
    if (!result) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(result);
  } catch (err) {
    // A refusal (an install reached through a linked skills folder) is the service's decision, with
    // a message the user can act on, and the service has logged it.
    if (err instanceof SkillInstallError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: 400 });
    }
    // A raw failure (e.g. a filesystem error while removing that install's
    // files) must never escape as an unhandled 500 with a stack — and the raw
    // `err` itself must never be logged: its message/stack can carry the
    // install's folder path, which a user's project folder name can make
    // private (only the install id and a sanitized error code are kept).
    logger.error(
      { err: sanitizeErrForLog(err), tag: "skills", op: "install_remove_failed", id },
      "skills.install_remove_failed",
    );
    return NextResponse.json({ error: "install_failed", message: shortInstallError(err) }, { status: 500 });
  }
}
