import { getCurrentPort } from "@/lib/libi-home";
import type { DetectedMcp } from "@/lib/providers/detect";

/**
 * Read the detector's answer over HTTP, the same way `mcp/notify.ts` talks to
 * the studio. Keeps the codex spawn and the `~/.claude.json` read in ONE
 * process (the Next server), which is also the process that owns the 5 s memo.
 *
 * Never throws: an unreachable studio means "nothing detected", which is the
 * right answer for a tool whose job is to tell the user what to connect.
 */
export async function fetchConnectedProviders(): Promise<DetectedMcp[]> {
  try {
    const r = await fetch(`http://127.0.0.1:${getCurrentPort()}/api/providers`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return [];
    const body = (await r.json()) as { connected?: DetectedMcp[] };
    return body.connected ?? [];
  } catch {
    return [];
  }
}
