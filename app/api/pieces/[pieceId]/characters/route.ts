import { NextResponse } from "next/server";
import { CatalogDerive } from "@/lib/catalog/derive";
import { getDb } from "@/lib/db/client";

export async function GET(_req: Request, { params }: { params: Promise<{ pieceId: string }> }) {
  const { pieceId } = await params;
  const groups = new CatalogDerive(getDb() as never).charactersByAssetForPiece(pieceId);
  return NextResponse.json({
    groups: groups.map((g) => ({
      file: g.file,
      characters: g.characters.map((c) => ({
        ...c,
        representativeImageUrl: c.representativeImageFileId
          ? `/api/files/by-id/${c.representativeImageFileId}/content`
          : null,
      })),
    })),
  });
}
