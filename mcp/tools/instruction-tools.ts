import type { ToolResult } from "./types";
import type { UpdateMemoriesParams, OverrideInstructionsParams } from "./schemas";
import { appendMemories, writeMemories } from "@/lib/instructions/memories";
import { saveInstructionsOverride } from "@/lib/instructions/override";
import { notify } from "@/mcp/notify";

/** libi.update_memories — consent-gated; caller (the agent) must have asked the user first. */
export async function updateMemories(params: UpdateMemoriesParams): Promise<ToolResult> {
  const mode = params.mode ?? "append";
  try {
    if (mode === "replace") writeMemories(params.content);
    else appendMemories(params.content);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
  // Fire-and-forget — the server regenerates workspaces + kills sessions,
  // including the agent process making this call.
  notify.instructionsChanged();
  return { success: true, data: { ok: true, mode } };
}

/** libi.override_instructions — discouraged last-resort; see tool description. */
export async function overrideInstructions(
  params: OverrideInstructionsParams,
): Promise<ToolResult> {
  try {
    saveInstructionsOverride(params.content);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
  notify.instructionsChanged();
  return { success: true, data: { ok: true } };
}
