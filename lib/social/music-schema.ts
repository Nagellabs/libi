import { z } from "zod/v3";

const soundName = z.string().trim().min(1).max(100).optional();

/** The wire shape of `TargetMusic` (lib/social/music-policy.ts). */
export const targetMusicSchema = z.union([
  z
    .object({
      mode: z.literal("attach"),
      track: z.object({ id: z.string().min(1).max(64), title: z.string().min(1).max(200), artist: z.string().max(200).optional() }),
      musicVolume: z.number().int().min(0).max(100),
      originalVolume: z.number().int().min(0).max(100),
      startMs: z.number().int().nonnegative().optional(),
      endMs: z.number().int().nonnegative().optional(),
      soundName,
    })
    // TikTok's musicSoundStart/End window: an empty or backwards one is a bug.
    .refine((m) => m.startMs === undefined || m.endMs === undefined || m.endMs > m.startMs, {
      message: "endMs must be after startMs",
      path: ["endMs"],
    }),
  z.object({ mode: z.enum(["draft", "include", "strip"]), soundName }),
]);
