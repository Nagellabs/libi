import { NextResponse } from "next/server";
import { getExportView } from "@/lib/exports/store";
import { removeExport, renameExport } from "@/lib/exports/actions";
import { browserOnlyRefusal } from "@/lib/security/request-guard";
import { exportLogger } from "@/lib/logger";

interface RouteParams {
  params: Promise<{ exportId: string }>;
}

export async function GET(_req: Request, { params }: RouteParams) {
  const { exportId } = await params;
  const view = await getExportView(exportId);
  if (!view) return NextResponse.json({ error: "not_found", message: "That export does not exist any more." }, { status: 404 });
  return NextResponse.json({ export: view });
}

/** Rename — the user's, from libi's own page (`browserOnlyRefusal`). No agent tool renames an export. */
export async function PATCH(req: Request, { params }: RouteParams) {
  const refused = browserOnlyRefusal(req);
  if (refused) {
    exportLogger.warn({ op: "record_rename_refused", reason: refused }, "export.record_rename_refused");
    return NextResponse.json(
      { error: "browser_only", code: "browser_only", message: "Exports are renamed only on libi's own page." },
      { status: 403 },
    );
  }
  let body: { name?: unknown };
  try {
    body = (await req.json()) as { name?: unknown };
  } catch {
    return NextResponse.json({ error: "bad_request", message: "Invalid JSON" }, { status: 400 });
  }
  const { exportId } = await params;
  const result = await renameExport(exportId, typeof body.name === "string" ? body.name : "");
  if (!result.ok) return NextResponse.json({ error: result.code, message: result.message }, { status: result.status });
  return NextResponse.json({ export: await getExportView(exportId) });
}

/** Delete (and cancel, when it is still running) — the user's, from libi's own page. */
export async function DELETE(req: Request, { params }: RouteParams) {
  const refused = browserOnlyRefusal(req);
  if (refused) {
    exportLogger.warn({ op: "record_delete_refused", reason: refused }, "export.record_delete_refused");
    return NextResponse.json(
      { error: "browser_only", code: "browser_only", message: "Exports are deleted only on libi's own page." },
      { status: 403 },
    );
  }
  const { exportId } = await params;
  const result = await removeExport(exportId);
  if (!result.ok) return NextResponse.json({ error: result.code, message: result.message }, { status: result.status });
  return NextResponse.json({ ok: true });
}
