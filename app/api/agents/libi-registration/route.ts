import { NextResponse } from "next/server";
import { detectLibiRegistration, type LibiRegistrations } from "@/lib/agents/libi-registration";
import { serverLogger as logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * Whether libi's MCP endpoint is registered with each of the user's agents. Read-only.
 *
 * `?refresh=1` is the Global setup card's Retry: codex is asked again instead of answering from a listing it failed
 * a moment ago, joining a listing already running.
 */
export async function GET(request: Request): Promise<Response> {
  const refresh = new URL(request.url).searchParams.get("refresh") === "1";
  try {
    return NextResponse.json({ agents: await (refresh ? detectLibiRegistration({ refresh: true }) : detectLibiRegistration()) });
  } catch (err) {
    // Best-effort: "could not tell" for both lets the tab render instead of
    // blanking behind React Query's retry.
    logger.warn(
      { tag: "libi-registration", op: "detect_failed", code: (err as NodeJS.ErrnoException)?.code ?? null },
      "libi registration detection failed",
    );
    const agents: LibiRegistrations = { "claude-code": { state: "unknown" }, codex: { state: "unknown" } };
    return NextResponse.json({ agents });
  }
}
