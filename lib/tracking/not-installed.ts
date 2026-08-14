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
        "for libi-tracking and run the install, then libi.verify_install, then retry.",
      installPlanPath: "mcp/bundled-mcps/plans/libi-tracking.md",
    },
  };
}
