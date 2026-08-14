import { NextResponse } from "next/server";
import { getStorage } from "@/lib/storage";
import { slotSketchPath } from "@/lib/storyboard/paths";
import { loadCard, editSketch } from "@/lib/storyboard/repo";
import { renderCardSketch } from "@/lib/storyboard/render-card";

function bad(seg: string): boolean {
  return seg.includes("/") || seg.includes("..") || seg.includes("\\");
}

/** Set (or clear, with imageFileId:null) the imported image used AS this slot's
 *  sketch — the source for "import a sketch image" in the card's Add/import menu. */
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ pieceId: string; cardId: string; slotId: string }> },
) {
  const { pieceId, cardId, slotId } = await ctx.params;
  if (bad(pieceId) || bad(cardId) || bad(slotId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const body = (await req.json().catch(() => ({}))) as { imageFileId?: string | null };
  if (!("imageFileId" in body)) {
    return NextResponse.json({ error: "imageFileId required" }, { status: 400 });
  }
  const res = await editSketch(pieceId, cardId, slotId, { imageFileId: body.imageFileId ?? null });
  if (!res) return NextResponse.json({ error: "card or slot not found" }, { status: 404 });
  return NextResponse.json({ card: res.card });
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ pieceId: string; cardId: string; slotId: string }> },
) {
  const { pieceId, cardId, slotId } = await ctx.params;
  if (bad(pieceId) || bad(cardId) || bad(slotId)) return new Response("Invalid id", { status: 400 });

  const storage = await getStorage();
  const rel = slotSketchPath(cardId, slotId);

  // Lazy render: if the PNG isn't on disk yet (new slot, or a normalized legacy
  // card not yet re-rendered by the watcher), render it on demand.
  if (!(await storage.exists(pieceId, rel))) {
    const card = await loadCard(pieceId, cardId);
    const slot = card?.sketches.find((s) => s.id === slotId);
    if (!card || !slot) return new Response("Not found", { status: 404 });
    try {
      const out = await renderCardSketch(pieceId, card, slot);
      if (!out) return new Response("Not found", { status: 404 });
    } catch {
      return new Response("Render failed", { status: 500 });
    }
  }

  const bytes = await storage.read(pieceId, rel);
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { "content-type": "image/png", "cache-control": "no-store" },
  });
}
