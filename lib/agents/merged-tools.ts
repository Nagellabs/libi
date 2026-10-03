/**
 * The merged ("action") tools: one `libi.<noun>` tool whose old verbs became
 * values of a discriminator field (`action`, or `target` / `kind` where that
 * reads better). See `mcp/tools/action-tool.ts` for how one is registered.
 *
 * This table is deliberately DATA ONLY — no server imports — because the chat
 * UI (a client bundle) reads it to label a call (`Libi Keyframe · delete`) and
 * `mcp/analytics.ts` reads it to tag `tool_used`. `registerActionTool` throws
 * when a tool it is given is missing here or names a different discriminator,
 * and `__tests__/unit/mcp/action-tool.test.ts` holds the table to the tools a
 * real server registers, so the two cannot drift.
 */
export const MERGED_TOOL_DISCRIMINATORS = {
  "libi.caption_style": "action",
  "libi.audio_duck": "action",
  "libi.job": "action",
  "libi.keyframe": "action",
  "libi.show": "target",
  "libi.skill": "action",
  "libi.character": "action",
  "libi.catalog_item": "action",
  "libi.template": "action",
  "libi.extension": "action",
  "libi.tracked_overlay": "action",
  "libi.track": "action",
  "libi.analysis_save": "action",
  "libi.analysis_query": "action",
  "libi.analysis_extract": "action",
  "libi.layer_effect": "action",
  "libi.piece_folder": "action",
  "libi.asset_folder": "action",
  "libi.clip": "action",
  "libi.audio_clip": "action",
  "libi.audio_analyze": "action",
  "libi.storyboard_take": "action",
  "libi.model_schema_cache": "action",
  "libi.effect": "action",
  "libi.overlay_preset": "action",
  "libi.snapshot": "action",
  "libi.social_link": "kind",
} as const satisfies Record<string, string>;

export type MergedToolName = keyof typeof MERGED_TOOL_DISCRIMINATORS;

/**
 * What each merged tool's actions DO to the studio, declared as data (never inferred): every action
 * of the tool is in exactly one list. `readOnly` actions only read, or only move the user's screen;
 * `changes` actions write, delete, run or install something.
 *
 * Why it matters: the agent's "don't ask again" choice is remembered per TOOL NAME, not per call
 * (claude-agent-acp writes `{ toolName: "mcp__libi__libi_snapshot" }` with no argument filter; Codex's
 * "Allow for this session" / "Always allow" are keyed on server + tool). Before the merge, "always" on
 * `compare_states` did not cover `discard_draft`; on a merged tool it would. So a tool with ANY
 * `changes` action is never offered the remember-this-choice option (`mergedToolAllowsAlways`) and its
 * every call is asked or auto-allowed ONCE. A tool whose every action is read-only keeps it.
 * `__tests__/unit/mcp/merged-tool-risk.test.ts` holds this table to the actions a real server registers.
 */
export const MERGED_TOOL_RISK = {
  "libi.caption_style": { readOnly: ["list"], changes: ["create", "delete"] },
  "libi.audio_duck": { readOnly: [], changes: ["enable", "update", "disable"] },
  "libi.job": { readOnly: ["list", "status"], changes: ["cancel"] },
  "libi.keyframe": { readOnly: ["list"], changes: ["delete", "set_easing"] },
  // Moves the user's screen and writes nothing.
  "libi.show": {
    readOnly: ["piece", "preview", "asset", "export", "storyboard", "folder", "templates", "extension", "social_settings"],
    changes: [],
  },
  "libi.skill": {
    readOnly: ["list", "diff_override", "list_prompts"],
    changes: ["add", "update", "remove", "fork", "enable", "enable_by_tag", "add_prompt", "update_prompt", "remove_prompt"],
  },
  "libi.character": { readOnly: ["list", "get"], changes: ["create", "update", "delete", "link", "unlink"] },
  "libi.catalog_item": { readOnly: ["list", "get"], changes: ["create", "update", "delete", "link", "unlink"] },
  "libi.template": { readOnly: ["get", "search", "list"], changes: ["update", "delete"] },
  "libi.extension": { readOnly: ["diagnose"], changes: ["recheck", "retry", "restart", "update", "restart_session"] },
  // `libi-tracking` is an extension the user can mark "requires approval" (lib/approval/extensions.ts); a
  // remembered "always" on one of these tools would silence that gate for `compute` too.
  "libi.tracked_overlay": { readOnly: ["verify"], changes: ["add", "update"] },
  "libi.track": {
    readOnly: ["list", "list_segments", "list_candidates"],
    changes: ["compute", "compute_segment", "delete", "update_result", "skip_segment", "ground_target", "pick_candidate"],
  },
  "libi.analysis_save": {
    readOnly: [],
    changes: ["frames", "summary", "summary_custom", "audio_chunk", "audio_chunk_from_file", "step_failed", "remove_step"],
  },
  "libi.analysis_query": { readOnly: ["get", "audio_chunks", "search_frames", "search_transcript"], changes: [] },
  "libi.analysis_extract": { readOnly: [], changes: ["frames", "audio", "chunk_audio"] },
  "libi.layer_effect": { readOnly: [], changes: ["apply", "clear"] },
  "libi.piece_folder": { readOnly: ["list"], changes: ["create", "rename", "move", "delete", "move_piece", "duplicate"] },
  "libi.asset_folder": { readOnly: [], changes: ["create", "rename", "move", "delete", "move_asset"] },
  "libi.clip": { readOnly: [], changes: ["delete", "split", "duplicate", "insert_time"] },
  "libi.audio_clip": { readOnly: [], changes: ["update", "remove", "split", "unlink", "relink_overlay"] },
  // Measures and reads; the measure job writes no piece data (its row is the cache).
  "libi.audio_analyze": { readOnly: ["measure", "report", "align"], changes: [] },
  "libi.storyboard_take": { readOnly: [], changes: ["attach_clip", "attach_keyframe", "select", "hide", "approve_stage"] },
  "libi.model_schema_cache": { readOnly: ["get"], changes: ["save", "invalidate"] },
  "libi.effect": {
    readOnly: ["list", "list_packages"],
    changes: ["add", "update", "remove", "install_from_git"],
  },
  "libi.overlay_preset": { readOnly: ["list"], changes: ["save", "apply", "delete"] },
  "libi.snapshot": { readOnly: ["compare"], changes: ["commit", "discard", "restore"] },
  "libi.social_link": { readOnly: [], changes: ["post", "ad"] },
} as const satisfies Record<MergedToolName, { readOnly: readonly string[]; changes: readonly string[] }>;

