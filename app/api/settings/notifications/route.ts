import { NextResponse } from "next/server";
import { z } from "zod/v3";
import {
  getNotificationsSetting,
  setNotificationsSetting,
} from "@/lib/db/settings";
import { serverLogger as logger } from "@/lib/logger";

const bodySchema = z.object({ backgroundJobComplete: z.boolean() });

export async function GET(): Promise<Response> {
  try {
    return NextResponse.json(getNotificationsSetting());
  } catch (err) {
    logger.error(
      {
        tag: "settings-notifications",
        op: "get_failed",
        err: err instanceof Error ? err.message : String(err),
      },
      "Failed to read notifications setting",
    );
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}

export async function PUT(req: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid body", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    setNotificationsSetting(parsed.data);
    return NextResponse.json(parsed.data);
  } catch (err) {
    logger.error(
      {
        tag: "settings-notifications",
        op: "put_failed",
        err: err instanceof Error ? err.message : String(err),
      },
      "Failed to write notifications setting",
    );
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
