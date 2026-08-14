import { NextResponse } from "next/server";
import { DependencyManager } from "@/mcp/registry/dependency-manager";
import { invalidateMcpConfig } from "@/lib/mcp-config";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const failedOnly = (body as { failedOnly?: boolean }).failedOnly ?? false;

  const manager = new DependencyManager();
  await manager.ensureAll({ failedOnly });

  try { invalidateMcpConfig({ reason: "resync" }); } catch { /* may not be initialized */ }

  return NextResponse.json({ success: true });
}
