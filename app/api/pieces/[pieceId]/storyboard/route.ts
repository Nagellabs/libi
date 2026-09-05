// app/api/pieces/[pieceId]/storyboard/route.ts
import fs from "fs/promises";
import { NextResponse } from "next/server";
import { loadStoryboard, updateManifestLayout } from "@/lib/storyboard/repo";
import { resolveInheritedRefs } from "@/lib/storyboard/resolve-refs";
import { getModelSchemaCache } from "@/lib/storyboard/model-schema-cache";
import { getStorage } from "@/lib/storage";
import { slotSketchPath } from "@/lib/storyboard/paths";
import { sketchRev } from "@/lib/storyboard/sketch-rev";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ pieceId: string }> },
) {
  const { pieceId } = await ctx.params;
  const sb = await loadStoryboard(pieceId);
  if (!sb) return NextResponse.json({ storyboard: null, schemas: {}, sketchRevs: {} });
  const resolvedCards = sb.cards.map((c) => resolveInheritedRefs(c, sb.cards));
  const schemas: Record<string, { apiUrl: string; model: string; lookup: Awaited<ReturnType<typeof getModelSchemaCache>> }> = {};
  for (const c of resolvedCards) {
    for (const spec of [c.keyframeGen, c.clipGen]) {
      if (!spec || !spec.apiUrl) continue;
      const k = `${spec.apiUrl}::${spec.model}`;
      if (!schemas[k]) schemas[k] = { apiUrl: spec.apiUrl, model: spec.model, lookup: await getModelSchemaCache(spec.apiUrl, spec.model) };
    }
  }

  // Per-slot render revision: a content hash of the sketch PNG's bytes. The
  // image URL is otherwise invariant, and the PNG is regenerated IN PLACE, so
  // a browser that already has the element mounted never re-requests it — the
  // card's text updated live while its drawing stayed stale until a remount.
  // Per slot rather than per board so a text edit on one card does not force
  // every sketch on the board to re-download.
  //
  // Content-based, NOT mtime-based: `handleStoryboardChange`
  // (lib/storyboard/watcher.ts) re-renders EVERY card's sketches on ANY
  // storyboard change, so editing only a card's title rewrites every sketch
  // PNG on the board with byte-identical content and a fresh mtime. An mtime
  // rev would bust every sketch's cache on every text edit; hashing the bytes
  // only changes the rev when the drawing actually changes.
  const storage = await getStorage();
  const sketchRevs: Record<string, Record<string, string>> = {};
  for (const c of resolvedCards) {
    sketchRevs[c.id] = {};
    for (const s of c.sketches ?? []) {
      try {
        const bytes = await fs.readFile(storage.localPath(pieceId, slotSketchPath(c.id, s.id)));
        sketchRevs[c.id][s.id] = sketchRev(bytes);
      } catch {
        // Not rendered yet — the GET route for the slot lazy-renders on demand.
        // "" is falsy, so sketchUrl still returns the bare (revless) URL.
        sketchRevs[c.id][s.id] = "";
      }
    }
  }

  return NextResponse.json({ storyboard: { ...sb, cards: resolvedCards }, schemas, sketchRevs });
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ pieceId: string }> },
) {
  const { pieceId } = await ctx.params;
  const body = (await req.json().catch(() => null)) as
    | { layout?: { positions: Record<string, { x: number; y: number }> } }
    | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  if (body.layout) await updateManifestLayout(pieceId, body.layout);
  return NextResponse.json({ ok: true });
}
