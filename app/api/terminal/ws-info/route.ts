import { NextResponse } from "next/server";
import { ensureTerminalWsServer } from "@/lib/terminal/ws-server";

/**
 * GET /api/terminal/ws-info — start (lazily) and report the terminal
 * WebSocket server's loopback port. Clients connect to
 * `ws://127.0.0.1:<port>/?session=<id>`.
 */
export async function GET() {
  try {
    const port = await ensureTerminalWsServer();
    return NextResponse.json({ port });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
