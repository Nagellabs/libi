import { NextResponse } from "next/server";

import { getMcpHttpChild } from "@/lib/server/lifecycle/category-b";

export const dynamic = "force-dynamic";

/**
 * POST — restart the MCP endpoint's child process (never libi itself). See
 * `McpHttpChildHandle.restart`: 200 `{ ok, port }` once the relaunch is
 * healthy, 503 `{ error }` when there is no child, it is stopped or already
 * restarting, or the relaunch did not come up.
 */
export async function POST() {
  const child = getMcpHttpChild();
  if (!child) {
    return NextResponse.json({ error: "no MCP endpoint process to restart" }, { status: 503 });
  }
  try {
    await child.restart();
    return NextResponse.json({ ok: true, port: child.port });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 503 },
    );
  }
}
