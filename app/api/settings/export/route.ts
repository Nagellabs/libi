import { NextResponse } from "next/server";
import { z } from "zod/v3";
import {
  getExportDefaults,
  setExportDefaults,
  resolveExportFolder,
} from "@/lib/db/settings";
import { defaultExportFolder } from "@/lib/export/folder";
import { serverLogger as logger } from "@/lib/logger";

const bodySchema = z.object({
  folder: z.string().nullable(),
  format: z.enum(["mp4", "webm"]),
  quality: z.enum(["source", "1080p", "1440p", "4k"]),
  // Optional so an older client (or one that only edits the media field)
  // doesn't clobber the stored graphics default — see PUT below.
  graphicsQuality: z.enum(["1080p", "1440p", "4k"]).optional(),
});

export async function GET(): Promise<Response> {
  try {
    const defaults = getExportDefaults();
    return NextResponse.json({
      ...defaults,
      effectiveFolder: resolveExportFolder(),
      osDefaultFolder: defaultExportFolder(),
    });
  } catch (err) {
    logger.error(
      {
        tag: "settings-export",
        op: "get_failed",
        err: err instanceof Error ? err.message : String(err),
      },
      "Failed to read export defaults",
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
    // Normalize empty strings to null so "resolveExportFolder" uses the OS default.
    const folder = parsed.data.folder?.trim() ? parsed.data.folder : null;
    // Missing graphicsQuality keeps whatever is already stored (falling back
    // to "4k" itself when nothing was ever stored) rather than resetting it.
    const graphicsQuality = parsed.data.graphicsQuality ?? getExportDefaults().graphicsQuality;
    setExportDefaults({ ...parsed.data, folder, graphicsQuality });
    return NextResponse.json({
      ...parsed.data,
      folder,
      graphicsQuality,
      effectiveFolder: resolveExportFolder(),
      osDefaultFolder: defaultExportFolder(),
    });
  } catch (err) {
    logger.error(
      {
        tag: "settings-export",
        op: "put_failed",
        err: err instanceof Error ? err.message : String(err),
      },
      "Failed to write export defaults",
    );
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
