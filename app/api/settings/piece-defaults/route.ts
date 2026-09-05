import { NextResponse } from "next/server";
import { z } from "zod/v3";
import { getPieceDefaults, setPieceDefaults } from "@/lib/db/settings";
import { ratioById } from "@/lib/composition/aspect-ratio";
import { serverLogger as logger } from "@/lib/logger";

const bodySchema = z.object({
  aspectRatioId: z.string().refine((id) => ratioById(id) !== null, {
    message: "unknown aspect ratio id",
  }),
});

export async function GET(): Promise<Response> {
  try {
    return NextResponse.json(getPieceDefaults());
  } catch (err) {
    logger.error(
      {
        tag: "settings-piece-defaults",
        op: "get_failed",
        err: err instanceof Error ? err.message : String(err),
      },
      "Failed to read piece defaults",
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
    setPieceDefaults(parsed.data);
    return NextResponse.json(parsed.data);
  } catch (err) {
    logger.error(
      {
        tag: "settings-piece-defaults",
        op: "put_failed",
        err: err instanceof Error ? err.message : String(err),
      },
      "Failed to write piece defaults",
    );
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
