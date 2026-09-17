import { NextResponse } from "next/server";
import { readSetupScript } from "@/lib/agents/setup/scripts-dir";

// Read per request from the install that serves it, never at build time.
export const dynamic = "force-dynamic";

const HEADERS = {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

interface Params {
  params: Promise<{ name: string }>;
}

/**
 * GET /api/agents/setup-scripts/<name> — the text of one provider setup script,
 * for the "View <script>" links beside a setup terminal, so a user can read what
 * the command waiting in it runs.
 *
 * Read-only: it returns a file's text and never runs anything. Only the exact
 * names in `SETUP_SCRIPT_NAMES` are served; any other name (another file, a
 * path, `..` in any encoding) is a 404.
 */
export async function GET(_request: Request, { params }: Params) {
  const { name } = await params;
  const text = readSetupScript(name);
  if (text === null) return new NextResponse("Not found\n", { status: 404, headers: HEADERS });
  return new NextResponse(text, { status: 200, headers: HEADERS });
}
