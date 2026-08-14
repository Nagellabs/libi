import { NextResponse } from "next/server";
import fs from "fs";
import { listBackups } from "@/lib/db/client";

/** GET /api/db/backups — list all DB backups */
export async function GET() {
  const backups = listBackups();
  return NextResponse.json({ backups });
}

/** DELETE /api/db/backups — delete a specific backup by filename */
export async function DELETE(request: Request) {
  const { filename } = (await request.json()) as { filename: string };

  const backups = listBackups();
  const target = backups.find((b) => b.filename === filename);
  if (!target) {
    return NextResponse.json({ success: false, error: "Backup not found" }, { status: 404 });
  }

  try {
    fs.unlinkSync(target.path);
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
