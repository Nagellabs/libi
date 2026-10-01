import { NextResponse } from "next/server";
import { readPieceAudio } from "@/lib/audio-rights/piece-reader";

interface RouteParams {
  params: Promise<{ pieceId: string }>;
}

/** The export dialog's track list (every track the export plays) and the posting UI's piece summary. */
export async function GET(_req: Request, { params }: RouteParams): Promise<Response> {
  const { pieceId } = await params;
  const a = await readPieceAudio(pieceId);
  return NextResponse.json({
    copyrighted: a.copyrighted.map((s) => ({
      fileId: s.fileId,
      name: s.name,
      fileType: s.fileType ?? null,
      ...(s.rights.track ? { track: s.rights.track } : {}),
      clipSeconds: s.clipSeconds,
      ...(s.rights.platformPicks ? { platformPicks: s.rights.platformPicks } : {}),
    })),
    ownMusic: a.ownMusic.map((s) => ({
      fileId: s.fileId,
      name: s.name,
      fileType: s.fileType ?? null,
      class: s.rights.class,
      ...(s.rights.track ? { track: s.rights.track } : {}),
    })),
  });
}
