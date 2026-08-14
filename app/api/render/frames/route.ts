// Next.js-SERVER-ONLY. Rasterizes real composition frames (base scene + overlays)
// to PNG files and runs edge-overflow detection on each. Invoked by the MCP tool
// renderOverlayFrames via HTTP (cross-process pattern: MCP child → Next.js server).
import * as fs from "node:fs/promises";
import { NextResponse } from "next/server";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { renderCompositionFrames } from "@/lib/render/frame-capture";
import { detectEdgeOverflow } from "@/lib/render/overflow-detect";
import { loadComposition } from "@/lib/composition/persistence";
import { serverLogger as logger } from "@/lib/logger";

interface Body {
  pieceId: string;
  atTimes?: number[];
  overlayId?: string;
  source?: "draft" | "snapshot";
}

export async function POST(req: Request): Promise<Response> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.pieceId) {
    return NextResponse.json({ error: "Missing pieceId" }, { status: 400 });
  }

  // Resolve timestamps
  let atTimes = body.atTimes?.slice(0, 8);
  if ((!atTimes || atTimes.length === 0) && body.overlayId) {
    const { manifest } = await loadComposition(body.pieceId);
    const ov = (manifest.overlays ?? []).find((o: { id: string }) => o.id === body.overlayId);
    if (!ov) {
      return NextResponse.json(
        { error: `overlay ${body.overlayId} not found` },
        { status: 404 },
      );
    }
    const start = (ov as { startTime?: number }).startTime ?? 0;
    const dur = (ov as { duration?: number }).duration ?? 0;
    const eps = Math.min(0.05, dur / 10);
    atTimes = [start + eps, start + dur / 2, Math.max(start + eps, start + dur - eps)];
  }

  if (!atTimes || atTimes.length === 0) {
    return NextResponse.json({ error: "Provide atTimes or overlayId" }, { status: 400 });
  }

  try {
    const captured = await renderCompositionFrames(body.pieceId, atTimes, {
      source: body.source,
    });

    const frames = await Promise.all(
      captured.map(async (f) => {
        // loadImage in @napi-rs/canvas accepts a Buffer (see lib/tracking/verify-render.ts)
        const buf = await fs.readFile(f.path);
        const img = await loadImage(buf);
        const c = createCanvas(img.width, img.height);
        const cx = c.getContext("2d");
        cx.drawImage(img, 0, 0);
        const { data } = cx.getImageData(0, 0, img.width, img.height);
        const overflow = detectEdgeOverflow(data, img.width, img.height);
        return { time: f.time, path: f.path, overflow };
      }),
    );

    return NextResponse.json({ frames });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { tag: "render-verify", op: "route", pieceId: body.pieceId, err: message },
      "render frames route failed",
    );
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
