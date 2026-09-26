import { NextResponse } from "next/server";
import { z } from "zod/v3";
import { navigationEmitter } from "@/lib/navigation-events";
import { trackServerEvent } from "@/lib/analytics/server";
import { serverLogger as logger } from "@/lib/logger";
import { isSafePieceId } from "@/lib/security/pieceId";
import {
  DELETED_PUBLISHED_NOTE,
  DELETE_WHILE_PUBLISHING,
  deleteTemplate,
  getTemplateSummary,
  localUsage,
  readInstructions,
  readScaffold,
  updateTemplate,
  TEMPLATES_LOG_TAG,
} from "@/lib/templates/store";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(500).optional(),
  tags: z.array(z.string()).max(10).optional(),
});

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/templates/[id] — the summary the list carries, plus the scaffold
 *  (null when the folder is broken; `template.broken` says why), index.md,
 *  and its use on this machine (`usage`: total, 7 d, 30 d, last used) for
 *  the template's page. */
export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  if (!isSafePieceId(id)) return NextResponse.json({ error: "template_not_found" }, { status: 404 });
  const template = await getTemplateSummary(id);
  if (!template) return NextResponse.json({ error: "template_not_found" }, { status: 404 });
  const read = await readScaffold(id);
  let instructions = "";
  try {
    instructions = await readInstructions(id);
  } catch {
    // A hand-planted index.md symlink or an oversize file: the template still
    // lists and renders, it just has no instructions to show.
    instructions = "";
  }
  return NextResponse.json({ template, scaffold: read.ok ? read.scaffold : null, instructions, usage: localUsage(id) });
}

/** The validation failures the store reports by a message prefix. Only these
 *  are echoed to the client — anything else is an unexpected failure (an fs
 *  error writing template.json, say) whose message is for the log, not for a
 *  response body. */
const KNOWN_PATCH_ERRORS: ReadonlyArray<[prefix: string, code: string]> = [
  ["tags", "invalid_tags"],
  ["name", "invalid_name"],
  ["description", "invalid_description"],
];

/** PATCH /api/templates/[id] — rename, re-describe, re-tag. The store is the
 *  validator; its thrown message picks the error code the page shows. */
export async function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  if (!isSafePieceId(id)) return NextResponse.json({ error: "template_not_found" }, { status: 404 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", issues: parsed.error.issues }, { status: 400 });
  }
  // A patch with no field in it is a no-op, not an edit: `updateTemplate` would
  // still bump `version` and `updatedAt`, which reorders a `most-used` tie and
  // makes an inspector that saves on close look like a change nobody made.
  if (Object.keys(parsed.data).length === 0) {
    const current = await getTemplateSummary(id);
    if (!current) return NextResponse.json({ error: "template_not_found" }, { status: 404 });
    return NextResponse.json({ template: current });
  }
  try {
    const row = await updateTemplate(id, parsed.data);
    if (!row) return NextResponse.json({ error: "template_not_found" }, { status: 404 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const known = KNOWN_PATCH_ERRORS.find(([prefix]) => msg.startsWith(prefix));
    if (!known) {
      logger.error(
        { tag: TEMPLATES_LOG_TAG, op: "patch_failed", templateId: id, err: msg },
        "template patch failed",
      );
      return NextResponse.json({ error: "invalid_body" }, { status: 400 });
    }
    return NextResponse.json({ error: known[1], message: msg }, { status: 400 });
  }
  navigationEmitter.emit("refresh_query", { queryKey: "templates" });
  return NextResponse.json({ template: await getTemplateSummary(id) });
}

/** DELETE /api/templates/[id] — the row and the folder, together. */
export async function DELETE(_req: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  if (!isSafePieceId(id)) return NextResponse.json({ error: "template_not_found" }, { status: 404 });
  const r = await deleteTemplate(id);
  if (!r.deleted && r.reason === "publishing") {
    return NextResponse.json({ error: "publishing", message: DELETE_WHILE_PUBLISHING }, { status: 409 });
  }
  if (!r.deleted) return NextResponse.json({ error: "template_not_found" }, { status: 404 });
  trackServerEvent("template_deleted");
  navigationEmitter.emit("refresh_query", { queryKey: "templates" });
  return NextResponse.json({ ok: true, ...(r.cloudId ? { note: DELETED_PUBLISHED_NOTE } : {}) });
}
