// mcp/tool-error.ts — the one mapping from a thrown error to an MCP tool error result.
import { isStoryboardBusyError, STORYBOARD_BUSY_MESSAGE, STORYBOARD_BUSY_PARTIAL_MESSAGE } from "@/lib/storyboard/lock";

/** Text an agent gets when a storyboard tool timed out on the piece's lock.
 *  The lock is taken before the tool's change is made, so the blocked change
 *  did not land and the call is safe to repeat. */
export const STORYBOARD_BUSY_TOOL_ERROR =
  `${STORYBOARD_BUSY_MESSAGE} Safe to retry: the blocked change was not applied. ` +
  "(For an edit_storyboard_card call with several changes, re-read the card first: earlier changes in the same call may already have landed.)";

/** Text for a busy error from commit_draft / discard_draft: the composition
 *  step already ran before the storyboard step timed out, so the call is NOT
 *  a clean retry (a repeated commit pushes a duplicate history entry). */
export const STORYBOARD_BUSY_PARTIAL_TOOL_ERROR =
  `${STORYBOARD_BUSY_PARTIAL_MESSAGE} Call libi.get_piece_state and compare before retrying: ` +
  "the composition part of this call may already have landed, and repeating it can add a duplicate version-history entry.";

export function makeError(err: unknown) {
  if (isStoryboardBusyError(err)) {
    const body = err.partial
      ? { success: false, error: STORYBOARD_BUSY_PARTIAL_TOOL_ERROR, retryable: false, partial: true }
      : { success: false, error: STORYBOARD_BUSY_TOOL_ERROR, retryable: true };
    return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError: true };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: message }) }],
    isError: true,
  };
}
