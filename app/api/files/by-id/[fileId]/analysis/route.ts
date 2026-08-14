import { NextResponse } from "next/server";
import { getAnalysis } from "@/lib/analysis/manager";

interface RouteContext {
  params: Promise<{ fileId: string }>;
}

export async function GET(_req: Request, ctx: RouteContext): Promise<Response> {
  const { fileId } = await ctx.params;
  const bundle = await getAnalysis({ fileId });
  return NextResponse.json(bundle);
}
