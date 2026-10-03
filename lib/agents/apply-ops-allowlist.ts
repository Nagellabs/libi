/**
 * What `libi.apply_ops` may run, as DATA (no server imports — the manual, the chat and the drift test
 * read it). `apply_ops` runs one op list on many pieces and writes only each piece's DRAFT, so an op
 * belongs here only when ALL of these hold:
 *
 *   - it edits the composition of ONE piece (`pieceId` is its only scope), and nothing else it writes
 *     needs undoing when a later op fails. A failed piece is rolled back by never committing the
 *     in-memory manifest (lib/composition/manifest-transaction.ts); anything an op wrote outside that
 *     manifest — a file row, another store, a job — would survive the rollback;
 *   - it needs no approval, is not the user's alone to decide, spends nothing, and publishes nothing;
 *   - it deletes no file and no piece (a timeline clip or overlay leaving the DRAFT is fine: the
 *     snapshot and the kept-draft safety net cover it).
 *
 * EVERY libi tool (and every action of a merged one) is classified exactly once, here or in
 * `APPLY_OPS_REFUSED`: `__tests__/unit/mcp/apply-ops-allowlist.test.ts` holds this file to the tools a
 * real server registers, so a new tool cannot ship without someone deciding whether a batch may run it.
 */

/** Where an allowed op's writes land. */
export type ApplyOpsEffect =
  /** The piece's composition manifest only: runs against the in-memory draft and commits once. */
  | "manifest"
  /** The piece's database row (name, description): validated up front, run after the manifest commits. */
  | "piece-row";

export interface ApplyOpsAllowance {
  /** The actions a merged tool lets through; absent for a tool that has none. */
  actions?: readonly string[];
  effect: ApplyOpsEffect;
  /** Arguments refused inside a batch, each with the reason shown to the agent. */
  refuseFields?: Readonly<Record<string, string>>;
}

export const APPLY_OPS_ALLOWED: Readonly<Record<string, ApplyOpsAllowance>> = {
  "libi.add_overlay": { effect: "manifest" },
  "libi.update_overlay": { effect: "manifest" },
  "libi.remove_overlay": { effect: "manifest" },
  "libi.reorder_overlays": { effect: "manifest" },
  "libi.add_keyframe": { effect: "manifest" },
  "libi.keyframe": { actions: ["delete", "set_easing"], effect: "manifest" },
  "libi.layer_effect": { actions: ["apply", "clear"], effect: "manifest" },
  "libi.overlay_preset": { actions: ["apply"], effect: "manifest" },
  "libi.clip": { actions: ["delete", "split", "duplicate", "insert_time"], effect: "manifest" },
  "libi.audio_add_clip": {
    effect: "manifest",
    refuseFields: {
      rights:
        "stamping a file's rights (and matching the song on each platform) happens once per file, not per piece: " +
        "call libi.audio_add_clip({ rights }) or libi.set_audio_rights for it outside the batch",
    },
  },
  "libi.audio_clip": { actions: ["update", "remove", "split", "unlink", "relink_overlay"], effect: "manifest" },
  "libi.audio_duck": { actions: ["enable", "update", "disable"], effect: "manifest" },
  "libi.generate_captions": { effect: "manifest" },
  "libi.update_piece": { effect: "piece-row" },
};

/** Why an op is refused inside a batch; the text is what the agent reads. */
export const APPLY_OPS_REFUSAL_REASONS = {
  read: "it only reads: call it on its own (libi.get_composition reads many pieces' timelines)",
  navigation: "it moves the user's screen or flashes a field, which a batch has no business doing",
  global: "it changes something shared across pieces (a style, effect, skill, character, folder or setting), not a piece's draft",
  approval: "it is approval-gated or the user's own decision: call it on its own",
  provider: "it calls a provider or the network, which can cost money: confirm the cost with the user and call it on its own",
  publish: "it publishes or posts: only the user publishes; call it on its own",
  job: "it starts a background job (export, render, download, analysis, install): call it on its own and follow the job",
  file: "it writes a file row or media: call it on its own (apply_ops edits timelines, not assets)",
  delete: "it deletes a file or a piece for good: call it on its own after the user asked for it",
  snapshot: "a batch only writes drafts; saving, discarding and restoring versions are the user's call, one piece at a time",
  storyboard: "the storyboard is its own store with its own lock and no rollback: edit it on its own",
  lifecycle: "it creates, copies or templates a whole piece, which a batch cannot roll back: call it on its own",
  self: "apply_ops does not nest",
} as const;
export type ApplyOpsRefusalReason = keyof typeof APPLY_OPS_REFUSAL_REASONS;

