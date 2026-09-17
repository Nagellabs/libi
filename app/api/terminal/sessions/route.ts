import { NextResponse } from "next/server";
import { getTerminalManager } from "@/lib/terminal/instance";
import { TerminalCapacityError } from "@/lib/terminal/manager";
import { DEFAULT_TERMINAL_CLI_ID } from "@/lib/terminal/presets";
import { isSetupSurface, type SetupSurface, type TerminalPurpose } from "@/lib/terminal/types";
import { trackServerEvent } from "@/lib/analytics/server";

/** GET /api/terminal/sessions[?purpose=chat|setup] — list live terminal sessions (newest first). */
export async function GET(request: Request) {
  const purpose: TerminalPurpose =
    new URL(request.url).searchParams.get("purpose") === "setup" ? "setup" : "chat";
  return NextResponse.json({ sessions: getTerminalManager().list(purpose) });
}

/**
 * POST /api/terminal/sessions — spawn a new terminal
 * `{ cliId, initialInput?, purpose?, surface? }`.
 *
 * `initialInput` is typed into the fresh shell but NOT executed (no newline).
 * It exists so a caller that creates a terminal in order to run one command —
 * the setup terminals of the Agents page, the libi MCP tab and the Providers
 * tab — can have that command present the instant the terminal appears,
 * instead of racing the client's mount/connect/snapshot with a paste that gets
 * wiped. See
 * `TerminalManager#create`.
 *
 * `purpose: "setup"` needs a `surface` (`agents | global-setup | providers`); the
 * new terminal replaces that surface's previous one, and it is always the plain
 * shell whatever `cliId` says. Any other `purpose` is a chat terminal.
 */
export async function POST(request: Request) {
  let cliId = DEFAULT_TERMINAL_CLI_ID;
  let initialInput: string | undefined;
  let purpose: TerminalPurpose = "chat";
  let surface: unknown;
  try {
    const body = (await request.json()) as {
      cliId?: string;
      initialInput?: string;
      purpose?: unknown;
      surface?: unknown;
    };
    if (typeof body.cliId === "string" && body.cliId) cliId = body.cliId;
    // Never let a newline in: that would EXECUTE whatever was sent, turning a
    // "show the user this command" affordance into remote execution.
    if (typeof body.initialInput === "string" && body.initialInput) {
      initialInput = body.initialInput.replace(/[\r\n]+/g, " ").slice(0, 4096);
    }
    if (body.purpose === "setup") purpose = "setup";
    surface = body.surface;
  } catch {
    // empty body → default preset
  }
  // A setup terminal shows one held command in a plain shell. Any other preset would type its own
  // launch line (`claude\r`, which runs) ahead of that command.
  if (purpose === "setup") cliId = "shell";

  if (purpose === "setup" && !isSetupSurface(surface)) {
    return NextResponse.json(
      { error: "surface required: agents | global-setup | providers" },
      { status: 400 },
    );
  }

  try {
    const meta = getTerminalManager().create({
      cliId,
      purpose,
      ...(purpose === "setup" ? { surface: surface as SetupSurface } : {}),
      ...(initialInput ? { initialInput } : {}),
    });
    if (purpose === "chat") {
      void trackServerEvent("terminal_session_started", { cli: cliId });
    }
    return NextResponse.json(meta, { status: 201 });
  } catch (err) {
    if (err instanceof TerminalCapacityError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
