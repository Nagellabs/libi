import { NextResponse } from "next/server";
import {
  addKeyframe,
  deleteKeyframe,
  clearKeyframes,
  setKeyframeEasing,
} from "@/mcp/tools/overlay-tools";
import {
  addKeyframeSchema,
  deleteKeyframeSchema,
  setKeyframeEasingSchema,
} from "@/mcp/tools/schemas";
import { navigationEmitter } from "@/lib/navigation-events";
import { loadManifest } from "@/lib/composition/persistence";
import type { ToolResult } from "@/mcp/tools/types";

interface RouteParams {
  params: Promise<{ pieceId: string; overlayId: string }>;
}

// Body shapes = the MCP schemas minus the id fields (pulled from the URL).
const AddBodySchema = addKeyframeSchema.omit({ pieceId: true, overlayId: true });
const DeleteBodySchema = deleteKeyframeSchema.omit({ pieceId: true, overlayId: true });
const EasingBodySchema = setKeyframeEasingSchema.omit({ pieceId: true, overlayId: true });

/** Read the overlay's monotonic version (best-effort) so clients can reconcile. */
async function readVersion(pieceId: string, overlayId: string): Promise<number | undefined> {
  try {
    const manifest = await loadManifest(pieceId);
    const saved = manifest.overlays?.find((o) => o.id === overlayId) as
      | { version?: number }
      | undefined;
    return saved?.version;
  } catch {
    return undefined;
  }
}

/** Fire the composition refresh SSE (fire-and-forget). */
function emitRefresh(pieceId: string) {
  try {
    navigationEmitter.emit("refresh_query", { queryKey: "composition", pieceId });
  } catch {
    /* fire-and-forget */
  }
}

/**
 * Map a handler ToolResult to an HTTP response: 404 when the overlay is
 * missing, 400 for other failures (out-of-range time, invalid easing, …),
 * else 200 with the refresh fired + the echoed version.
 */
async function respond(
  result: ToolResult,
  pieceId: string,
  overlayId: string,
): Promise<NextResponse> {
  if (!result.success) {
    const notFound = typeof result.error === "string" && result.error.includes("not found");
    return NextResponse.json(result, { status: notFound ? 404 : 400 });
  }
  emitRefresh(pieceId);
  const version = await readVersion(pieceId, overlayId);
  return NextResponse.json({ ...result, ...(version !== undefined ? { version } : {}) });
}

/** POST — add/replace a keyframe. Body: { time, properties?, easing? }. */
export async function POST(req: Request, { params }: RouteParams) {
  const { pieceId, overlayId } = await params;
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = AddBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const result = await addKeyframe({ ...parsed.data, pieceId, overlayId });
  return respond(result, pieceId, overlayId);
}

/**
 * DELETE — remove a keyframe (Body `{ time }` or `?time=`), OR clear EVERY
 * keyframe when `?all=1` is passed (the timeline "Clear all keyframes" action).
 */
export async function DELETE(req: Request, { params }: RouteParams) {
  const { pieceId, overlayId } = await params;

  // ?all=1 → drop the whole keyframes field (no `time` needed).
  if (new URL(req.url).searchParams.get("all") === "1") {
    const result = await clearKeyframes({ pieceId, overlayId });
    return respond(result, pieceId, overlayId);
  }

  // Accept the time from the JSON body OR a ?time= query param.
  let raw: unknown = {};
  try {
    const text = await req.text();
    if (text) raw = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof (raw as { time?: unknown }).time !== "number") {
    const qp = new URL(req.url).searchParams.get("time");
    if (qp !== null) raw = { time: Number(qp) };
  }

  const parsed = DeleteBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const result = await deleteKeyframe({ ...parsed.data, pieceId, overlayId });
  return respond(result, pieceId, overlayId);
}

/** PATCH — set a keyframe's outgoing-segment easing. Body: { time, easing }. */
export async function PATCH(req: Request, { params }: RouteParams) {
  const { pieceId, overlayId } = await params;
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = EasingBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const result = await setKeyframeEasing({ ...parsed.data, pieceId, overlayId });
  return respond(result, pieceId, overlayId);
}
