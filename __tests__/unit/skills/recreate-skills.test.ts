import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { BUNDLED_SKILLS } from "../../../mcp/skills/registry";
import { parseSkillBody } from "../../../mcp/skills/frontmatter";

const skillsDir = path.resolve(__dirname, "../../../mcp/skills");
const read = (rel: string) => readFileSync(path.join(skillsDir, rel), "utf8");

describe("ai-video-models extraction", () => {
  const guides = ["model-seedance-2.md", "model-veo-3-1.md", "model-kling.md"];

  it("hosts the 3 engine guides under ai-video-models/prompts", () => {
    for (const g of guides) {
      expect(existsSync(path.join(skillsDir, "ai-video-models/prompts", g))).toBe(true);
    }
  });

  it("removed the 3 engine guides from ugc-product-video/prompts", () => {
    for (const g of guides) {
      expect(existsSync(path.join(skillsDir, "ugc-product-video/prompts", g))).toBe(false);
    }
  });

  it("registers ai-video-models in BUNDLED_SKILLS", () => {
    expect(BUNDLED_SKILLS.some((s) => s.id === "ai-video-models")).toBe(true);
  });

  it("ai-video-models SKILL.md is a reference skill (not a user entry point)", () => {
    const md = read("ai-video-models/SKILL.md");
    expect(md).toMatch(/name:\s*ai-video-models/);
    expect(md).toMatch(/model-seedance-2|Seedance/);
    expect(md).toMatch(/Veo/);
    expect(md).toMatch(/Kling/);
    expect(md).toMatch(/not a standalone entry point/i);
  });
});

describe("ugc-product-video references ai-video-models", () => {
  const md = readFileSync(
    path.resolve(__dirname, "../../../mcp/skills/ugc-product-video/SKILL.md"),
    "utf8",
  );
  it("points model-guide loading at ai-video-models", () => {
    expect(md).toMatch(/ai-video-models/);
  });
  it("no longer links the moved guides via local prompts/ paths", () => {
    expect(md).not.toMatch(/prompts\/model-seedance-2\.md/);
    expect(md).not.toMatch(/prompts\/model-veo-3-1\.md/);
    expect(md).not.toMatch(/prompts\/model-kling\.md/);
  });
});

describe("mimic-video dispatcher", () => {
  const md = readFileSync(
    path.resolve(__dirname, "../../../mcp/skills/mimic-video/SKILL.md"),
    "utf8",
  );
  it("is registered", () => {
    expect(BUNDLED_SKILLS.some((s) => s.id === "mimic-video")).toBe(true);
  });
  it("triggers on recreate/mimic/copy/remake", () => {
    expect(md).toMatch(/when_to_use:[\s\S]*recreate[\s\S]*mimic/i);
  });
  it("routes to all three creation targets and generates nothing itself", () => {
    expect(md).toMatch(/ugc-product-video/);
    expect(md).toMatch(/music-video-creation/);
    expect(md).toMatch(/generic-video/);
    expect(md).toMatch(/generate nothing|do not generate|generates nothing/i);
  });
  it("ensures analysis via video-analysis", () => {
    expect(md).toMatch(/video-analysis/);
  });
});

describe("generic-video creation skill", () => {
  const md = readFileSync(
    path.resolve(__dirname, "../../../mcp/skills/generic-video/SKILL.md"),
    "utf8",
  );
  it("is registered", () => {
    expect(BUNDLED_SKILLS.some((s) => s.id === "generic-video")).toBe(true);
  });
  it("has the explicit intake question set", () => {
    expect(md).toMatch(/fidelity/i);
    expect(md).toMatch(/stitch.*fully-AI|fully-AI.*stitch/i);
    expect(md).toMatch(/duration/i);
    expect(md).toMatch(/voice/i);
  });
  it("references the shared craft + engine guides + mechanics by name", () => {
    expect(md).toMatch(/ugc-craft/);
    expect(md).toMatch(/ai-video-models/);
    expect(md).toMatch(/ai-asset-generation/);
  });
  it("inherits the one-clip / no-fragmentation duration rule", () => {
    expect(md).toMatch(/15s|one[- ]clip|do NOT fragment|not.*fragment/i);
  });
});

