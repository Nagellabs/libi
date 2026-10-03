/**
 * Bundled skills that no longer exist, and where their content went. ONE table: the skill-graph test
 * helper derives its `SKILL_SUCCESSORS` from it, the fork warning below reads it, and the manual's
 * retired-names line is checked against it.
 *
 * `successor` is the bundled skill that absorbed the content, or null when it was folded into tool
 * descriptions and the manual and has no skill of its own. Add a row when a bundled skill folder is
 * removed or merged; never remove one, because a user's copy made before the change names it for as
 * long as that copy exists.
 */
export const RETIRED_SKILLS: Readonly<Record<string, { successor: string | null }>> = {
  "ai-video-models": { successor: "video-generation-craft" },
  "physical-action-video": { successor: "video-generation-craft" },
  "realistic-image-generation": { successor: "video-generation-craft" },
  "voiceover-production": { successor: "video-generation-craft" },
  "ugc-craft": { successor: "ugc-product-video" },
  "using-effects": { successor: "animating-overlays" },
  "using-piece-duplication": { successor: null },
  "using-snapshot-draft": { successor: null },
  "using-asset-folders": { successor: null },
};

export interface RetiredSkillRef {
  name: string;
  /** The bundled skill to use instead; null = folded into the manual and tool descriptions. */
  successor: string | null;
}

/**
 * Retired skill names a body still mentions. A user copy (a fork or a skill the user wrote) is a frozen
 * snapshot, so one made before a skill was merged keeps telling the agent to load a skill that is gone,
 * and the user copy wins the lookup for its own name. This only reports; nothing rewrites the copy.
 */
export function findRetiredSkillRefs(body: string | null | undefined): RetiredSkillRef[] {
  if (!body) return [];
  const out: RetiredSkillRef[] = [];
  for (const [name, { successor }] of Object.entries(RETIRED_SKILLS)) {
    // Whole kebab-case token: `ugc-craft` must not match inside `ugc-craft-2` or `my-ugc-craft`.
    const re = new RegExp(`(?<![\\w-])${name}(?![\\w-])`);
    if (re.test(body)) out.push({ name, successor });
  }
  return out;
}
