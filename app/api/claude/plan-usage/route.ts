import { NextResponse } from "next/server";
import { fetchPlanUsage } from "@/lib/claude/plan-usage";

// Reads live local credentials + a remote endpoint — never statically cache.
export const dynamic = "force-dynamic";

/**
 * GET /api/claude/plan-usage
 *
 * Authoritative Claude subscription usage windows (Session 5h / Week …) via
 * the claude.ai usage endpoint, authenticated with the LOCAL Claude Code
 * OAuth token (see lib/claude/plan-usage.ts). The token never leaves the
 * server. Response:
 *   { available: true,  windows: PlanUsageWindows }
 *   { available: false, reason: "no_token" | "error" }
 */
export async function GET(): Promise<Response> {
  const result = await fetchPlanUsage();
  if (result.status === "ok") {
    return NextResponse.json({ available: true, windows: result.windows });
  }
  return NextResponse.json({
    available: false,
    reason: result.status === "no_token" ? "no_token" : "error",
  });
}