/**
 * The per-verb tool each action REPLACED, as the bare name an agent (or a stale skill, or its own
 * memory) still knows it by: `libi.clip` action `split` was `split_clip`. An action with no entry is
 * new (it never was a tool of its own, e.g. `show` target `export`). Data only, like the tables above:
 * `mcp/merged-tool-map.ts` renders it into the manual's index so an agent that looks for a VERB finds
 * the noun, and `__tests__/unit/mcp/merged-tool-map.test.ts` holds it to the real actions and to the
 * registered tool names (a "former" name must not be a live tool). The `libi.` prefix is left off on
 * purpose: the manual-truth test treats every `libi.<name>` in the manual as a claim that it exists.
 */
export const MERGED_TOOL_FORMER_NAMES = {
  "libi.caption_style": { create: "create_caption_style", delete: "delete_caption_style", list: "list_caption_styles" },
  "libi.audio_duck": { disable: "audio_duck_disable", enable: "audio_duck_enable", update: "audio_duck_update" },
  "libi.job": { cancel: "cancel_job", status: "get_job_status", list: "list_jobs" },
  "libi.keyframe": { delete: "delete_keyframe", list: "list_keyframes", set_easing: "set_keyframe_easing" },
  "libi.show": { asset: "show_asset", extension: "show_extension", folder: "show_folder", piece: "show_piece", preview: "show_preview", storyboard: "show_storyboard", templates: "show_templates" },
  "libi.skill": { add: "add_skill", add_prompt: "add_skill_prompt", diff_override: "diff_skill_override", fork: "fork_skill", list_prompts: "list_skill_prompts", list: "list_skills", remove: "remove_skill", remove_prompt: "remove_skill_prompt", enable: "set_skill_enabled", enable_by_tag: "set_skills_enabled_by_tag", update: "update_skill", update_prompt: "update_skill_prompt" },
  "libi.character": { create: "create_character", delete: "delete_character", get: "get_character", link: "link_character_to_asset", list: "list_characters", unlink: "unlink_character_from_asset", update: "update_character" },
  "libi.catalog_item": { create: "create_item", delete: "delete_item", get: "get_item", link: "link_item_to_asset", list: "list_items", unlink: "unlink_item_from_asset", update: "update_item" },
  "libi.template": { delete: "delete_template", get: "get_template", list: "list_templates", search: "search_templates", update: "update_template" },
  "libi.extension": { diagnose: "diagnose_mcp", recheck: "recheck_mcp", restart_session: "restart_acp_session", restart: "restart_mcp_server", retry: "retry_mcp_server", update: "update_mcp_server" },
  "libi.tracked_overlay": { add: "add_tracked_overlay", update: "update_tracked_overlay", verify: "verify_tracked_overlay" },
  "libi.track": { compute: "compute_object_track", compute_segment: "compute_track_segment", delete: "delete_track", ground_target: "ground_target", list_candidates: "list_identity_candidates", list_segments: "list_track_segments", list: "list_tracks", pick_candidate: "pick_candidate", skip_segment: "skip_segment", update_result: "update_track_result" },
  "libi.analysis_save": { step_failed: "analysis_mark_step_failed", remove_step: "analysis_remove_step", audio_chunk: "analysis_save_audio_chunk", audio_chunk_from_file: "analysis_save_audio_chunk_from_file", frames: "analysis_save_frames", summary: "analysis_save_summary", summary_custom: "analysis_update_summary_custom" },
  "libi.analysis_query": { get: "analysis_get", audio_chunks: "analysis_get_audio_chunks", search_frames: "analysis_search_frames", search_transcript: "analysis_search_transcript" },
  "libi.analysis_extract": { chunk_audio: "analysis_chunk_audio", audio: "analysis_extract_audio", frames: "analysis_extract_frames" },
  "libi.layer_effect": { apply: "apply_layer_effect", clear: "clear_layer_effect" },
  "libi.piece_folder": { create: "create_folder", delete: "delete_folder", duplicate: "duplicate_folder", list: "list_folders", move: "move_folder", move_piece: "move_piece_to_folder", rename: "rename_folder" },
  "libi.asset_folder": { create: "create_asset_folder", delete: "delete_asset_folder", move_asset: "move_asset", move: "move_asset_folder", rename: "rename_asset_folder" },
  "libi.clip": { delete: "delete_clip", duplicate: "duplicate_clip", split: "split_clip" },
  "libi.audio_clip": { relink_overlay: "audio_relink_overlay", remove: "audio_remove_clip", split: "audio_split", unlink: "audio_unlink", update: "audio_update_clip" },
  "libi.audio_analyze": {},
  "libi.storyboard_take": { approve_stage: "approve_storyboard_stage", attach_clip: "attach_storyboard_clip", attach_keyframe: "attach_storyboard_keyframe", hide: "hide_storyboard_take", select: "select_storyboard_take" },
  "libi.model_schema_cache": { get: "get_model_schema_cache", invalidate: "invalidate_model_schema_cache", save: "save_model_schema_cache" },
  "libi.effect": { add: "add_effect", install_from_git: "install_effect_from_git", list_packages: "list_effect_packages", list: "list_effects", remove: "remove_effect", update: "update_effect" },
  "libi.overlay_preset": { apply: "apply_overlay_preset", delete: "delete_overlay_preset", list: "list_overlay_presets", save: "save_overlay_preset" },
  "libi.snapshot": { commit: "commit_draft", compare: "compare_states", discard: "discard_draft", restore: "restore_snapshot" },
  "libi.social_link": { ad: "social_link_ad", post: "social_link_post" },
} as const satisfies Record<MergedToolName, Record<string, string>>;