/**
 * Every tool (or `tool:action` of a merged one) a batch refuses, grouped by why. A merged tool with
 * only SOME actions allowed (`libi.keyframe`) lists the rest here as `tool:action`; one with none
 * allowed lists the bare tool name.
 */
export const APPLY_OPS_REFUSED: Readonly<Record<ApplyOpsRefusalReason, readonly string[]>> = {
  read: [
    "libi.get_composition",
    "libi.get_overlays",
    "libi.code_outline",
    "libi.get_piece_state",
    "libi.get_version",
    "libi.get_install_plan",
    "libi.read_manual",
    "libi.list_assets",
    "libi.list_exports",
    "libi.list_files",
    "libi.list_fonts",
    "libi.list_pieces",
    "libi.list_providers",
    "libi.music_list_styles",
    "libi.retrieve_assets_dimensions",
    "libi.sleep",
    "libi.social_status",
    "libi.storyboard_get",
    "libi.tts_list_voices",
    "libi.whisper_list_models",
    "libi.render_overlay_frames",
    "libi.keyframe:list",
    "libi.audio_analyze",
    "libi.overlay_preset:list",
    "libi.analysis_query",
  ],
  navigation: [
    "libi.show",
    "libi.show_in_chat",
    "libi.highlight_property",
    "libi.highlight_effect",
    "libi.set_complexity_mode",
  ],
  global: [
    "libi.caption_style",
    "libi.effect",
    "libi.skill",
    "libi.character",
    "libi.catalog_item",
    "libi.model_schema_cache",
    "libi.piece_folder",
    "libi.asset_folder",
    "libi.overlay_preset:save",
    "libi.overlay_preset:delete",
    "libi.update_composition_dimensions",
    "libi.override_instructions",
    "libi.update_memories",
    "libi.update_dep_status",
  ],
  approval: [
    "libi.extension",
    "libi.template",
    "libi.track",
    "libi.tracked_overlay",
    "libi.remove_background",
    "libi.set_audio_rights",
    "libi.fetch_template_music",
    "libi.suggest_provider",
  ],
  provider: [
    "libi.generate_music",
    "libi.generate_speech",
    "libi.analysis_transcribe_audio",
    "libi.import_remote_files",
    "libi.download_video",
    "libi.music_detect_beats",
    "libi.music_profile",
    "libi.social_music_search",
  ],
  publish: ["libi.post_piece", "libi.publish_template", "libi.social_link"],
  job: [
    "libi.job",
    "libi.export_video",
    "libi.concat_videos",
    "libi.trim_video",
    "libi.extract_audio",
    "libi.generate_thumbnails",
    "libi.regenerate_proxy",
    "libi.drop_proxies",
    "libi.install_tracking_engine",
    "libi.verify_install",
    "libi.whisper_download_model",
    "libi.tts_download_model",
    "libi.music_download_model",
    "libi.music_install_analysis_deps",
    "libi.dev_slow_job",
    "libi.analysis_save",
    "libi.analysis_extract",
    "libi.start_onboarding",
    "libi.build_onboarding_piece",
  ],
  file: [
    "libi.upload_file",
    "libi.upload_font",
    "libi.save_asset",
    "libi.duplicate_file",
    "libi.assign_file",
    "libi.update_file_notes",
  ],
  delete: ["libi.delete_file", "libi.delete_piece"],
  snapshot: ["libi.snapshot"],
  storyboard: [
    "libi.add_storyboard_card",
    "libi.edit_storyboard_card",
    "libi.set_storyboard_generation",
    "libi.set_storyboard_reference",
    "libi.storyboard_take",
  ],
  lifecycle: [
    "libi.create_piece",
    "libi.duplicate_piece",
    "libi.apply_template",
    "libi.create_template_from_piece",
  ],
  self: ["libi.apply_ops"],
};

/** The refusal reason for `tool` (and `action`, for a merged tool), or null when the pair is not refused. */
export function applyOpsRefusal(tool: string, action?: string): ApplyOpsRefusalReason | null {
  for (const [reason, entries] of Object.entries(APPLY_OPS_REFUSED) as [ApplyOpsRefusalReason, readonly string[]][]) {
    if (entries.includes(tool) || (action !== undefined && entries.includes(`${tool}:${action}`))) return reason;
  }
  return null;
}

/** Whether `tool` (+ `action`) may run in a batch. A merged tool must name an allowed action. */
export function applyOpsAllows(tool: string, action?: string): boolean {
  const allowance = APPLY_OPS_ALLOWED[tool];
  if (!allowance) return false;
  if (!allowance.actions) return true;
  return action !== undefined && allowance.actions.includes(action);
}
