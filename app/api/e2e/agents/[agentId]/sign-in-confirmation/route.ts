/**
 * E2E-only: forget the wizard's sign-in confirmation for one agent, so a spec
 * that stored one through POST /api/agents/<id>/sign-in-confirmation can leave
 * the scratch DB as it found it. The product has no undo for that POST — only
 * an OBSERVED auth rejection clears a confirmation — so it lives with the other
 * test routes instead of on the product route.
 *
 * DISABLED by default. Enabled only by `LIBI_ENABLE_TEST_ROUTES=1`, which the
 * e2e runner sets on the libi it spawns.
 */
import { NextResponse } from "next/server";
import { clearSignInConfirmation } from "@/lib/agents/sign-in-confirmation";
import { isSetupAgentId } from "@/lib/agents/setup/registry";
import { testRoutesEnabled } from "@/lib/security/test-routes";

export async function DELETE(_request: Request, { params }: { params: Promise<{ agentId: string }> }): Promise<Response> {
  if (!testRoutesEnabled()) {
    return NextResponse.json({ error: "E2E test routes are disabled in this environment" }, { status: 403 });
  }
  const { agentId } = await params;
  if (!isSetupAgentId(agentId)) return NextResponse.json({ error: "unknown agent" }, { status: 400 });
  clearSignInConfirmation(agentId);
  return NextResponse.json({ confirmedAt: null });
}
