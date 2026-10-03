import {
  commitDraftTool,
  discardDraftTool,
  restoreSnapshotTool,
  compareStatesTool,
} from "@/mcp/tools/snapshot-tools";
import { commitDraftSchema, discardDraftSchema, restoreSnapshotSchema, compareStatesSchema } from "@/mcp/tools/schemas";
import { action, type ActionToolDef } from "@/mcp/tools/action-tool";

export const snapshotTool: ActionToolDef = {
  name: "libi.snapshot",
  description:
    "A piece's draft and committed snapshots (save, undo, go back, revert, what changed): commit the draft, discard it, restore a prior snapshot, or compare snapshot and draft. Actions: commit, discard, restore, compare. The state itself (hasDraft, recentSnapshots) is libi.get_piece_state.",
  props: {
    pieceId: "ID of the piece.",
  },
  actions: {
    commit: action({
      describe:
        "promote the draft to the new committed snapshot (history keeps the last 10). Edits land in the draft on their own; committing is the user's gesture, so ask the user before committing (suggest it after a meaningful chunk of work, as a question) and never commit automatically after edits. Give a one-line `summary`. Refused with \"unvalidated_generated_clips\" while AI-generated clips lack a completed analysis: validate each first (`video-analysis` skill), or pass `acknowledgeUnvalidated: true` only if the user explicitly accepts un-validated clips",
      schema: commitDraftSchema,
      run: (params) => commitDraftTool(params),
    }),
    discard: action({
      describe:
        "drop the draft and return to the snapshot. The draft is kept hidden for 7 days (the result names how to bring it back), but still ASK the user first (say what will be lost) and discard only after the user's explicit confirmation, then `confirm: true`; never set `confirm` on your own. For \"go back\" / \"undo\" on a small or just-started draft; never regenerate from scratch instead",
      schema: discardDraftSchema,
      run: (params) => discardDraftTool(params),
    }),
    restore: action({
      describe:
        "make a prior snapshot (`snapshotId` from get_piece_state's recentSnapshots) current; the current one is archived and the draft is kept hidden for 7 days, so a restore can be undone. The same call with a `rec-` id from `compare`'s `recoverable` brings back a discarded draft. For \"go back\" / \"undo\" after longer work: offer the one or two most recent, then ASK and restore only with the user's explicit confirmation (`confirm: true`, never set on your own); never regenerate from scratch",
      schema: restoreSnapshotSchema,
      run: (params) => restoreSnapshotTool(params),
    }),
    compare: action({
      describe:
        "structured diff (overlays, audio clips: added/removed/changed) of snapshot vs draft: answers \"what changed?\" instead of guessing from chat history; lists `recoverable` drafts a discard or restore set aside",
      schema: compareStatesSchema,
      run: (params) => compareStatesTool(params),
    }),
  },
};
