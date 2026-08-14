import { readFileSync } from "node:fs";
import { mcpLogger as logger } from "@/lib/logger";
import type { ScenarioConfig } from "./kb";

/** Read the per-scenario override config the eval harness writes. Unset/invalid → null. */
export function loadScenarioConfig(): ScenarioConfig | null {
  const p = process.env.LIBI_FAKE_FAL_CONFIG;
  if (!p) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as ScenarioConfig;
  } catch (err) {
    logger.warn({ err, path: p, tag: "fake-fal" }, "failed to read LIBI_FAKE_FAL_CONFIG; using defaults");
    return null;
  }
}
