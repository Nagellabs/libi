import { NextResponse } from "next/server";
import { CatalogDerive } from "@/lib/catalog/derive";
import { getDb } from "@/lib/db/client";

export async function GET(_req: Request, { params }: { params: Promise<{ pieceId: string }> }) {
  const { pieceId } = await params;
  const groups = new CatalogDerive(getDb() as never).itemsByAssetForPiece(pieceId);
  return NextResponse.json({
    groups: groups.map((g) => ({
      file: g.file,
      items: g.items.map((i) => ({
        ...i,
        representativeImageUrl: i.representativeImageFileId
          ? `/api/files/by-id/${i.representativeImageFileId}/content`
          : null,
      })),
    })),
  });
}
