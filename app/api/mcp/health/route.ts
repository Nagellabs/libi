import { NextResponse } from "next/server";

import { getLiveMcpPort, getMcpHttpChild, getRegistrationMcpPort } from "@/lib/server/lifecycle/mcp-http-handle";

export const dynamic = "force-dynamic";

/**
 * Proxies the aggregator's `/healthz`, plus the PARENT's view of the child.
 *
 * `childStatus` is the lifecycle's own view of the child process — `"running"`,
 * `"restarting"` (a user-driven restart is stopping the old child),
 * `"gave-up"` (stopped restarting; the aggregator itself cannot report this,
 * since a process that gave up answers nothing at all — a UI reading only
 * `/healthz` would call that "unreachable", indistinguishable from a restart
 * in flight) or `"stopped"`. `"unknown"` means THIS process has no lifecycle
 * handle to ask at all — e.g. a unit test that imports this route directly,
 * or (before the `globalThis`-keyed slot in `mcp-http-handle.ts`) a Turbopack
 * dev-server request resolving the slot to a different module instance than
 * the one `instrumentation.ts` started the child in.
 *
 * The port is this instance's own (`getLiveMcpPort`), and nothing is proxied
 * while this instance's child is not running: whatever answers on that port
 * then may be another libi instance's aggregator, whose version and session
 * counts would be shown as ours. The same holds while it is running but the
 * answer is not its child's own (`ownsHealthAnswer`): during a crash relaunch
 * the state stays `running` with the child dead, and the published port may
 * already belong to another instance. The token the aggregator echoes for its
 * supervisor is not passed on.
 *
 * `url` is what the Agents page puts in the `mcp add` commands it offers, so
 * while the child is not running it names the port a registration is judged
 * against (`getRegistrationMcpPort`), not the live one. The two differ only
 * after a first launch gave up with nothing published, having moved off a busy
 * default: its fallback port is dead, a restart prefers the default (or the
 * `LIBI_MCP_PORT` pin) again, and a command naming the fallback would write a
 * port into the user's agent config that the registration check immediately
 * calls stale, so Reconnect would never settle. While running, the live port
 * is the one that answers.
 */
export async function GET() {
  const child = getMcpHttpChild();
  const port = getLiveMcpPort();
  const url = `http://127.0.0.1:${port}/mcp`;
  const childStatus = child?.status() ?? "unknown";

  if (child && childStatus !== "running") {
    const registrationUrl = `http://127.0.0.1:${getRegistrationMcpPort()}/mcp`;
    return NextResponse.json(
      { ok: false, url: registrationUrl, childStatus, error: `libi's MCP endpoint is not running (${childStatus})` },
      { status: 503 },
    );
  }

  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(1500),
    });
    const body = (await r.json()) as Record<string, unknown>;
    if (child && !child.ownsHealthAnswer(body)) {
      return NextResponse.json(
        { ok: false, url, childStatus, error: "another process answered on this port" },
        { status: 503 },
      );
    }
    delete body.healthToken;
    return NextResponse.json({ ok: r.ok, url, childStatus, ...body });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        url,
        childStatus,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 503 },
    );
  }
}
