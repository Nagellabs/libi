import { NextResponse } from "next/server";
import { storeFile } from "@/mcp/tools/file-tools";
import { navigationEmitter } from "@/lib/navigation-events";
import { trackServerEvent } from "@/lib/analytics/server";
import { assertSafePieceId } from "@/lib/security/pieceId";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ pieceId: string }> },
) {
  const { pieceId } = await params;

  try {
    assertSafePieceId(pieceId);
  } catch {
    return NextResponse.json({ error: "invalid pieceId" }, { status: 400 });
  }

  const formData = await request.formData();
  const file = formData.get("file");

  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const filename = file.name;
  const contentType = file.type || null;

  const name = formData.get("name") as string | null;
  const description = formData.get("description") as string | null;
  const mediaDuration = formData.get("mediaDuration");
  const mediaWidth = formData.get("mediaWidth");
  const mediaHeight = formData.get("mediaHeight");

  try {
    const record = await storeFile({
      pieceId,
      filename,
      buffer,
      contentType,
      name: name ?? undefined,
      description: description ?? undefined,
      mediaDuration: mediaDuration ? Number(mediaDuration) : undefined,
      mediaWidth: mediaWidth ? Number(mediaWidth) : undefined,
      mediaHeight: mediaHeight ? Number(mediaHeight) : undefined,
    });

    void trackServerEvent("file_uploaded", {
      kind: typeof contentType === "string" && contentType ? contentType.split("/")[0] : "unknown",
    });

    navigationEmitter.emit("refresh_query", { queryKey: "piece", pieceId });

    return NextResponse.json({ file: record });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upload failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