/** Tools that absorbed per-verb tools WITHOUT a discriminator: the old names took the same fields, so
 *  `update_piece` takes `name` and/or `description` in one call. */
export const FOLDED_TOOL_FORMER_NAMES = {
  "libi.update_piece": ["update_piece_name", "update_piece_description"],
} as const satisfies Record<string, readonly string[]>;

/** Whether the agent's "don't ask again" option may be offered for this tool: true for any tool that is
 *  not merged (unchanged behaviour), and for a merged tool only when none of its actions changes anything. */
/** Tools that are not merged but run many different edits under one name, so the remember-this-choice
 *  option is withheld exactly as for a merged tool with changing actions: an "always" granted on one
 *  harmless batch would cover every later one (`libi.apply_ops`: add, remove, retime, duck, delete clips). */
const ALWAYS_WITHHELD_TOOLS: readonly string[] = ["libi.apply_ops"];

export function mergedToolAllowsAlways(toolName: string): boolean {
  if (ALWAYS_WITHHELD_TOOLS.includes(toolName)) return false;
  if (!isMergedToolName(toolName)) return true;
  return MERGED_TOOL_RISK[toolName].changes.length === 0;
}

export function isMergedToolName(name: string): name is MergedToolName {
  return Object.hasOwn(MERGED_TOOL_DISCRIMINATORS, name);
}

/** codex-acp reports an MCP call's `rawInput` as `{ server, tool, arguments }`: the call's own arguments are
 *  the `arguments` object, not the top level. Anything else is the arguments themselves (Claude's shape). */
function unwrapMcpEnvelope(args: unknown): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const rec = args as Record<string, unknown>;
  if (typeof rec.server === "string" && typeof rec.tool === "string" && rec.arguments && typeof rec.arguments === "object") {
    return rec.arguments;
  }
  return args;
}

/** The discriminator VALUE a call to a merged tool carries (`delete`, `export`, …),
 *  or null for a tool that is not merged or a call that sent no string for it.
 *  Shape-bounded (`[a-z_]{1,40}`) so it is always safe to log or send as a param. */
export function mergedToolAction(toolName: string, args: unknown): string | null {
  if (!isMergedToolName(toolName)) return null;
  const callArgs = unwrapMcpEnvelope(args);
  if (!callArgs || typeof callArgs !== "object") return null;
  const value = (callArgs as Record<string, unknown>)[MERGED_TOOL_DISCRIMINATORS[toolName]];
  return typeof value === "string" && /^[a-z_]{1,40}$/.test(value) ? value : null;
}
