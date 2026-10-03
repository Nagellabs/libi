/**
 * Input fields libi still ACCEPTS but no longer ADVERTISES.
 *
 * Each of these is dead weight in `tools/list` (a deprecated alias, a removed
 * option, a field that now means nothing), but cannot simply leave the zod
 * schema: older skills and agent transcripts still send them, and zod strips
 * an unknown key silently — which for `export_video.destFolder` would turn a
 * refusal into a quiet success. So the field stays in the schema, undescribed,
 * and `mcp/tools-list-shape.ts` drops it from the JSON schema the model sees.
 *
 * A merged tool (mcp/tools/action-tool.ts) is keyed by its own name: the helper leaves these
 * out of the flat schema it builds, and the action's original schema still accepts them.
 *
 * (The other legacy inputs are VALUES, handled inside their own schema with a
 * field-level `z.preprocess`: `smoothing: "kalman"` -> `linear`,
 * `libi.effect({ action: "list", kind: "scene" })` -> `video`. A preprocess around a whole
 * tool schema is not an option: the SDK would emit an empty input schema.)
 *
 * `__tests__/unit/mcp/legacy-inputs.test.ts` proves, per entry, that the field
 * is in the zod schema, absent from `tools/list`, and still accepted.
 */
export const LEGACY_INPUT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  /** Refused at runtime (DEST_FOLDER_REFUSAL): exports live in the piece. */
  "libi.export_video": ["destFolder"],
  /** Ignored: only the user publishes, on the Templates page. */
  "libi.publish_template": ["confirm"],
  /** Video scenes are gone; it binds nothing. */
  "libi.audio_add_clip": ["linkedSceneId"],
  /** Singular spelling of `sidechainClipIds`. */
  "libi.audio_duck": ["sidechainClipId"],
  /** Alias of `force`. */
  "libi.music_download_model": ["forceNew"],
  /** Alias of `extensionId` (the canonical key of `target: "extension"`). */
  "libi.show": ["mcpId"],
  /** Alias of `mcpId` (the canonical key of the install flow). */
  "libi.get_install_plan": ["extensionId"],
  "libi.verify_install": ["extensionId"],
};
