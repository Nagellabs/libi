import { NextResponse } from "next/server";
import { BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";
import { getInstallPlan } from "@/mcp/bundled-mcps/install-tools";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_req: Request, { params }: RouteParams) {
  const { id } = await params;

  const def = BUNDLED_MCP_SERVERS.find((d) => d.id === id);
  if (!def) {
    return NextResponse.json({ error: `Unknown MCP id "${id}"` }, { status: 404 });
  }

  if (!def.installPlanPath) {
    return NextResponse.json(
      { error: `MCP "${id}" has no install plan` },
      { status: 404 },
    );
  }

  // We've already validated the id and that installPlanPath is set. Any
  // failure from here is a server-side read issue (file missing in the
  // bundle, permission error, etc.) — bundled plan files are repo
  // artifacts so this is a packaging/install bug, not a 404.
  const result = await getInstallPlan({ mcpId: id });
  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  return NextResponse.json({
    mcpId: result.mcpId,
    name: def.name,
    plan: result.plan,
    planPath: result.planPath,
  });
}
