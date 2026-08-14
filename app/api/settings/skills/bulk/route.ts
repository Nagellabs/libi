import { NextResponse } from "next/server";
import { inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { skills } from "@/lib/db/schema";
import { syncSkillsToWorkspace } from "@/mcp/skills/sync-workspace";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | { ids?: string[]; enabled?: boolean }
    | null;
  if (!Array.isArray(body?.ids) || typeof body?.enabled !== "boolean") {
    return NextResponse.json(
      { error: "ids (array) and enabled (boolean) are required" },
      { status: 400 },
    );
  }
  if (body.ids.length === 0) return NextResponse.json({ updated: 0, enabled: body.enabled });
  getDb()
    .update(skills)
    .set({ enabled: body.enabled, updatedAt: new Date() })
    .where(inArray(skills.id, body.ids))
    .run();
  await syncSkillsToWorkspace();
  return NextResponse.json({ updated: body.ids.length, enabled: body.enabled });
}