describe("ai-asset-generation voice-on default", () => {
  const md = readFileSync(
    path.resolve(__dirname, "../../../mcp/skills/ai-asset-generation/SKILL.md"),
    "utf8",
  );
  it("keeps the native-audio call mechanic (generate_audio=true)", () => {
    expect(md).toMatch(/generate_audio\s*=\s*true/i);
  });
  it("keeps the dialogue<->audio coherence rule", () => {
    expect(md).toMatch(/never write dialogue into a clip you are silenc/i);
  });
  it("delegates audio/voice ORCHESTRATION to voiceover-production", () => {
    expect(md).toMatch(/voiceover-production/);
  });
  it("no longer carries the mute+ElevenLabs escape hatch", () => {
    expect(md).not.toMatch(/fall back to a single ElevenLabs VO across all clips/i);
    expect(md).not.toMatch(/mute the clips,\s*\n?\s*one EL voice/i);
  });
});

describe("realistic-image-generation hardens gpt-image-2 as the image default", () => {
  // The image-realism craft was split OUT of ai-asset-generation into its own skill.
  const md = readFileSync(
    path.resolve(__dirname, "../../../mcp/skills/realistic-image-generation/SKILL.md"),
    "utf8",
  );
  it("makes gpt-image-2 the non-negotiable default", () => {
    expect(md).toMatch(/gpt-image-2`?\s+is the hardened default/i);
  });
  it("forbids recommend_model from downgrading gpt-image-2", () => {
    expect(md).toMatch(/do NOT let[\s\S]{0,40}recommend_model[\s\S]{0,40}downgrade|never to pick a different[\s\S]{0,5}model over it/i);
  });
  it("ai-asset-generation still points at it for realism images", () => {
    const aag = readFileSync(
      path.resolve(__dirname, "../../../mcp/skills/ai-asset-generation/SKILL.md"),
      "utf8",
    );
    expect(aag).toContain("realistic-image-generation");
  });
});

describe("model-seedance-2 reference-token + audio-carry fixes", () => {
  const md = readFileSync(
    path.resolve(__dirname, "../../../mcp/skills/ai-video-models/prompts/model-seedance-2.md"),
    "utf8",
  );
  it("uses the correct @Image1 / @Audio1 token syntax", () => {
    expect(md).toMatch(/@Image1/);
    expect(md).toMatch(/@Audio1/);
  });
  it("scopes reference tokens to the reference-to-video endpoint only", () => {
    expect(md).toMatch(/reference-to-video/);
    expect(md).toMatch(/no token mechanism|NO tokens in a plain|do NOT sprinkle/i);
  });
  it("discourages hard timecodes in beat pacing", () => {
    expect(md).toMatch(/NO hard `?\[00:00\]`? timecodes|do NOT add hard timecodes|not.*hard timecodes/i);
  });
  it("frames the carry as the standard path, not an auto-fallback to a VO", () => {
    expect(md).not.toMatch(/fall back to a single ElevenLabs VO across all clips/i);
    expect(md).toMatch(/standard multi-clip voice path|do not auto-substitute|surface (it )?to the user/i);
  });
});

describe("production-routes splits fully-AI vs source-stitch audio", () => {
  const md = readFileSync(
    path.resolve(__dirname, "../../../mcp/skills/ugc-product-video/prompts/production-routes.md"),
    "utf8",
  );
  it("keeps native audio on fully-AI paths D/E (no mute-by-default)", () => {
    expect(md).toMatch(/Path E is FULLY-AI/i);
    expect(md).toMatch(/keep each clip's \*\*native audio\*\*|Keep native model audio|native audio/i);
  });
  it("points audio policy at the voiceover-production skill", () => {
    expect(md).toMatch(/voiceover-production/);
  });
  it("keeps the Path-C double-audio guard", () => {
    expect(md).toMatch(/audio_remove_clip|doubled[- ]audio|double-audio/i);
  });
});

describe("recreation routing wiring", () => {
  it("video-analysis hands recreation to mimic-video, not a generic t2v dead-end", () => {
    const md = readFileSync(
      path.resolve(__dirname, "../../../mcp/skills/video-analysis/SKILL.md"),
      "utf8",
    );
    expect(md).toMatch(/mimic-video/);
    expect(md).not.toMatch(/Recreation ≠ .*needs \(B\)\. \(A\) can describe shots well enough to feed to a text-to-video model/);
  });
  it("instructions backstop routes recreate/mimic to mimic-video", () => {
    const md = readFileSync(
      path.resolve(__dirname, "../../../mcp/templates/instructions.md"),
      "utf8",
    );
    expect(md).toMatch(/mimic-video/);
  });
});

describe("multi-clip packing rule (no per-shot fragmentation on long/mimic targets)", () => {
  it("ugc-craft says split clips are still packed multi-beat clips, fewest count", () => {
    const md = readFileSync(
      path.resolve(__dirname, "../../../mcp/skills/ugc-craft/SKILL.md"),
      "utf8",
    );
    expect(md).toMatch(/ceil\(target/i);
    expect(md).toMatch(/NOT eight 3–4s clips|never map one source shot to one clip/i);
    expect(md).toMatch(/recreations?\s*\/?\s*mimics?/i);
  });
  it("mimic-video flags clip-count + audio matching in the hand-off", () => {
    const md = readFileSync(
      path.resolve(__dirname, "../../../mcp/skills/mimic-video/SKILL.md"),
      "utf8",
    );
    expect(md).toMatch(/not one clip per source shot|fewest model-max multi-beat clips/i);
    expect(md).toMatch(/reproduce the voice|do NOT default to a\s*\n?\s*silent/i);
  });
});

describe("voiceover-production is the shared audio/voice authority", () => {
  const md = readFileSync(
    path.resolve(__dirname, "../../../mcp/skills/voiceover-production/SKILL.md"),
    "utf8",
  );
  it("is registered in BUNDLED_SKILLS", () => {
    expect(BUNDLED_SKILLS.some((s) => s.id === "voiceover-production")).toBe(true);
  });
  it("is a reference skill loaded BY orchestration skills, not a standalone entry point", () => {
    expect(md).toMatch(/name:\s*voiceover-production/);
    expect(md).toMatch(/not a standalone entry point/i);
  });
  it("mandates native audio on AI clips and forbids muting an AI generation", () => {
    expect(md).toMatch(/generate_audio\s*=\s*true/i);
    expect(md).toMatch(/muting an AI generation is a defect|never mute an AI|do NOT mute/i);
  });
  it("mandates the reference-to-video carry for multi-clip voice, not an auto VO fallback", () => {
    expect(md).toMatch(/reference-to-video/);
    expect(md).toMatch(/@Audio1/);
    expect(md).toMatch(/must attempt|mandator|standard multi-clip voice path/i);
    expect(md).toMatch(/surface (it )?to the user|ask the user|explicit (user )?opt-in/i);
  });
  it("is generation-time only — does NOT own mute+VO or the opt-in voiceover flow", () => {
    // The mute-and-revoice / clone-a-new-voice flow moved to voice-replacement.
    expect(md).not.toMatch(/list_bundled_mcps/);
    expect(md).not.toMatch(/opt-in voiceover flow/i);
    expect(md).not.toMatch(/audio_remove_clip/);
  });
  it("redirects a voice CHANGE on an existing video to the voice-replacement skill", () => {
    expect(md).toMatch(/voice-replacement/);
    expect(md).toMatch(/native audio|@Audio1|carry/i);
  });
});

describe("voice-replacement skill (re-voice an existing video)", () => {
  const md = readFileSync(
    path.resolve(__dirname, "../../../mcp/skills/voice-replacement/SKILL.md"),
    "utf8",
  );
  it("is registered in BUNDLED_SKILLS", () => {
    expect(BUNDLED_SKILLS.some((s) => s.id === "voice-replacement")).toBe(true);
  });
  it("is a STANDALONE entry point with its own trigger (change/replace/re-voice/dub)", () => {
    expect(md).toMatch(/name:\s*voice-replacement/);
    expect(md).toMatch(/standalone entry point/i);
    expect(md).toMatch(/change.*voice|re-?voice|replace.*voice|dub/i);
    expect(md).not.toMatch(/not a standalone entry point/i);
  });
  it("transcribes the target scenes (reuse analysis or audio-analysis) for coverage", () => {
    expect(md).toMatch(/transcri/i);
    expect(md).toMatch(/analysis_get|audio-analysis|Whisper/i);
  });
  it("asks clone vs new voice and recommends the provider by video FORMAT", () => {
    expect(md).toMatch(/clone/i);
    expect(md).toMatch(/new voice/i);
    expect(md).toMatch(/format|genre/i);
    expect(md).toMatch(/UGC/);
    expect(md).toMatch(/ElevenLabs/);
    expect(md).toMatch(/Kokoro/);
    expect(md).toMatch(/narration|explainer|documentary|corporate|educational/i);
    expect(md).toMatch(/ask the user|ASK/i);
  });
  it("routes talking-face sections to the fal.ai lip-sync model and voice-only to mute+VO", () => {
    expect(md).toMatch(/sync-lipsync|fal\.ai.*lip-?sync|lip-?sync.*fal/i);
    expect(md).toMatch(/upload_file_to_fal/);
    expect(md).toMatch(/on[- ]screen|talking-face|speaks? on camera|speaking/i);
    expect(md).toMatch(/b-roll|voice-only|faceless/i);
  });
  it("mutes (enabled:false) the original, never deletes it", () => {
    expect(md).toMatch(/enabled:\s*false/);
    expect(md).toMatch(/MUTE|mute/);
    expect(md).toMatch(/not\s+`?audio_remove_clip`?|never.*delete/i);
  });
  it("sizes each new segment to cover the scene's actual speech (no under-fill)", () => {
    expect(md).toMatch(/cover.*speech|actual.*speech|transcript/i);
    expect(md).toMatch(/guardrail|not the target|under-fill/i);
  });
});

describe("orchestration skills load voiceover-production by name", () => {
  const read = (p: string) =>
    readFileSync(path.resolve(__dirname, "../../../mcp/skills/" + p), "utf8");
  it("ugc-product-video loads it", () => {
    expect(read("ugc-product-video/SKILL.md")).toMatch(/voiceover-production/);
  });
  it("stitching-multi-clip points audio at it", () => {
    expect(read("stitching-multi-clip/SKILL.md")).toMatch(/voiceover-production/);
  });
  it("generic-video loads it", () => {
    expect(read("generic-video/SKILL.md")).toMatch(/voiceover-production/);
  });
  it("mimic-video loads it", () => {
    expect(read("mimic-video/SKILL.md")).toMatch(/voiceover-production/);
  });
});

describe("new skills parse as valid frontmatter", () => {
  for (const id of ["ai-video-models", "mimic-video", "generic-video"]) {
    it(`${id} SKILL.md parses with name + description + tags + when_to_use`, () => {
      const md = readFileSync(
        path.resolve(__dirname, `../../../mcp/skills/${id}/SKILL.md`),
        "utf8",
      );
      const { frontmatter } = parseSkillBody(md);
      expect(frontmatter.name).toBe(id);
      expect(frontmatter.description.length).toBeGreaterThan(0);
      expect(Array.isArray(frontmatter.tags)).toBe(true);
      expect((frontmatter.when_to_use ?? "").length).toBeGreaterThan(0);
    });
  }
});
