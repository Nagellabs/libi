/**
 * Every onboarding film libi knows how to build, keyed by version.
 *
 * Shared rather than owned by the job runner, because two callers need it and
 * they are on opposite sides of a hard import boundary: the runner builds the
 * piece, and `mcp/tools/onboarding-tools.ts` derives the description it hands
 * back to the agent. Nothing under `mcp/` may reach into `lib/jobs/*`
 * (AGENTS.md), so the definition cannot be read through the runner — and a
 * second copy of this map is a second answer to "which film is v1?".
 *
 * Definitions are pure data: the overlay draw bodies are strings, so
 * importing this into the MCP stdio child drags in no engine, no ffmpeg, and
 * no database.
 */
import { ONBOARDING_ASSETS_V1 } from "./v1/assets";
import { ONBOARDING_PIECE_V1 } from "./v1";
import type { OnboardingAsset, OnboardingPieceDefinition } from "./types";

export interface OnboardingDefinitionEntry {
  definition: OnboardingPieceDefinition;
  assets: readonly OnboardingAsset[];
}

/** The one version that exists today. Keyed so a v2 is an entry, not a fork. */
export const ONBOARDING_DEFINITIONS: Record<string, OnboardingDefinitionEntry> = {
  v1: { definition: ONBOARDING_PIECE_V1, assets: ONBOARDING_ASSETS_V1 },
};

/** The version a caller that names none should get. */
export const DEFAULT_ONBOARDING_VERSION = "v1";
