/**
 * Tools whose advertised input schema is looser than the one they validate.
 *
 * A nested object schema costs `tools/list` bytes on every session (a client with deferred tools pays them again
 * each time it loads the tool), and for a field that is rarely supplied or that repeats the top level the model gets
 * the same help from one line of text. So these tools REGISTER the loose variant below and the handler runs the
 * call through `parseInFull`, the full schema, before it does anything — same refusals, and the issue names the
 * exact field. The full schemas stay exported from `schemas.ts` for the handlers and their tests.
 * (Merged tools do the same through `widen`, mcp/tools/action-tool.ts.)
 */
import { z } from "zod/v3";
import {
  addKeyframeSchema,
  applyTemplateSchema,
  addStoryboardCardSchema,
  editStoryboardCardSchema,
  exportVideoSchema,
  publishTemplateSchema,
} from "@/mcp/tools/schemas";

const open = z.record(z.unknown());

/** The call's arguments checked against the FULL schema; `error` is the text to refuse with. */
export function parseInFull<S extends z.ZodTypeAny>(
  tool: string,
  full: S,
  raw: unknown,
): { ok: true; data: z.infer<S> } | { ok: false; error: string } {
  const parsed = full.safeParse(raw);
  if (parsed.success) return { ok: true, data: parsed.data };
  const issues = parsed.error.issues.map((i) => `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`).join("; ");
  return { ok: false, error: `${tool}: invalid arguments. ${issues}` };
}

// ── libi.export_video ───────────────────────────────────────────────────────
export const exportVideoFullSchema = z.object(exportVideoSchema);
export const exportVideoAdvertisedSchema = exportVideoFullSchema.extend({
  variants: z
    .array(open)
    .min(1)
    .max(10)
    .optional()
    .describe(
      "1–10 exports in ONE call, e.g. 9:16 and 16:9 cuts (quality 'custom' + customWidth/customHeight) or MP4 + WebM. Each entry takes the top-level fields format, quality, graphicsQuality, customWidth, customHeight, filename, purpose, copyrightedAudio, includeFileIds (it inherits the ones it does not set). Returns at once with { queued: [{ exportId, name, format, width, height }], note }; check libi.list_exports. (A with-song and a without-song cut differ in copyrightedAudio.)",
    ),
});

// ── libi.apply_template ─────────────────────────────────────────────────────
export const applyTemplateAdvertisedSchema = applyTemplateSchema.extend({
  layerOverrides: z
    .record(open)
    .optional()
    .describe(
      "{ \"<layer key>\": { overlay fields } } — update_overlay's fields (rect, color, fontSize, background: null to clear, startTime, …) set on that layer as it is placed, after fit; wins over slotValues. Not: fileId (use slotValues), trim, fontFileId. Unknown fields and a field the layer's kind lacks are refused.",
    ),
});

// ── libi.publish_template ───────────────────────────────────────────────────
export const publishTemplateAdvertisedSchema = publishTemplateSchema.extend({
  exampleVideo: open.describe(
    "Required, exactly one of { fileId } (an existing video file on a piece) | { path } (an absolute mp4/mov path on this machine) | { exportPieceId } (export that piece first; tens of seconds to minutes). It is made NOW (trimmed to 15 s, scaled to ≤ 1280 px, with a poster) and the user reviews exactly that.",
  ),
});

// ── libi.add_keyframe ───────────────────────────────────────────────────────
const keyframeProps = addKeyframeSchema.shape.properties.unwrap();
export const addKeyframeAdvertisedSchema = addKeyframeSchema.extend({
  properties: keyframeProps
    .extend({
      rect: open.optional().describe("{ x, y, width, height } in composition pixels."),
      transform3d: open.optional().describe("The overlay's transform3d fields, passed through."),
    })
    .optional(),
});

/** The fields `properties` can key, straight from the schema (so a new one is named here on its own). */
export const KEYABLE_KEYFRAME_FIELDS: readonly string[] = Object.keys(keyframeProps.shape);

/**
 * `properties` is stripped, not refused, by zod: `{ x: -900 }` parses to `{}`, and the handler can then only
 * say "no properties supplied". When NOTHING keyable is left, this names what is keyable and what was received.
 * `null` when `properties` is absent (key everything), not an object (the full schema refuses it) or keys at
 * least one real field. Reads the RAW arguments, because the parsed ones no longer know what was dropped.
 */
export function keyframePropertiesRefusal(raw: unknown): string | null {
  const props = (raw as { properties?: unknown } | null | undefined)?.properties;
  if (props === undefined || props === null || typeof props !== "object" || Array.isArray(props)) return null;
  const received = Object.keys(props);
  const keyed = received.filter((k) => KEYABLE_KEYFRAME_FIELDS.includes(k) && (props as Record<string, unknown>)[k] !== undefined);
  if (keyed.length > 0) return null;
  const unknown = received.filter((k) => !KEYABLE_KEYFRAME_FIELDS.includes(k));
  const geometry = unknown.filter((k) => ["x", "y", "width", "height"].includes(k));
  return (
    "libi.add_keyframe: no keyable property in `properties`. " +
    `Keyable fields: ${KEYABLE_KEYFRAME_FIELDS.join(", ")} (position is { x, y }, rect is { x, y, width, height }, rotation is in degrees). ` +
    (unknown.length > 0
      ? `Unknown, so ignored: ${unknown.join(", ")}${geometry.length > 0 ? ` (${geometry.join(", ")} go inside \`position\` or \`rect\`, not directly in \`properties\`)` : ""}. `
      : "`properties` was empty. ") +
    "Omit `properties` to key all of them at once."
  );
}

// ── libi.add_storyboard_card / libi.edit_storyboard_card ────────────────────
const addCardFull = z.object(addStoryboardCardSchema);
export const addStoryboardCardAdvertisedSchema = addCardFull.extend({
  card: addCardFull.shape.card.extend({
    blocks: z
      .array(open)
      .optional()
      .describe("Tier-1 blocking boxes the default render unit draws: [{ id, kind: subject|prop|text|inset|bg, label, glyph?, rect: { x, y, w, h } (normalized 0..1), z }]."),
    render: open
      .optional()
      .describe("Render unit ref { kind: satori|svg|canvas, file }; defaults to { kind: \"satori\", file: \"render.jsx\" } with a block-driven body written for you."),
  }),
});
export const editStoryboardCardFullSchema = z.object(editStoryboardCardSchema);
export const editStoryboardCardAdvertisedSchema = editStoryboardCardFullSchema.extend({
  fields: open
    .optional()
    .describe("Scalar edits, the same fields as add_storyboard_card's `card` (title, description, promptFragment, durationSec, role, voiceover, camera); only what you pass changes."),
});
export const addStoryboardCardFullSchema = addCardFull;
