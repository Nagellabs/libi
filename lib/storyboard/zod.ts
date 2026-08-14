import { z } from "zod/v3";

export const blockSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["subject", "prop", "text", "inset", "bg"]),
  glyph: z.string().optional(),
  label: z.string(),
  rect: z.object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    w: z.number().min(0).max(1),
    h: z.number().min(0).max(1),
  }),
  z: z.number(),
});

export const renderUnitRefSchema = z.object({
  kind: z.enum(["satori", "svg", "canvas"]),
  file: z.string().min(1),
});

export const sketchSlotSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["start", "end", "reference"]),
  paramKey: z.string().min(1),
  label: z.string().optional(),
  render: renderUnitRefSchema.optional(),
  imageFileId: z.string().optional(),
});

const genParamValueSchema = z.union([
  z.string(), z.number(), z.boolean(), z.array(z.string()),
]);
export const genSpecSchema = z.object({
  // apiUrl/model may be empty: a keyframeGen synthesized by migrateCardGeneration
  // (from a legacy keyframeFileId) has no known endpoint. Non-empty endpoints are
  // enforced where it matters — the set_storyboard_generation cache gate — and the
  // storyboard_get / REST enrichment skips empty-apiUrl specs.
  apiUrl: z.string(),
  model: z.string(),
  params: z.record(genParamValueSchema),
  editedAt: z.number().optional(),
});
export const generatedClipSchema = z.object({
  id: z.string().min(1),
  fileId: z.string().min(1),
  label: z.string().min(1),
  createdAt: z.number(),
  hidden: z.boolean().optional(),
});
const inheritedRefSchema = z.object({ fromCardId: z.string().min(1) });

export const storyboardCardSchema = z.object({
  id: z.string().min(1),
  order: z.number().int().nonnegative(),
  durationSec: z.number().nonnegative(),
  role: z.string().min(1),
  kind: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  voiceover: z.object({ line: z.string(), voice: z.string().optional() }).optional(),
  reuseFromSource: z
    .object({
      fileId: z.string().min(1),
      startSeconds: z.number().nonnegative(),
      endSeconds: z.number().positive(),
    })
    .optional(),
  sceneId: z.string().optional(),
  sketches: z.array(sketchSlotSchema),
  blocks: z.array(blockSchema).optional(),
  camera: z.object({
    shot: z.enum(["extreme-wide", "wide", "medium", "close", "extreme-close"]),
    motion: z
      .enum(["static", "push-in", "pull-out", "pan-left", "pan-right",
             "tilt-up", "tilt-down", "handheld", "orbit"])
      .optional(),
  }),
  promptFragment: z.string(),
  keyframeFileId: z.string().optional(),
  clipFileId: z.string().optional(),
  stage: z.enum(["schematic", "keyframe", "clip"]),
  approvals: z.object({
    schematic: z.boolean().optional(),
    keyframe: z.boolean().optional(),
    clip: z.boolean().optional(),
  }),
  cost: z
    .object({ keyframeUsd: z.number().optional(), clipUsd: z.number().optional() })
    .optional(),
  characterId: z.string().optional(),
  keyframeGen: genSpecSchema.optional(),
  clipGen: genSpecSchema.optional(),
  clips: z.array(generatedClipSchema).optional(),
  selectedClipId: z.string().optional(),
  inheritedRefs: z.record(inheritedRefSchema).optional(),
});

export const storyboardManifestSchema = z.object({
  version: z.literal(2),
  overview: z.string().optional(),
  cardOrder: z.array(z.string()),
  edges: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
  updatedAt: z.string(),
  budgetUsd: z.number().optional(),
  layout: z.object({ positions: z.record(z.object({ x: z.number(), y: z.number() })) }).optional(),
});

export function parseCard(input: unknown) {
  return storyboardCardSchema.parse(input);
}
export function parseStoryboard(input: unknown) {
  return storyboardManifestSchema.parse(input);
}
