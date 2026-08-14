import { NextResponse } from "next/server";
import { getTerminalManager } from "@/lib/terminal/instance";
import { TerminalCapacityError } from "@/lib/terminal/manager";
import { DEFAULT_TERMINAL_CLI_ID } from "@/lib/terminal/presets";
import { trackServerEvent } from "@/lib/analytics/server";

/** GET /api/terminal/sessions — list live terminal sessions (newest first). */
export async function GET() {
  return NextResponse.json({ sessions: getTerminalManager().list() });
}

/**
 * POST /api/terminal/sessions — spawn a new terminal `{ cliId, initialInput? }`.
 *
 * `initialInput` is typed into the fresh shell but NOT executed (no newline).
 * It exists so a caller that creates a terminal in order to run one command —
 * the agent sign-in remedies — can have that command present the instant the
 * terminal appears, instead of racing the client's mount/connect/snapshot with
 * a paste that gets wiped. See `TerminalManager#create`.
 */
export async function POST(request: Request) {
  let cliId = DEFAULT_TERMINAL_CLI_ID;
  let initialInput: string | undefined;
  try {
    const body = (await request.json()) as {
      cliId?: string;
      initialInput?: string;
    };
    if (typeof body.cliId === "string" && body.cliId) cliId = body.cliId;
    // Never let a newline in: that would EXECUTE whatever was sent, turning a
    // "show the user this command" affordance into remote execution.
    if (typeof body.initialInput === "string" && body.initialInput) {
      initialInput = body.initialInput.replace(/[\r\n]+/g, " ").slice(0, 4096);
    }
  } catch {
    // empty body → default preset
  }

  try {
    const meta = getTerminalManager().create({ cliId, initialInput });
    void trackServerEvent("terminal_session_started", { cli: cliId });
    return NextResponse.json(meta, { status: 201 });
  } catch (err) {
    if (err instanceof TerminalCapacityError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
