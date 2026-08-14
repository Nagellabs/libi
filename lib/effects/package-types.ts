// lib/effects/package-types.ts
import { z } from "zod";
import type { EffectMeta } from "./types";

const slug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,48}$/, "id must be a lowercase slug");

const paramSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(["number", "enum"]),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  default: z.union([z.number(), z.string()]).optional(),
  options: z.array(z.string()).optional(),
});

export const customEffectManifestSchema = z.object({
  id: slug,
  name: z.string().min(1).max(60),
  family: z.literal("animation"),
  phases: z.array(z.enum(["in", "out", "loop"])).min(1),
  supports: z
    .array(
      z.enum([
        "text",
        "image",
        "video",
        "code",
        "three",
        "tracked",
        "scene",
        "audio",
      ]),
    )
    .min(1),
  params: z.array(paramSchema).default([]),
  defaultDurationMs: z.number().positive().optional(),
});

export type CustomEffectManifest = z.infer<typeof customEffectManifestSchema>;

/** A manifest is structurally an EffectMeta (animation family, no text/audio internal flags). */
export function manifestToMeta(m: CustomEffectManifest): EffectMeta {
  return { ...m, params: m.params, textInternal: false, audioEnvelope: false };
}
