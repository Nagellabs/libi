import fs from "node:fs";
import path from "node:path";
import { trackingModelsDir } from "@/lib/tracking/engine-deps";

const TOKEN_MARKER = ".install-token";

/** True when the tracking-pyenv install token marker exists (the cheap
 *  signal the custom installer writes on success). */
export function trackingEngineInstalled(): boolean {
  try {
    return fs.existsSync(path.join(trackingModelsDir(), TOKEN_MARKER));
  } catch {
    return false;
  }
}

export interface TrackingNotInstalled {
  error: "tracking_engine_not_installed";
  data: { hint: string; installPlanPath: string };
}

export function trackingNotInstalledError(): TrackingNotInstalled {
  return {
    error: "tracking_engine_not_installed",
    data: {
      hint:
        "The libi-tracking engine is not installed yet. Call libi.get_install_plan " +
        "(mcpId 'libi-tracking') and follow it — disclose the ~2 GB / ~10-20 min cost and get " +
        "the user's OK, then call libi.install_tracking_engine (it runs the real install " +
        "as a background job), then libi.verify_install, then retry.",
      installPlanPath: "mcp/bundled-mcps/plans/libi-tracking.md",
    },
  };
}

/** A job runner (e.g. `lib/jobs/runners/tracking.ts`, `matte-gen.ts`) throws
 *  the not-installed contract as `JSON.stringify(trackingNotInstalledError())`
 *  wrapped in an Error — that's the only way to cross the MCP-child /
 *  Next-server job boundary (`runJobViaServer`) with structure intact. Every
 *  generic MCP tool catch should run its caught error through this parser
 *  before falling back to `err.message`, so the agent gets the structured
 *  `tracking_engine_not_installed` contract instead of that JSON as a string. */
export function parseTrackingNotInstalled(err: unknown): TrackingNotInstalled | null {
  if (!(err instanceof Error)) return null;
  const message = err.message.trimStart();
  if (!message.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return null;
  }
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    (parsed as { error?: unknown }).error === "tracking_engine_not_installed" &&
    typeof (parsed as { data?: unknown }).data === "object" &&
    (parsed as { data?: unknown }).data !== null
  ) {
    return parsed as TrackingNotInstalled;
  }
  return null;
}
