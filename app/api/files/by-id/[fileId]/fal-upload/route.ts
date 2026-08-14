import { NextResponse } from "next/server";
import { uploadLibiFileToFal } from "@/lib/fal/upload-file";

interface RouteParams {
  params: Promise<{ fileId: string }>;
}

export async function POST(_req: Request, { params }: RouteParams) {
  const { fileId } = await params;

  try {
    const { url, cached } = await uploadLibiFileToFal(fileId);
    return NextResponse.json({ url, cached });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "fal_ai_not_configured") {
      return NextResponse.json({ error: "fal_ai_not_configured" }, { status: 400 });
    }
    if (message === "file_not_found") {
      return NextResponse.json({ error: "file_not_found" }, { status: 404 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
