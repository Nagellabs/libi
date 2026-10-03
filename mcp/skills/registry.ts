/**
 * The bundled skill folders under mcp/skills/, in seed order. A skill's description and tags are NOT here:
 * its SKILL.md frontmatter is the single source (lib/db/init.ts reads it when it seeds the DB row), so the UI,
 * `libi.skill({ action: "list" })` and the agent's own skill list can never disagree.
 */
export interface BundledSkillRef {
  id: string;
  name: string;
}

const BUNDLED_SKILL_IDS = [
  "ai-asset-generation",
  "ugc-product-video",
  "video-generation-craft",
  "voice-replacement",
  "stitching-multi-clip",
  "using-character-library",
  "audio-analysis",
  "video-analysis",
  "using-storyboard",
  "video-planning",
  "using-object-tracking",
  "removing-and-replacing-backgrounds",
  "music-creation",
  "music-video-creation",
  "mimic-video",
  "mimic-video-captions",
  "generic-video",
  "installing-mcps",
  "animated-text-overlays",
  "animating-overlays",
  "speech-captions",
  "three-overlays",
  "guiding-manual-edits",
  "social-posting",
  "browser-posting",
  "social-music",
  "templates",
  "onboarding-libi-explainer-short",
] as const;

export const BUNDLED_SKILLS: BundledSkillRef[] = BUNDLED_SKILL_IDS.map((id) => ({ id, name: id }));
