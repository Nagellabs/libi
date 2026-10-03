import type { ToolResult } from "./types";
import type { UpdateMemoriesParams, OverrideInstructionsParams } from "./schemas";
import { appendMemories, writeMemories } from "@/lib/instructions/memories";
import { saveInstructionsOverride } from "@/lib/instructions/override";
import { notify } from "@/mcp/notify";

const APPLIES_TO_NEW_CHATS =
  "Saved. It applies to new chats; this chat keeps running with the instructions it has.";

/** libi.update_memories — consent-gated; caller (the agent) must have asked the user first. */
export async function updateMemories(params: UpdateMemoriesParams): Promise<ToolResult> {
  const mode = params.mode ?? "append";
  try {
    if (mode === "replace") writeMemories(params.content);
    else appendMemories(params.content);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
  // Fire-and-forget. The studio only logs it: nothing is restarted, because
  // `libi.read_manual` renders memories fresh on every call.
  notify.instructionsChanged();
  return { success: true, data: { ok: true, mode, note: APPLIES_TO_NEW_CHATS } };
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
  return { success: true, data: { ok: true, note: APPLIES_TO_NEW_CHATS } };
}
