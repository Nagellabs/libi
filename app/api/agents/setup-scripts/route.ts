import { NextResponse } from "next/server";
import { missingSetupScripts, setupScriptsDir } from "@/lib/agents/setup/scripts-dir";
import { serverLogger as logger } from "@/lib/logger";

// Never prerendered: a build-time answer would be the BUILD machine's folder,
// not where the install serving this request lives.
export const dynamic = "force-dynamic";

/**
 * GET /api/agents/setup-scripts — the absolute folder of libi's provider setup
 * scripts on the machine that runs the setup terminal. The Providers tab builds
 * its commands in the browser, so it asks here, as it asks
 * `/api/terminal/shell-flavor` for the quoting flavor.
 *
 * A folder missing any script is an error rather than an answer, so no command
 * naming a script that is not there is ever built.
 */
export async function GET() {
  const dir = setupScriptsDir();
  const missing = missingSetupScripts(dir);
  if (missing.length > 0) {
    logger.error({ tag: "providers", op: "setup_scripts_missing", dir, missing }, "providers.setup_scripts_missing");
    return NextResponse.json({ error: "libi's provider setup scripts are missing from this install." }, { status: 500 });
  }
  return NextResponse.json({ dir });
}
