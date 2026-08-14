import { NextResponse } from "next/server";
import { retryMcpServer } from "@/mcp/tools/mcp-retry-tools";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(
  _req: Request,
  { params }: RouteParams,
) {
  const { id } = await params;
  const result = await retryMcpServer({ mcpId: id });
  return NextResponse.json(result.data ?? { error: result.error }, {
    status: result.success ? 200 : 400,
  });
}
