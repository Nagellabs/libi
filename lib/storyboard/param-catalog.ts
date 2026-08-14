export type ParamGroup = "Prompting" | "Keyframing" | "References" | "Audio" | "Parameters";

export const GROUP_ORDER: ParamGroup[] = ["Prompting", "Keyframing", "References", "Audio", "Parameters"];

export type CatalogEntry = {
  label: string;
  group: ParamGroup;
  icon?: string;
  order: number;
  /** Closed-list options to fall back to when the cached schema field carries no
   *  `options` of its own. Lets a well-known constrained param (aspect ratio,
   *  duration) render as a <select> even if the agent cached it loosely as
   *  text/number. Schema-provided options always take precedence. */
  fallbackOptions?: (string | number)[];
};

/** Curated prettification for the params we already understand. Pure UI metadata —
 *  does NOT constrain the data model; any param not here still renders generically
 *  by its cached type. Keys mirror the conventional endpoint param names. */
export const KNOWN_PARAMS: Record<string, CatalogEntry> = {
  prompt: { label: "Prompt", group: "Prompting", order: 0 },
  negative_prompt: { label: "Negative prompt", group: "Prompting", order: 1 },
  start_frame: { label: "Start frame", group: "Keyframing", icon: "image", order: 0 },
  end_frame: { label: "End frame", group: "Keyframing", icon: "image", order: 1 },
  reference_images: { label: "Reference images", group: "References", icon: "images", order: 0 },
  reference_video: { label: "Reference video", group: "References", icon: "video", order: 1 },
  audio_ref: { label: "Audio reference", group: "Audio", icon: "music", order: 0 },
  generate_audio: { label: "Native audio", group: "Audio", icon: "volume", order: 1 },
  duration: { label: "Duration", group: "Parameters", order: 0, fallbackOptions: [3, 4, 5, 6, 8, 10] },
  aspect_ratio: { label: "Aspect ratio", group: "Parameters", order: 1, fallbackOptions: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"] },
  resolution: { label: "Resolution", group: "Parameters", order: 2 },
  seed: { label: "Seed", group: "Parameters", order: 3 },
  camera: { label: "Camera", group: "Parameters", order: 4 },
};

export function catalogEntry(key: string): CatalogEntry | undefined {
  return KNOWN_PARAMS[key];
}

/** Parse "W:H" (also accepts "WxH" / "W/H") into a numeric ratio (width /
 *  height). Local + duplicated from `parseAspectRatio` in `render-card.ts`
 *  (deliberately — this module stays import-free, matching its existing
 *  "pure UI metadata" contract) rather than shared, so a change to one
 *  doesn't accidentally affect the other's contract. Returns null when
 *  unparseable. */
function parseRatio(v: string | number): number | null {
  const m = String(v).match(/^\s*(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)\s*$/i);
  if (!m) return null;
  const w = parseFloat(m[1]);
  const h = parseFloat(m[2]);
  if (!(w > 0) || !(h > 0)) return null;
  return w / h;
}

/** Nearest catalog aspect-ratio option (e.g. "9:16") for a composition's
 *  pixel dimensions. Pure + deterministic: compares each candidate's parsed
 *  ratio to `width/height` by absolute difference and returns the closest
 *  (ties keep whichever option appears earlier in `options`). Defaults to
 *  the `aspect_ratio` catalog entry's `fallbackOptions` when no options are
 *  passed, so a caller can also pass a model's own declared `options` to
 *  pick the nearest option that endpoint actually accepts.
 *
 *  Used to DEFAULT a storyboard card's generation `aspect_ratio` to the
 *  piece it will be placed into — never to constrain it. Returns null on
 *  invalid input (non-positive dimensions, or no parseable option). */
export function nearestAspectOption(
  width: number,
  height: number,
  options: (string | number)[] = KNOWN_PARAMS.aspect_ratio.fallbackOptions ?? [],
): string | null {
  if (!(width > 0) || !(height > 0)) return null;
  const target = width / height;
  let best: string | null = null;
  let bestDiff = Infinity;
  for (const opt of options) {
    const ratio = parseRatio(opt);
    if (ratio == null) continue;
    const diff = Math.abs(ratio - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = String(opt);
    }
  }
  return best;
}
