import { NextResponse } from "next/server";
import { isWindows } from "@/lib/platform";
import type { ShellFlavor } from "@/lib/terminal/shell-quote";

// This GET touches no request API, no DB, no network, no async fs — nothing
// that would normally stop Next from prerendering it at BUILD time. If it
// were ever prerendered, the answer baked into the response would be the
// BUILD machine's platform, not the one serving the request — every Windows
// user would get "posix" quoting from a server actually spawning PowerShell.
// Same class of bug as the 0.1.4 process.platform outage, by a different
// mechanism: force dynamic so this always runs per-request.
export const dynamic = "force-dynamic";

/**
 * GET /api/terminal/shell-flavor — the quoting flavor the terminal PTY
 * actually runs, decided server-side.
 *
 * The client-side `getShellPlatform()` sniff (`lib/shell/client.ts`) is
 * documented as COSMETIC ONLY — it decides a menu label, never behaviour —
 * because under `npx` it reads the BROWSER's user agent, not the SERVER's
 * OS. The terminal's PTY is spawned by `lib/terminal/pty.ts#resolveShell` on
 * the server, so when libi is served from one machine (WSL, a devcontainer,
 * a forwarded port) and opened in a browser on another, the two disagree.
 * Text pasted into the terminal must be quoted for the shell that is
 * actually listening, so this route mirrors `resolveShell`'s own platform
 * check exactly.
 *
 * `isWindows()`, never `process.platform === "win32"` — see the comment on
 * `resolveShell` and `lib/platform.ts`: Turbopack constant-folds the literal
 * comparison against the BUILD machine, not the one this route runs on.
 */
export async function GET() {
  const flavor: ShellFlavor = isWindows() ? "powershell" : "posix";
  return NextResponse.json({ flavor });
}
