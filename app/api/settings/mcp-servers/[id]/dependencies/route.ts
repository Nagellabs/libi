import { NextResponse } from "next/server";
import { DependencyManager } from "@/mcp/registry/dependency-manager";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_req: Request, { params }: RouteParams) {
  const { id } = await params;
  const manager = new DependencyManager();
  const statuses = await manager.getStatuses(id);
  return NextResponse.json({ dependencies: statuses });
}
