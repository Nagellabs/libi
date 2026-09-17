import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { BUNDLED_SKILLS } from "../../../mcp/skills/registry";
import { parseSkillBody } from "../../../mcp/skills/frontmatter";
import { ENDPOINT_VENDORS } from "../../../scripts/skill-eval/audit-endpoints";
import { MODEL_KB, resolveEndpoint } from "../../../mcp/dev/fake-fal/kb";

const skillsDir = path.resolve(__dirname, "../../../mcp/skills");
const read = (rel: string) => readFileSync(path.join(skillsDir, rel), "utf8");

/** A skill's OWN prose: everything outside the canonical provider gate. The gate lists
 *  every catalog id (`fal`, `elevenlabs`, …) by design, as the reference-file naming
 *  rule, so a whole-file vendor scan is unsatisfiable on a gated skill. Cut to the
 *  gate's LAST line rather than to the next `## `, so prose that sits between the gate
 *  and the first section stays inside the scan. An UNGATED skill is all its own prose,
 *  which is the strongest form and the one `stitching-multi-clip` and
 *  `voiceover-production` rely on.
 *  (This construction was copy-pasted five times, once with the `indexOf` inlined.) */
const GATE_HEADING = "## Provider gate";
const GATE_END_MARKER = "so the chat shows the buttons to connect it.";
function ownProseOf(body: string): string {
  const start = body.indexOf(GATE_HEADING);
  if (start === -1) return body;
  return (
    body.slice(0, start) +
    body.slice(body.indexOf(GATE_END_MARKER, start) + GATE_END_MARKER.length)
  );
}

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
    expect(md).toMatch(/Loaded BY/i);
    expect(md).toMatch(/not a standalone entry point/i);
    // Provider ids and tool names live in the reference, not the guides.
    expect(md).not.toContain("recommend_model");
    expect(md).not.toContain("get_pricing");
  });

  it("ai-video-models SKILL.md still routes to the three engine guides", () => {
    const md = read("ai-video-models/SKILL.md");
    expect(md).toMatch(/## Pick the guide for your chosen model/);
    expect(md).toContain("prompts/model-seedance-2.md");
    expect(md).toContain("prompts/model-veo-3-1.md");
    expect(md).toContain("prompts/model-kling.md");
  });

  it("ai-video-models maps every engine to its fal endpoint ids in one place", () => {
    const ref = read("ai-video-models/references/providers/fal.md");
    expect(ref).toContain("bytedance/seedance-2.0/image-to-video");
    expect(ref).toContain("bytedance/seedance-2.0/reference-to-video");
    expect(ref).toContain("fal-ai/veo3.1/fast/first-last-frame-to-video");
    expect(ref).toContain("fal-ai/kling-video/o1/image-to-video");
    expect(ref).toMatch(/get_model_schema/);
    // Hard rules that moved out of the Seedance guide with the ids — they must not be lost.
    expect(ref).toMatch(/audio alone is rejected/i);
    expect(ref).toMatch(/MP3\/WAV/);
    expect(ref).toMatch(/do NOT invent tier\/segment variants/i);
  });

  it.each(["model-seedance-2", "model-veo-3-1", "model-kling"])(
    "%s keeps prompt grammar and defers ids to the reference",
    (name) => {
      const md = read(`ai-video-models/prompts/${name}.md`);
      expect(md).toContain("references/providers/fal.md");
      expect(md).not.toContain("recommend_model");
      // One place for endpoint ids: no vendor-prefixed id survives in a guide.
      expect(md).not.toMatch(/\b(fal-ai|bytedance|openai)\//);
    },
  );
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
  it("generic-video names no provider tools in its body", () => {
    const md = read("generic-video/SKILL.md");
    expect(md).not.toContain("recommend_model");
    expect(md).not.toContain("get_pricing");
    expect(md).toContain("references/providers/");
  });

  it("generic-video's fal reference points at the shared endpoint table", () => {
    const ref = read("generic-video/references/providers/fal.md");
    expect(ref).toContain("get_model_schema");
    expect(ref).toContain("ai-video-models");
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
  // The image-realism craft was split OUT of ai-asset-generation into its own skill, and
  // the fal model id itself lives in that skill's provider reference — the body is
  // provider-agnostic, so the hardened-default rule is asserted on the reference.
  const readRef = () =>
    readFileSync(
      path.resolve(__dirname, "../../../mcp/skills/realistic-image-generation/references/providers/fal.md"),
      "utf8",
    );
  it("makes gpt-image-2 the non-negotiable default", () => {
    expect(readRef()).toMatch(/gpt-image-2`?\s+is the hardened default/i);
  });
  it("forbids recommend_model from downgrading gpt-image-2", () => {
    expect(readRef()).toMatch(/do NOT let[\s\S]{0,40}recommend_model[\s\S]{0,40}downgrade|never to pick a different[\s\S]{0,5}model over it/i);
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
  it("video-analysis flow (B) runs video-understanding on the agent's own provider and saves through the analysis tools", () => {
    const md = readFileSync(
      path.resolve(__dirname, "../../../mcp/skills/video-analysis/SKILL.md"),
      "utf8",
    );
    expect(md).toMatch(/fal-ai\/video-understanding/);
    expect(md).toMatch(/analysis_save_summary/);
    expect(md).toMatch(/analysis_update_summary_custom\(\{ fileId, path: "caption_spec"/);
    expect(md).not.toMatch(/extra_analysis_model/);
  });
  it("mimic-video-captions says the paid caption analysis runs on the user's provider, not a libi-core tool", () => {
    const md = readFileSync(
      path.resolve(__dirname, "../../../mcp/skills/mimic-video-captions/SKILL.md"),
      "utf8",
    );
    expect(md).toMatch(/runs on YOUR provider/);
    expect(md).toMatch(/fal-ai\/video-understanding/);
    expect(md).toMatch(/\$0\.002 per second/);
    expect(md).toMatch(/even when no source file is loaded yet/);
    expect(md).not.toMatch(/libi-core paid tool/);
    expect(md).not.toMatch(/fal credits/);
  });
  it("video-analysis flow (B) is priced in the user's provider credits and spells out the minimal video_v1 summary", () => {
    const md = readFileSync(
      path.resolve(__dirname, "../../../mcp/skills/video-analysis/SKILL.md"),
      "utf8",
    );
    expect(md).not.toMatch(/Gemini-via-fal/);
    expect(md).not.toMatch(/fal credits/);
    expect(md).toMatch(/Paid \(your provider's credits\)/);
    expect(md).toMatch(/schema_version: "video_v1", overview: .*duration: .*subjects: \[\], sections: \[\], recurring_objects: \[\]/);
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
  it("mandates the reference-conditioned carry for multi-clip voice, not an auto VO fallback", () => {
    // The endpoint NAME moved to references/providers/<id>.md; the body keeps the
    // decision, expressed as the capability any provider may or may not have.
    expect(md).toMatch(/reference-conditioned/);
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
  it("asks clone vs new voice and routes by video FORMAT, to a CAPABILITY", () => {
    expect(md).toMatch(/clone/i);
    expect(md).toMatch(/new voice/i);
    expect(md).toMatch(/format|genre/i);
    expect(md).toMatch(/UGC/);
    // The routing target is a capability ("a hosted expressive voice provider"),
    // not a vendor. This assertion used to be `/ElevenLabs/`, which pinned the one
    // remaining "libi recommends <remote vendor>" claim in any shipped body.
    expect(md).toMatch(/hosted\s+expressive voice provider/);
    expect(md).not.toMatch(/ElevenLabs/);
    // Kokoro stays named: it is libi's OWN extension for this kind, and "free and
    // on-device" is the trade-off the user cannot see.
    expect(md).toMatch(/Kokoro/);
    expect(md).toMatch(/narration|explainer|documentary|corporate|educational/i);
    expect(md).toMatch(/ask the user|ASK/i);
  });
  it("routes talking-face sections to a hosted lip-sync model and voice-only to mute+VO", () => {
    // The endpoint ids moved to references/providers/fal.md; the body keeps
    // the routing decision and the "hosted, no local engine" fact.
    expect(md).toMatch(/lip-?sync/i);
    expect(md).toMatch(/no local\s+lip-?sync engine/i);
    // The local-file-to-provider-CDN rule survived the fal decoupling: the skill
    // must still forbid hand-rolled uploads, now pointing at the provider's own tool.
    expect(md).toMatch(/provider's own upload tool/i);
    expect(md).toMatch(/NEVER.{0,80}provider key/i);
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

describe("removing-and-replacing-backgrounds split: body routes, provider reference carries endpoints", () => {
  const body = read("removing-and-replacing-backgrounds/SKILL.md");
  const refPath = "removing-and-replacing-backgrounds/references/providers/fal.md";

  it("keeps routing in the body and endpoints in the reference", () => {
    const md = body;
    expect(md).toContain("libi.remove_background");
    expect(md).toMatch(/magenta/i); // the pixel-verification discipline
    expect(md).toMatch(/Local resolves FINER HAIR/); // the bake-off finding stays
    expect(md).not.toContain("bria/video/background-removal");
    expect(md).not.toContain("fal-ai/birefnet");
    expect(md).not.toContain("get_pricing");

    const ref = read(refPath);
    expect(ref).toContain("bria/video/background-removal/v3");
    expect(ref).toContain("fal-ai/birefnet");
    expect(ref).toContain("background_color");
    expect(ref).toContain("webm_vp9");
    expect(ref).toMatch(/veed\/video-background-removal/);
  });

  it("body names no vendor-prefixed endpoint id and points at the provider reference", () => {
    expect(body).not.toMatch(/\b(fal-ai|bytedance|openai)\//);
    expect(body).not.toContain("veed/");
    // The routing table and the paid section both send the agent to <id>.md.
    expect(body).toMatch(/\| Video \| Arbitrary object[^\n]*\*\*Paid provider\*\*[^\n]*references\/providers\/<id>\.md/);
    expect(body).toMatch(/\| Photo \| Anything \|[^\n]*\*\*Paid provider\*\*[^\n]*references\/providers\/<id>\.md/);
    expect(body).toMatch(/## Paid provider path \(video fallback \+ all photos\)/);
    expect(body).toMatch(/read it before\s+you call anything/);
    // The local route is still the default and the free one.
    expect(body).toMatch(/\| Video \| Person[^\n]*\*\*Local, free\*\*[^\n]*`libi\.remove_background` \(default\)/);
    expect(body).toMatch(/omitting `background_color` returns a\s+black-matted video with no alpha/);
  });

  it("gate is first and the removal-needs-no-provider sentence follows it", () => {
    const h2s = body.match(/^## .+$/gm) ?? [];
    expect(h2s[0]).toMatch(/^## Provider gate/);
    const gateEnd = body.indexOf("## Route the request");
    const gateText = body.slice(0, gateEnd);
    expect(gateText).toContain(
      "This gate applies only when you must generate a new background; background removal itself is `libi.remove_background`, local and free, and needs no provider.",
    );
  });

  it("reference carries the moved rules verbatim (params, the two traps, cost, upload)", () => {
    const ref = read(refPath);
    expect(ref).toMatch(/^# fal — provider reference for `removing-and-replacing-backgrounds`/m);
    expect(ref).toMatch(/## The paid endpoints/);
    expect(ref).toMatch(/\{ video_url, background_color: "Transparent", output_container_and_codec: "webm_vp9" \}/);
    expect(ref).toMatch(/`background_color` defaults to `Black`/);
    expect(ref).toMatch(/`fal-ai\/birefnet` with `\{ image_url \}`/);
    expect(ref).toMatch(/### Two endpoints NOT to use/);
    expect(ref).toMatch(/Do NOT use `bria\/video\/background-removal` \(the v1 id\)/);
    expect(ref).toMatch(/~33x above v3/);
    expect(ref).toMatch(/~5x v3's price/);
    expect(ref).toMatch(/## Cost[\s\S]*`get_pricing`/);
    expect(ref).toMatch(/## Getting the source uploaded[\s\S]*own upload tool/);
    expect(ref).toMatch(/Never handle a provider key/);
    // Sibling references are cross-referenced by path, not repeated.
    expect(ref).toMatch(/`ai-asset-generation`'s `references\/providers\/fal\.md`/);
  });

  it("frontmatter and registry descriptions are provider-generic", () => {
    const { frontmatter } = parseSkillBody(body);
    expect(frontmatter.description).toContain("with a paid provider fallback for hard video subjects and for photos");
    expect(frontmatter.description).not.toMatch(/bria|birefnet/i);
    const entry = BUNDLED_SKILLS.find((s) => s.id === "removing-and-replacing-backgrounds");
    expect(entry?.description).toContain("with a paid provider fallback for hard video subjects and for photos");
    expect(entry?.description).not.toMatch(/bria|birefnet|paid fal/i);
  });
});

describe("voice-replacement split — the two-reference pattern", () => {
  const body = read("voice-replacement/SKILL.md");
  const falRef = "voice-replacement/references/providers/fal.md";
  const elRef = "voice-replacement/references/providers/elevenlabs.md";

  it("voice-replacement keeps the decision flow and defers providers", () => {
    const md = body;
    expect(md).toMatch(/Clone the existing speaker's voice, or use a new voice\?/);
    // (`/s` from the brief is not available at this tsconfig target — `[\s\S]` is the same.)
    expect(md).toMatch(/audio_update_clip[\s\S]*enabled\s*:\s*false/); // mute, never delete
    expect(md).toMatch(/cover.{0,40}speech/i); // coverage rule
    expect(md).not.toContain("fal-ai/sync-lipsync");
    expect(md).not.toContain("voice_clone");
    expect(md).not.toContain("libi.list_bundled_mcps");
  });

  it("voice-replacement ships a fal reference for lip-sync and an elevenlabs one for voices", () => {
    const fal = read(falRef);
    expect(fal).toContain("fal-ai/sync-lipsync/v2");
    expect(fal).toContain("fal-ai/latentsync");
    const el = read(elRef);
    expect(el).toContain("voice_clone");
    expect(el).toContain("text_to_speech");
  });

  it("body names no vendor-prefixed endpoint id and points at the provider references", () => {
    expect(body).not.toMatch(/\b(fal-ai|bytedance|openai|bria|veed)\//);
    // Both routing sections send the agent to <id>.md rather than naming an id.
    expect(body).toMatch(/cloning tool — `references\/providers\/<id>\.md` names\s+it/);
    expect(body).toMatch(
      /Run the lip-sync endpoint your provider reference names\s+\(`references\/providers\/<id>\.md`/,
    );
    // "fal" survives only as a provider NAME nowhere in the body — the lip-sync
    // host is described generically.
    expect(body).not.toMatch(/fal\.ai/);
    expect(body).not.toMatch(/`fal-ai` MCP/);
  });

  it("keeps the decisions that must not move: clone-vs-new, format routing, the cost gate", () => {
    // The ASK and the format→character mapping stay in the body.
    expect(body).toMatch(/\*\*Ask the user:\*\* \*"Clone the existing speaker's voice, or use a new voice\?"\*/);
    expect(body).toMatch(/libi's local Kokoro\s+cannot/);
    expect(body).toMatch(/≤15 s sample/);
    expect(body).toMatch(/UGC \/ influencer \/ talking-head testimonial \/ authentic social/);
    expect(body).toMatch(/hosted\s+expressive voice provider\*\*/);
    expect(body).toMatch(/local Kokoro is a great free default\*\* \(`libi\.generate_speech`, on-device, no key\)/);
    expect(body).toMatch(/\*\*Cost \+ provider gating:\*\*/);
    expect(body).toMatch(/libi\.suggest_provider\(\{ kind: "voice" \}\)/);
    expect(body).toMatch(/libi\.suggest_provider\(\{ kind: "video", reason: "lip-sync" \}\)/);
    expect(body).toMatch(
      /don't force a paid voice onto a plain narration, and don't push Kokoro onto a UGC\s+talking-head/,
    );
    // Step 4a keeps the disclosure + the asset-option mechanics.
    expect(body).toMatch(/DISCLOSE the lips won't match the new voice/);
    expect(body).toMatch(/PAID — disclose the cost \(~\$ per minute of video\) and get\s+approval first/);
    expect(body).toMatch(/libi\.set_default_option/);
    // The verify checklist and the NOT-own section are provider-agnostic.
    expect(body).toMatch(
      /Talking-face scenes: lip-synced on the hosted model \(or the no-provider fallback disclosure was made\)\./,
    );
    expect(body).toMatch(
      /The lip-sync MODEL is hosted — reached through your own provider MCP, endpoint named in\s+`references\/providers\/<id>\.md`\. There is no local lip-sync engine\./,
    );
  });

  it("the provider gate stays first and is not duplicated", () => {
    const h2s = body.match(/^## .+$/gm) ?? [];
    expect(h2s[0]).toMatch(/^## Provider gate/);
    expect(body.match(/## Provider gate — read this first/g)?.length).toBe(1);
  });

  /** This was the last shipped body naming a REMOTE vendor, and it named it in the
   *  exact form removed from `music-creation` and forbidden by `audio-analysis`'s
   *  reference guard ("the provider libi recommends" — the claim class commit
   *  `6aa6278a` stripped out). It is unbacked: `PROVIDER_CATALOG` carries no
   *  "recommended" flag for any remote provider. The routing that matters —
   *  format/genre → hosted-expressive vs local Kokoro — is a CAPABILITY decision and
   *  stays; the vendor name does not. libi's own extensions (Kokoro, Whisper) are named
   *  freely: they ARE libi's providers for their kind, which is why the scan is for the
   *  remote vendor only. */
  it("names no remote vendor outside the gate, and recommends none anywhere", () => {
    const prose = ownProseOf(body);
    expect(prose).not.toMatch(/elevenlabs/i);
    expect(prose).not.toMatch(/fal-ai|fal\.ai|\bfal\b/i);
    for (const file of [body, read(falRef), read(elRef)]) {
      expect(file).not.toMatch(/the (one )?libi recommends/i);
      expect(file).not.toMatch(/the (transcription |voice )?provider libi recommends/i);
    }
    // Guard the guard: the slice is everything either side of the gate and still holds
    // the format→capability routing the claim was embedded in.
    expect(prose).toMatch(/^# Voice Replacement/m);
    expect(prose).toMatch(/UGC \/ influencer \/ talking-head testimonial \/ authentic social/);
    expect(prose).not.toMatch(/## Provider gate/);
  });

  it("the fal reference carries the lip-sync rules verbatim and cross-references the shared mechanics", () => {
    const ref = read(falRef);
    expect(ref).toMatch(/^# fal — provider reference for `voice-replacement`/m);
    expect(ref).toMatch(/## Lip-sync/);
    expect(ref).toMatch(/libi has no local lip-sync engine — the hosted model is the quality path\./);
    expect(ref).toMatch(/\*\*Default: `fal-ai\/sync-lipsync\/v2`\*\* \(sync\.so Lipsync 2 — studio-grade, frame-accurate\)\./);
    expect(ref).toMatch(/\*\*Cheaper alternative: `fal-ai\/latentsync`\*\* \(open-source\)\./);
    expect(ref).toMatch(/`run_model` \/ `submit_job`/);
    expect(ref).toMatch(/PAID — disclose the cost \(~\$ per minute of video\) and get approval first\./);
    expect(ref).toMatch(/NEVER read `FAL_KEY` or `curl` fal storage\s+yourself/);
    // Sibling references are cross-referenced by path, not repeated.
    expect(ref).toMatch(/`ai-asset-generation`'s `references\/providers\/fal\.md`/);
  });

  it("the elevenlabs reference owns cloning + voice picking and says whose MCP it is", () => {
    const ref = read(elRef);
    expect(ref).toMatch(/^# ElevenLabs — provider reference for `voice-replacement`/m);
    expect(ref).toMatch(/the user's own ElevenLabs\s+MCP\*\* — libi does not bundle or configure it\./);
    expect(ref).toMatch(/## Cloning/);
    expect(ref).toMatch(/\*\*`voice_clone`\*\* — the only way to clone the original speaker\./);
    expect(ref).toMatch(/`libi\.extract_audio`/);
    expect(ref).toMatch(/using-character-library/);
    expect(ref).toMatch(/## Picking a voice/);
    expect(ref).toMatch(/\*\*`list_voices`\*\* to browse, \*\*`text_to_speech`\*\* to generate each segment\./);
    expect(ref).toMatch(/## Cost/);
    expect(ref).toMatch(/`libi\.generate_speech`, free, on-device/);
    expect(ref).toMatch(/Kokoro reads as flat on a UGC talking-head\./);
    // No libi-supplies-ElevenLabs implication anywhere.
    expect(ref).not.toMatch(/libi (bundles|provides|supplies|configures) ElevenLabs/i);
    // Sibling references are cross-referenced by path, not repeated.
    expect(ref).toMatch(/`ai-asset-generation`'s `references\/providers\/fal\.md`/);
  });

  it("frontmatter and registry descriptions stay provider-generic", () => {
    const { frontmatter } = parseSkillBody(body);
    expect(frontmatter.description).not.toMatch(/fal|elevenlabs|kokoro|sync-lipsync/i);
    const entry = BUNDLED_SKILLS.find((s) => s.id === "voice-replacement");
    expect(entry?.description).not.toMatch(/fal|elevenlabs|kokoro|sync-lipsync/i);
  });
});

/** Cross-file guards the per-skill provider-reference splits above cannot catch,
 *  because each of those pins one file at a time. */
describe("provider references — cross-file guards", () => {
  const providerRefs = (): { skill: string; provider: string; text: string }[] => {
    const out: { skill: string; provider: string; text: string }[] = [];
    for (const skill of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!skill.isDirectory()) continue;
      const dir = path.join(skillsDir, skill.name, "references", "providers");
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".md")) continue;
        out.push({
          skill: skill.name,
          provider: f.replace(/\.md$/, ""),
          text: readFileSync(path.join(dir, f), "utf8"),
        });
      }
    }
    return out;
  };

  it("finds the provider references at all (guards below are not vacuous)", () => {
    expect(providerRefs().length).toBeGreaterThanOrEqual(8);
  });

  /** Cosmetic-but-greppable: `ai-video-models`' H1 was the one outlier that did not
   *  name its owning skill, so `grep "provider reference for"` missed it. */
  it("every provider reference H1 names its provider and its owning skill", () => {
    for (const { skill, provider, text } of providerRefs()) {
      const h1 = text.split("\n")[0];
      expect(h1.toLowerCase(), `${skill}/${provider}.md H1`).toBe(
        `# ${provider} — provider reference for \`${skill}\``.toLowerCase(),
      );
    }
  });

  /** Section naming was half-and-half ("## The escalation ladder on fal" beside
   *  "## Timestamp brackets"). The H1 already says which provider the file is, so the
   *  suffix is redundant everywhere — the convention is: never repeat it in an H2. */
  it("no section heading repeats the provider name the H1 already carries", () => {
    for (const { skill, provider, text } of providerRefs()) {
      const headings = text.split("\n").filter((l) => l.startsWith("## "));
      expect(headings.length, `${skill}/${provider}.md has no sections`).toBeGreaterThan(0);
      for (const h of headings) {
        expect(
          h.toLowerCase().includes(provider.toLowerCase()),
          `${skill}/${provider}.md: "${h}" repeats the provider name from the H1`,
        ).toBe(false);
      }
    }
  });

  /** Every vendor-prefixed endpoint id in every provider reference, as an EXACT token
   *  set per file. Exact matters: `openai/gpt-image-2` is a prefix of
   *  `openai/gpt-image-2/edit`, so a `toContain` check cannot tell the two apart. */
  const idsByRef = (): { skill: string; provider: string; ids: Set<string> }[] => {
    const re = new RegExp(`\\\`((?:${ENDPOINT_VENDORS.join("|")})/[a-zA-Z0-9/_.-]+)\\\``, "g");
    return providerRefs().map(({ skill, provider, text }) => ({
      skill,
      provider,
      ids: new Set([...text.matchAll(re)].map((m) => m[1])),
    }));
  };

  /** The ids that live in MORE THAN ONE reference, derived from the files. */
  const duplicatedIds = (): Map<string, string[]> => {
    const homes = new Map<string, string[]>();
    for (const { skill, ids } of idsByRef()) {
      for (const id of ids) homes.set(id, [...(homes.get(id) ?? []), skill]);
    }
    return new Map([...homes].filter(([, skills]) => skills.length > 1));
  };

  /** Duplication is the standing maintenance risk of the split: the same endpoint id
   *  lives in several references, each pinned only by its OWN file's guard, so
   *  correcting one would not fail the others. This table is the cross-file pin —
   *  change an id and every listed file has to change with it.
   *
   *  The hand-written version of this table missed three duplicated ids, so the
   *  guard below no longer trusts it — `duplicatedIds()` is derived from the files and
   *  the coverage test asserts the two agree in BOTH directions. A new duplicate, or a
   *  new home for an id already listed, fails here until it is written down. */
  const SHARED_IDS: { fact: string; id: string; skills: string[] }[] = [
    {
      fact: "the default first-last-frame endpoint",
      id: "fal-ai/veo3.1/fast/first-last-frame-to-video",
      skills: ["ai-video-models", "physical-action-video"],
    },
    {
      fact: "Kling's FLF surface",
      id: "fal-ai/kling-video/o1/image-to-video",
      skills: ["ai-video-models", "physical-action-video"],
    },
    {
      fact: "Wan's FLF endpoint",
      id: "fal-ai/wan-flf2v",
      skills: ["ai-video-models", "physical-action-video"],
    },
    {
      fact: "Seedance's i2v endpoint (FLF via the end_image_url param)",
      id: "bytedance/seedance-2.0/image-to-video",
      skills: [
        "ai-asset-generation",
        "ai-video-models",
        "physical-action-video",
        "ugc-product-video",
        "using-storyboard",
      ],
    },
    {
      // Three references carried this id with nothing pinning them to each other,
      // which is the same gap the entries above close for the i2v endpoint.
      fact: "Seedance's reference-conditioned endpoint (the @Audio1 / @Image1 carry)",
      id: "bytedance/seedance-2.0/reference-to-video",
      skills: ["ai-video-models", "ugc-product-video", "using-storyboard"],
    },
    {
      fact: "the masked-edit / composition-reference image endpoint",
      id: "openai/gpt-image-2/edit",
      skills: ["realistic-image-generation", "using-storyboard"],
    },
    {
      // The one that matters most: this is the hardened realism DEFAULT
      // (`realistic-image-generation` declares it non-negotiable), and three other
      // references name it. A correction that reached only one file would leave the
      // other three recommending a superseded model.
      fact: "the realism image default",
      id: "openai/gpt-image-2",
      skills: [
        "ai-asset-generation",
        "ai-video-models",
        "physical-action-video",
        "realistic-image-generation",
      ],
    },
    {
      // `ugc-product-video`'s route table restates this as a route's endpoint
      // rather than pointing at `ai-video-models`, so it is a real second copy.
      fact: "Veo's cheap i2v tier",
      id: "fal-ai/veo3.1/fast/image-to-video",
      skills: ["ai-video-models", "ugc-product-video"],
    },
    {
      // The sharpest of the three: `ugc-product-video` calls this one "the
      // proven path" in a fallback instruction, so a stale copy is a stale
      // recommendation, not just a stale id.
      fact: "the extend-capable endpoint",
      id: "fal-ai/veo3.1/fast/extend-video",
      skills: ["ai-video-models", "ugc-product-video"],
    },
  ];

  for (const { fact, id, skills } of SHARED_IDS) {
    it(`every reference that owns "${fact}" agrees on ${id}`, () => {
      const refs = idsByRef().filter((r) => r.provider === "fal");
      for (const skill of skills) {
        const ref = refs.find((r) => r.skill === skill);
        expect(ref, `${skill} has no fal reference`).toBeDefined();
        expect([...ref!.ids], `${skill}'s fal reference lost ${id}`).toContain(id);
      }
    });
  }

  /** The table above is only as good as the last person to update it; the review
   *  that found this had to enumerate the ids by hand to notice three were missing.
   *  Derive the duplicate set instead and assert the table matches it exactly, so the
   *  table cannot go stale in either direction. */
  it("the duplication table lists exactly the ids that live in more than one reference", () => {
    const derived = duplicatedIds();
    expect([...derived.keys()].sort()).toEqual(SHARED_IDS.map((s) => s.id).sort());
    for (const { id, skills } of SHARED_IDS) {
      expect([...(derived.get(id) ?? [])].sort(), `${id}'s homes moved`).toEqual(
        [...skills].sort(),
      );
    }
  });

  /** Two references opened by saying the shared mechanics "(`run_model` /
   *  `submit_job` / `check_job`, …) are `ai-asset-generation`'s … and are not repeated
   *  here" and then repeated exactly those tool names two lines later. Harmless
   *  mechanically, but this is agent-facing prose whose credibility is the whole point of
   *  a hand-off. A file may claim a token is not repeated here only if it really is not. */
  it("no provider reference promises a token is 'not repeated here' and then repeats it", () => {
    const offenders: string[] = [];
    for (const { skill, provider, text } of providerRefs()) {
      const paras = text.split(/\n\s*\n/);
      const i = paras.findIndex((para) => para.includes("not repeated here"));
      if (i === -1) continue;
      // Everything the CLAIM paragraph names, minus path hand-offs (a pointer at another
      // file is the whole point of the sentence).
      const rest = paras.slice(i + 1).join("\n");
      for (const tok of paras[i].match(/`[a-zA-Z_][a-zA-Z0-9_.]*`/g) ?? []) {
        const bare = tok.slice(1, -1);
        if (bare.includes("/") || bare.endsWith(".md")) continue;
        if (rest.includes(bare)) offenders.push(`${skill}/${provider}.md → ${bare}`);
      }
    }
    expect(
      offenders,
      `these say a token is not repeated here, and repeat it:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  /** The FLF default must have exactly ONE spelling across the whole set — this is what
   *  catches "one file was updated to a new endpoint and the others were not".
   *  `ugc-product-video` deliberately holds a pointer instead of a third copy. */
  it("only one first-last-frame endpoint id exists across all provider references", () => {
    const flf = new Set<string>();
    for (const { text } of providerRefs()) {
      for (const m of text.matchAll(/`([a-zA-Z0-9-]+\/[a-zA-Z0-9/_.-]*first-last-frame[a-zA-Z0-9/_.-]*)`/g)) {
        flf.add(m[1]);
      }
    }
    expect([...flf].sort()).toEqual(["fal-ai/veo3.1/fast/first-last-frame-to-video"]);
  });
});

/** `ugc-craft` is the terminus of the provider-agnostic clip-duration chain:
 *  `stitching-multi-clip` and `ugc-product-video` both defer the per-clip cap to it BY
 *  NAME, so the constraint an agent finally reads was still "Seedance 2.0 — the default"
 *  and a hardcoded 15s. The plan doc classified this skill as having "no provider text",
 *  which is why no task in the wave was pointed at it — that row is corrected too.
 *
 *  Its own header already promised what it now delivers: "This is the model-agnostic
 *  knowledge … the model file owns the numeric caps + param specifics; this file owns the
 *  craft." A whole-file scan is available for the same reason `stitching-multi-clip` gets
 *  one: the skill is ungated, spends $0 and is loaded only by skills that have already
 *  gated. */
describe("ugc-craft — the craft terminus names no model", () => {
  const body = read("ugc-craft/SKILL.md");
  const { frontmatter } = parseSkillBody(body);

  it("names no vendor, model or endpoint id anywhere in the file", () => {
    for (const v of [
      "seedance",
      "veo",
      "kling",
      "wan",
      "lucy",
      "elevenlabs",
      "higgsfield",
      "ace-step",
      "kokoro",
    ]) {
      expect(body, `ugc-craft names ${v}`).not.toMatch(new RegExp(`\\b${v}\\b`, "i"));
    }
    expect(body).not.toMatch(/\bfal\b/i);
    expect(
      body,
      "ugc-craft names a vendor endpoint id",
    ).not.toMatch(new RegExp(`\\b(?:${ENDPOINT_VENDORS.join("|")})/[a-zA-Z0-9/_.-]+`));
    expect(frontmatter.description).not.toMatch(/seedance|veo|kling|elevenlabs|\bfal\b/i);
  });

  /** The craft must survive the scrub — the negatives above are broad, and the headline
   *  rule is the whole reason `stitching-multi-clip` points here. */
  it("keeps the clip-duration methodology, sourcing the cap from the model", () => {
    expect(body).toMatch(/^## Clip-duration methodology/m);
    expect(body).toMatch(/default to ONE full-length multi-beat clip/);
    expect(body).toMatch(/native multi-beat model/i);
    expect(body).toMatch(/the model's own per-clip max/);
    expect(body).toMatch(/`ai-video-models`/);
    expect(body).toMatch(/2\.5 words\/second/);
    expect(body).toMatch(/Rebut the drift myth/);
  });

  /** It is ungated for the same reason `stitching-multi-clip` is: it generates nothing
   *  and is loaded only by entry points that have already gated. */
  it("is ungated and ships no provider reference — and must stay that way", () => {
    expect(body).not.toContain("## Provider gate");
    expect(body).not.toContain("libi.suggest_provider");
    expect(existsSync(path.join(skillsDir, "ugc-craft/references"))).toBe(false);
  });

  /** The pointer that made this a real gap rather than a cosmetic one: the two skills
   *  that defer the cap here must still name it, or the chain has no terminus at all. */
  it("the skills that defer the clip cap to it still name it", () => {
    for (const rel of ["stitching-multi-clip/SKILL.md", "ugc-product-video/SKILL.md"]) {
      expect(read(rel), `${rel} stopped naming ugc-craft`).toContain("ugc-craft");
    }
  });
});

/** `voiceover-production` rule 1 says "every clip on a model with native audio
 *  (`ai-video-models` names which engines have it)" — a pointer that only resolved after
 *  opening the right per-engine guide, because the fal reference listed endpoints and not
 *  the capability. One line per engine block makes the pointer as actionable as the
 *  "(Seedance 2.0, Veo 3.1)" list it replaced. */
describe("ai-video-models answers the native-audio question its pointers ask", () => {
  it("every engine block states whether the engine has native audio", () => {
    const ref = read("ai-video-models/references/providers/fal.md");
    const engines = ref
      .split("\n")
      .filter((l) => l.startsWith("## "))
      .map((l) => l.slice(3).trim());
    for (const engine of ["Seedance 2.0", "Veo 3.1", "Kling"]) {
      expect(engines, `${engine} is no longer an engine section`).toContain(engine);
      const start = ref.indexOf(`## ${engine}`);
      const rest = ref.slice(start);
      const end = rest.indexOf("\n## ", 1);
      const block = end === -1 ? rest : rest.slice(0, end);
      expect(block, `${engine} does not say whether it has native audio`).toMatch(
        /\*\*Native audio: (YES|NO)\*\*/,
      );
    }
    expect(read("voiceover-production/SKILL.md")).toMatch(
      /`ai-video-models` names which engines have\s+it/,
    );
  });
});

/** Six pointers at the provider reference and, across four scenario runs, the agent
 *  never opened it — every concrete model id in this skill lives there and nowhere
 *  else, so an unread reference means an invented endpoint. An earlier fix showed an
 *  IMPERATIVE read as its own gate step is what actually gets it opened. */
describe("physical-action-video — the reference is read, not merely pointed at", () => {
  const body = read("physical-action-video/SKILL.md");

  it("the gate carries an imperative read step for the provider reference", () => {
    expect(body).toMatch(
      /3\. \*\*Read `references\/providers\/<id>\.md` under this skill BEFORE your first provider\s+call\.\*\*/,
    );
    // It sits with the gate, after the gate's own last line — so it is inside every
    // `ownProse` vendor scan and cannot be mistaken for canonical gate text.
    const gateEnd = body.indexOf(GATE_END_MARKER) + GATE_END_MARKER.length;
    const step3 = body.indexOf("3. **Read `references/providers/<id>.md`");
    expect(step3).toBeGreaterThan(gateEnd);
    expect(body.slice(0, gateEnd)).not.toContain("BEFORE your first provider");
  });

  it("still ships the reference the step sends the agent to", () => {
    expect(
      existsSync(path.join(skillsDir, "physical-action-video/references/providers/fal.md")),
    ).toBe(true);
  });
});

/** `prompts/` files are loaded into the agent's context exactly like a skill
 *  body — `model-seedance-2.md` is what documents the `@Audio1` grammar every stitch run
 *  reads — but they sat OUTSIDE every vendor and stale-claim sweep this branch ran, so a
 *  rule that had been rewritten provider-agnostically in the skill survived verbatim in
 *  the guide that cites it. `provider-gate.test.ts`'s removed-tool scan already walks
 *  these (it recurses from the skills root); what was missing is the claim-class sweep. */
describe("skill prompt guides are swept like skill bodies", () => {
  const promptFiles = (): { rel: string; text: string }[] => {
    const out: { rel: string; text: string }[] = [];
    for (const skill of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!skill.isDirectory()) continue;
      const dir = path.join(skillsDir, skill.name, "prompts");
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".md")) continue;
        out.push({
          rel: `${skill.name}/prompts/${f}`,
          text: readFileSync(path.join(dir, f), "utf8"),
        });
      }
    }
    return out;
  };

  /** A per-model guide's entire purpose is to describe ONE vendor's model —
   *  that IS the reference layer, and naming the model there is correct. Every other prompt
   *  file is routing or craft and is swept like a skill body. The distinction used to be
   *  carried only by the `model-` filename convention, which is not a declaration; this is.
   *  `prompt_kind: model-guide` in frontmatter is what exempts a file. */
  const isModelGuide = (text: string): boolean =>
    /^---\n(?:[^\n]*\n)*?prompt_kind:\s*model-guide\s*\n(?:[^\n]*\n)*?---\n/.test(text);

  it("finds the prompt guides at all (the guards below are not vacuous)", () => {
    expect(promptFiles().length).toBeGreaterThanOrEqual(20);
  });

  /** The claim class commit `6aa6278a` removed, and `audio-analysis`'s reference guard
   *  forbids: libi does not recommend a remote vendor for a kind — `PROVIDER_CATALOG`
   *  carries no such flag — and a guide that says otherwise re-teaches it at the point of
   *  the call. */
  it("no prompt guide recommends a provider on libi's behalf", () => {
    for (const { rel, text } of promptFiles()) {
      expect(text, rel).not.toMatch(/the (one|provider) libi recommends/i);
      expect(text, rel).not.toMatch(/libi recommends/i);
    }
  });

  /** The actual defect: a video-engine guide naming a remote VOICE vendor as the
   *  opt-in fallback, attributed to a skill that had stopped saying it. Voice routing is
   *  `voiceover-production` / `voice-replacement`'s decision and belongs in their bodies
   *  and provider references, never in an engine guide. */
  it("no prompt guide names a remote voice vendor", () => {
    for (const { rel, text } of promptFiles()) {
      expect(text, rel).not.toMatch(/elevenlabs/i);
    }
  });

  /** The rule is NOT "no vendor names in prompts" — it is "no vendor names in ROUTING
   *  or CRAFT prompts". `ai-video-models/prompts/model-seedance-2.md` exists to describe one
   *  vendor's model and must be able to name it; `script-craft.md` is model-agnostic dialogue
   *  craft and must not, because a vendor name there re-teaches provider routing at the point
   *  of the call, one level below every gate and every provider reference. The marked files
   *  declare themselves; everything else is swept like a skill body (the `ugc-craft` shape). */
  const VENDOR_RE: ReadonlyArray<[label: string, re: RegExp]> = [
    ["fal", /\bfal\b|fal-ai|fal\.ai/i],
    ["elevenlabs", /elevenlabs/i],
    ["higgsfield", /higgsfield/i],
  ];

  it("no unmarked prompt guide names a provider vendor", () => {
    const offenders: string[] = [];
    for (const { rel, text } of promptFiles()) {
      if (isModelGuide(text)) continue;
      for (const [label, re] of VENDOR_RE) {
        const hit = re.exec(text);
        if (hit) offenders.push(`${rel} names "${label}" (matched "${hit[0]}")`);
      }
    }
    expect(
      offenders,
      "a routing/craft prompt names a vendor:\n" +
        `${offenders.join("\n")}\n` +
        "Either remove the vendor name (route by kind, and let the skill's " +
        "references/providers/<id>.md carry it), or — if the file really is a per-model " +
        "guide — declare it with `prompt_kind: model-guide` frontmatter.",
    ).toEqual([]);
  });

  /** Guard the guard, twice over. The marker must exempt SOMETHING (or the sweep above is
   *  vacuous in the other direction), and it must not become a blanket opt-out bolted onto
   *  craft files: only the per-model guides carry it, and each names its model. */
  it("the model-guide marker is used, and only by per-model guides", () => {
    const marked = promptFiles().filter((f) => isModelGuide(f.text));
    expect(marked.map((f) => f.rel).sort()).toEqual([
      "ai-video-models/prompts/model-kling.md",
      "ai-video-models/prompts/model-seedance-2.md",
      "ai-video-models/prompts/model-veo-3-1.md",
      "ugc-product-video/prompts/model-seedance-2-feature-walkthrough.md",
      "ugc-product-video/prompts/model-seedance-2-premium-reveal.md",
      "ugc-product-video/prompts/model-seedance-2-product-hero.md",
      "ugc-product-video/prompts/model-seedance-2-studio-lookbook.md",
      "ugc-product-video/prompts/model-seedance-2-ugc.md",
    ]);
    for (const { rel, text } of marked) {
      expect(path.basename(rel), `${rel} is marked but is not a model- guide`).toMatch(/^model-/);
      expect(text, `${rel} is marked but declares no model`).toMatch(/^model:\s*\S.*$/m);
    }
  });

  /** And the detector itself: a file that merely CONTAINS the phrase, or carries it outside
   *  frontmatter, is not marked. Otherwise "prompt_kind: model-guide" written into a craft
   *  file's prose would silently buy an exemption. */
  it("the marker is only honoured in frontmatter", () => {
    expect(isModelGuide("---\nprompt_kind: model-guide\n---\n\n# X\n")).toBe(true);
    expect(isModelGuide("---\nmodel: Kling\nprompt_kind: model-guide\n---\n# X\n")).toBe(true);
    expect(isModelGuide("# X\n\nprompt_kind: model-guide\n")).toBe(false);
    expect(isModelGuide("<!-- prompt_kind: model-guide -->\n# X\n")).toBe(false);
    expect(isModelGuide("# X\n")).toBe(false);
  });

  /** A pointer that resolves nowhere misroutes an agent more cheaply than stale prose.
   *  `docs-local/` is gitignored provenance and is deliberately not required to exist. */
  it("every relative link in a prompt guide resolves", () => {
    const broken: string[] = [];
    for (const { rel, text } of promptFiles()) {
      for (const m of text.matchAll(/\]\((\.\.?\/[^)]+)\)/g)) {
        const target = m[1];
        if (target.includes("docs-local/")) continue;
        const abs = path.resolve(skillsDir, path.dirname(rel), target);
        if (!existsSync(abs)) broken.push(`${rel} → ${target}`);
      }
    }
    expect(broken, `dead links:\n${broken.join("\n")}`).toEqual([]);
  });
});

/** The recurring theme of the provider-reference splits above: three of the four splits
 *  left an MCP tool's inline description naming an endpoint the skill body had just
 *  stopped naming.
 *  A tool description is read BEFORE the agent opens the skill, so it is the higher-
 *  impact copy of the same fact — and nothing pinned it. This does. */
describe("MCP tool descriptions name no provider endpoint", () => {
  const repoRoot = path.resolve(__dirname, "../../..");
  const SURFACES = [
    "mcp/server.ts",
    "mcp/tools/schemas.ts",
    "mcp/tracking-mcp/register-tracking-tools.ts",
    "lib/jobs/runners/matte-gen.ts",
  ];

  it("no vendor-prefixed endpoint id appears in an agent-facing description", () => {
    const re = new RegExp(`\\b(?:${ENDPOINT_VENDORS.join("|")})/[a-zA-Z0-9/_.-]+`, "g");
    for (const rel of SURFACES) {
      const text = readFileSync(path.join(repoRoot, rel), "utf8");
      const hits = [...text.matchAll(re)].map((m) => m[0]).filter((h) => h !== "fal-ai/ElevenLabs");
      expect(hits, `${rel} names provider endpoint ids: ${hits.join(", ")}`).toEqual([]);
    }
  });

  it("no paid-path model name survives where the skill split removed it", () => {
    // Seedance is NOT on this list on purpose: server.ts / schemas.ts / ffmpeg-tools.ts
    // name it for an AUDIO CONTAINER constraint (@Audio1 takes MP3/WAV, not AAC), which
    // is a codec fact, not a model-routing decision the skill owns.
    const moved = ["birefnet", "bria", "gpt-image", "lucy-restyle", "latentsync", "sync-lipsync"];
    for (const rel of SURFACES) {
      const text = readFileSync(path.join(repoRoot, rel), "utf8").toLowerCase();
      for (const name of moved) {
        expect(text.includes(name), `${rel} still names "${name}"`).toBe(false);
      }
    }
  });

  it("they point at the owning skill's provider reference instead", () => {
    const tracking = readFileSync(
      path.join(repoRoot, "mcp/tracking-mcp/register-tracking-tools.ts"),
      "utf8",
    );
    expect(tracking).toContain("local-vs-paid-provider routing");
    expect(tracking).toContain("references/providers/<id>.md");
    const schemas = readFileSync(path.join(repoRoot, "mcp/tools/schemas.ts"), "utf8");
    expect(schemas).toContain(
      "photos use the paid provider path — see the removing-and-replacing-backgrounds skill",
    );
  });
});

/** `music-creation`. The distinguishing case in the set — the DEFAULT provider for
 *  this kind is libi's own on-device extension (ACE-Step, catalog id `ace-step`,
 *  extension id `local-music`), not a remote one. So the split has to move the two PAID
 *  paths out without weakening "local first": a body that merely stopped naming
 *  ElevenLabs/fal would pass a naive drift check while sending a free job to a paid
 *  provider. Every guard below pins one half of that. */
describe("music-creation split — local extension is the default provider", () => {
  const body = read("music-creation/SKILL.md");
  const { frontmatter } = parseSkillBody(body);
  const falRef = "music-creation/references/providers/fal.md";
  const elRef = "music-creation/references/providers/elevenlabs.md";
  /** The skill's OWN prose — the canonical gate is excluded, because the gate lists every
   *  catalog id (`fal`, `elevenlabs`, …) by design as the reference-file naming rule. The
   *  vendor scan below is about the skill's routing, not about the gate's id list.
   *  Cut to the gate's LAST line, not to the next `## ` — the earlier slice silently
   *  dropped the `music_profile` note and the interview paragraph that sit between the
   *  gate and `## Stage 0` out of the scan. (The same approach `music-video-creation`
   *  and `audio-analysis` use.) */
  const ownProse = ownProseOf(body);

  it("keeps the interview and the local default, and defers the paid providers", () => {
    expect(body).toContain("libi.generate_music");
    expect(body).toContain("references/providers/<id>.md");
    // The two API-key names the body used to hand out are gone for good.
    expect(body).not.toContain("ELEVENLABS_API_KEY");
    expect(body).not.toContain("FAL_KEY");
    // …and so is every vendor name. The skill's own prose routes by KIND, not by vendor.
    expect(ownProse).not.toMatch(/elevenlabs/i);
    expect(ownProse).not.toMatch(/fal-ai|fal\.ai|\bfal\b/i);
    expect(ownProse).not.toMatch(/Stable Audio/i);
    // Guard the guard: the slice really is the prose after the gate.
    expect(ownProse).toMatch(/^## Stage 0 — Frame$/m);
    expect(ownProse).not.toMatch(/## Provider gate/);
    expect(body).not.toContain("libi.list_bundled_mcps");
    expect(body).not.toContain("libi.show_api_config");
  });

  it("Stage 6 keeps the disclosure, the free-by-default rule and the no-provider exit", () => {
    expect(body).toMatch(/^## Stage 6 — Provider$/m);
    expect(body).toMatch(/Disclose the cost \+ quality trade-off:/);
    expect(body).toMatch(
      /\*\*local ACE-Step \(default, recommended\)\*\* — `libi\.generate_music`: free, on-device, no\s+key\. Instrumental excellent, vocals decent\./,
    );
    expect(body).toMatch(
      /\*\*A paid `music` provider\*\* — better vocals, specific style models\. Costs the user money\s+on their own provider account; see `references\/providers\/<id>\.md` under this skill for\s+what yours offers\./,
    );
    expect(body).toMatch(
      /If the user has no provider opinion, pick local ACE-Step\./,
    );
    // The upgrade is an OPTION, never a recommendation — this is the sentence that
    // stops the agent spending the user's money on its own initiative.
    expect(body).toMatch(
      /mention a paid provider as a quality upgrade — as an option, not a\s+recommendation\./,
    );
    expect(body).toMatch(
      /call\s+`libi\.suggest_provider\(\{ kind: "music" \}\)` and say what it showed\./,
    );
  });

  it("keeps the decisions that must not move out of the body", () => {
    // Stage 0.5's reuse-vs-generate fork, its licensing caveat, and its tools.
    expect(body).toMatch(/^## Stage 0\.5 — Recreating a video that already has music\?/m);
    expect(body).toMatch(/\*\*Reuse the original track \(recommended when faithfulness matters\)\.\*\*/);
    expect(body).toMatch(/libi\.extract_audio\(\{ fileId: <sourceVideoId> \}\)/);
    expect(body).toMatch(/\*\*Licensing caveat:\*\*/);
    expect(body).toMatch(/libi\.music_profile\(\{ fileId \}\)/);
    // Stage 7 still names the libi TOOL id (`local-music` is not a provider name).
    expect(body).toMatch(/I'll send this to\s+local-music/);
    // The length-policy gate is provider-independent and stays.
    expect(body).toMatch(/lengthPolicy: "extend"/);
    expect(body).toMatch(/asset_longer_than_piece/);
    expect(body).toMatch(/libi\.music_detect_beats/);
  });

  it("the provider gate stays first and is not duplicated", () => {
    const h2s = body.match(/^## .+$/gm) ?? [];
    expect(h2s[0]).toMatch(/^## Provider gate/);
    expect(body.match(/## Provider gate — read this first/g)?.length).toBe(1);
    // The gate is what carries "libi's own extension counts as a provider" — the whole
    // reason this skill does not send a user shopping for a paid music provider.
    expect(body).toMatch(/\*\*libi's own extension tools count as a provider\*\*/);
    expect(body).toMatch(/`libi\.generate_music` \(music\)/);
    expect(body).toMatch(/If one answers\s+`needs_install`, follow its install flow/);
  });

  it("ships one reference per paid music provider", () => {
    expect(existsSync(path.join(skillsDir, falRef))).toBe(true);
    expect(existsSync(path.join(skillsDir, elRef))).toBe(true);
  });

  it("the elevenlabs reference owns compose_music and says whose MCP it is", () => {
    const ref = read(elRef);
    expect(ref).toMatch(/^# ElevenLabs — provider reference for `music-creation`/m);
    expect(ref).toMatch(/the user's own ElevenLabs MCP\. libi does not bundle or\s+configure it\./);
    expect(ref).toMatch(
      /\*\*`compose_music`\*\* — the generation tool\. Best vocal quality, especially for English\./,
    );
    expect(ref).toMatch(
      /Paid, billed per generation\. \*\*Disclose the cost and get approval before every call\.\*\*/,
    );
    expect(ref).toMatch(
      /Reach for it only when the user asks for it, or when they want English vocals and have said\s+local ACE-Step's vocals aren't good enough\./,
    );
    expect(ref).toMatch(
      /Local ACE-Step \(`libi\.generate_music`\) is free,\s+on-device and the default — do not route music to a paid provider on your own initiative\./,
    );
    expect(ref).not.toMatch(/libi (bundles|provides|supplies|configures) ElevenLabs/i);
    // Shared mechanics are cross-referenced by path, not repeated.
    expect(ref).toMatch(/`ai-asset-generation`'s\s+`references\/providers\/fal\.md`/);
  });

  it("the fal reference owns the discover-price-run loop and stays local-first", () => {
    const ref = read(falRef);
    expect(ref).toMatch(/^# fal — provider reference for `music-creation`/m);
    expect(ref).toMatch(/Stable Audio/);
    expect(ref).toMatch(
      /Find the model with `recommend_model` \/ `search_models`, confirm its inputs with\s+`get_model_schema`, and price it with `get_pricing` before disclosing\./,
    );
    expect(ref).toMatch(
      /Run it with `run_model` \(short\) or `submit_job` \+ `check_job` \(long\) — poll with\s+`libi\.sleep`/,
    );
    expect(ref).toMatch(/Import the result and add it with `libi\.audio_add_clip`\./);
    expect(ref).toMatch(
      /Reach for fal only when the user explicitly wants a specific style model\. Local ACE-Step\s+\(`libi\.generate_music`\) is free, on-device and the default\./,
    );
    expect(ref).toMatch(/`ai-asset-generation`'s\s+`references\/providers\/fal\.md`/);
  });

  /** This reverses half of this skill's original rule: "neither reference may name a
   *  concrete endpoint id", and the REASON was mechanical, not editorial: `MODEL_KB`
   *  carried image and video entries only, so a music id would have been un-auditable
   *  (the KB could not resolve it) and unreachable (the fake could not serve it). The KB
   *  now has an audio-kind entry, so the fal reference may name it — and MUST, or the
   *  paid music path keeps its zero agent-level coverage. What did NOT change: the id is
   *  a candidate to confirm, never a default to call blind, and the discover-then-price
   *  loop stays the instruction. The ElevenLabs reference names no id at all — its music
   *  surface is a named tool, not an endpoint. */
  it("the fal reference names an id the KB can actually serve, and only that one", () => {
    const re = new RegExp(`\\b(?:${ENDPOINT_VENDORS.join("|")})/[a-zA-Z0-9/_.-]+`, "g");
    const ids = [...new Set(read(falRef).match(re) ?? [])];
    expect(ids, "the fal reference should name exactly the one KB-backed music model").toEqual([
      "fal-ai/stable-audio-25/text-to-audio",
    ]);
    // Un-auditable + unreachable is what this reference used to avoid; this is the direct check.
    expect(resolveEndpoint(ids[0], null).canonical).toBe("fal-ai/stable-audio-25/text-to-audio");
    expect(MODEL_KB[ids[0]].kind).toBe("audio");
    // Discovery still leads; the id is a starting point with a staleness stamp.
    expect(read(falRef)).toMatch(/Discover the current model rather than trusting a hardcoded name/);
    expect(read(falRef)).toMatch(/\*\*Known-good starting point \(maintainer-updated \d{4}-\d{2}-\d{2}\):\*\*/);
    expect(read(falRef)).toMatch(/never as a default to call blind/);
  });

  it("the elevenlabs reference still names no vendor-prefixed endpoint id", () => {
    const re = new RegExp(`\\b(?:${ENDPOINT_VENDORS.join("|")})/[a-zA-Z0-9/_.-]+`);
    expect(read(elRef), `${elRef} names a vendor endpoint id`).not.toMatch(re);
  });

  it("frontmatter and registry descriptions name no paid vendor", () => {
    expect(frontmatter.description).toMatch(/local ACE-Step by default/);
    expect(frontmatter.description).not.toMatch(/elevenlabs|fal-ai|fal\.ai/i);
    const entry = BUNDLED_SKILLS.find((s) => s.id === "music-creation");
    expect(entry?.description).toContain(
      "local ACE-Step by default; a paid music provider only on explicit request",
    );
    expect(entry?.description).not.toMatch(/elevenlabs|fal-ai|fal\.ai/i);
  });
});

/** `music-video-creation` — the wrapper. It delegates the music interview and the
 *  generation itself to `music-creation`, so its ONLY provider text was one bullet in the
 *  campaign-transparency list, naming `elevenlabs` and `fal-ai` as the two escalations
 *  after a run of unsatisfying local generations. The DECISION in that bullet (when to
 *  escalate, that it costs the user money, that it is never the agent's own initiative) is
 *  campaign policy and stays in the body; WHICH provider buys what moves into one
 *  reference per provider, mirroring the same split one level up in `music-creation`.
 *  Everything else here — the composition-hygiene rules that are the whole reason this
 *  skill exists — is provider-independent and must not move at all. */
describe("music-video-creation split — the wrapper escalates by kind, not by vendor", () => {
  const body = read("music-video-creation/SKILL.md");
  const { frontmatter } = parseSkillBody(body);
  const falRef = "music-video-creation/references/providers/fal.md";
  const elRef = "music-video-creation/references/providers/elevenlabs.md";
  /** The skill's OWN prose — the canonical gate is cut out, because the gate lists every
   *  catalog id (`fal`, `elevenlabs`, …) by design as the reference-file naming rule. Cut
   *  to the gate's LAST line rather than to the next `## `, so the delegation paragraph
   *  that follows it stays inside the vendor scan. */
  const ownProse = ownProseOf(body);

  it("names no vendor outside the gate and keeps its own mechanics", () => {
    expect(body).toContain("libi.music_detect_beats");
    expect(body).toContain("references/providers/<id>.md");
    expect(ownProse).not.toMatch(/elevenlabs/i);
    expect(ownProse).not.toMatch(/fal-ai|fal\.ai|\bfal\b/i);
    expect(body).not.toContain("FAL_KEY");
    expect(body).not.toContain("ELEVENLABS_API_KEY");
    // Guard the guard: the slice really is everything either side of the gate, and it
    // still contains the delegation paragraph that sits between the gate and the next H2.
    expect(ownProse).toMatch(/^# Music Video Creation$/m);
    expect(ownProse).toMatch(/\*\*You delegate the music interview to `music-creation` and the\s+transcription to `audio-analysis`\.\*\*/);
    expect(ownProse).toMatch(/^## The seven rules$/m);
    expect(ownProse).not.toMatch(/## Provider gate/);
  });

  it("keeps the campaign-transparency decisions and escalates by kind", () => {
    expect(body).toMatch(/^## Cost transparency for campaigns$/m);
    expect(body).toMatch(
      /Single-track disclosure is `music-creation`'s job\. THIS skill owns\s+campaign-level transparency:/,
    );
    expect(body).toMatch(/After the 2nd generation on the same piece: "That's 2 tracks\s+generated\./);
    expect(body).toMatch(
      /Before any generation > 120s: warn that ACE-Step wall-clock is\s+non-linear and a 2-min track typically runs ~100-120s on the local\s+CPU \(M-series Mac\)\./,
    );
    // The escalation itself: same trigger, same "not on your own initiative", no vendor.
    expect(body).toMatch(
      /- If the user has tried 4\+ generations in one session and still isn't\s+satisfied, suggest a paid `music` provider \(see\s+`references\/providers\/<id>\.md` under this skill\) rather than burning\s+another ACE-Step run — with the cost disclosed and their approval,\s+not on your own initiative\./,
    );
  });

  it("keeps the composition-hygiene rules, which have nothing to do with a provider", () => {
    expect(body).toMatch(/^### Rule 1 — One source of truth for on-screen text$/m);
    expect(body).toMatch(/\*\*Never run both at the same time on the same time range\.\*\*/);
    expect(body).toMatch(/\*\*Do not\*\* end your turn with "Pop open Preview to see it" as your\s+verification\./);
    expect(body).toMatch(/\*\*Never add a global lead offset\*\*/);
    expect(body).toMatch(
      /If `language` from `libi\.analysis_transcribe_audio` is anything other\s+than `en`, switch to `medium`:/,
    );
    expect(body).toMatch(/libi\.audio_add_clip\(\{ pieceId, fileId: newTrackId, startSeconds: 0,\s+volume: 1\.0, mute: true \}\)/);
    expect(body).toMatch(/lengthPolicy: "extend"/);
    expect(body).toMatch(/asset_longer_than_piece/);
    // The disk figure the campaign section leans on is a LOCAL-model fact, not a vendor
    // one — it stays in the body with the rest of the cleanup rule.
    expect(body).toMatch(/ACE-Step output is ~2 MB per second of stereo\s+48 kHz audio/);
  });

  it("the provider gate stays first and is not duplicated", () => {
    const h2s = body.match(/^## .+$/gm) ?? [];
    expect(h2s[0]).toMatch(/^## Provider gate/);
    expect(body.match(/## Provider gate — read this first/g)?.length).toBe(1);
    // The clause that stops the wrapper sending a user shopping for a paid music provider
    // when the free on-device one covers the job.
    expect(body).toMatch(/\*\*libi's own extension tools count as a provider\*\*/);
    expect(body).toMatch(/`libi\.generate_music` \(music\)/);
  });

  it("ships one reference per paid music provider", () => {
    expect(existsSync(path.join(skillsDir, falRef))).toBe(true);
    expect(existsSync(path.join(skillsDir, elRef))).toBe(true);
  });

  /** The wrapper must not grow a second copy of the discover/price/run loop: this skill
   *  generates no music itself, so each reference is a router into `music-creation`'s
   *  reference for the same provider. A body that inlined the mechanics here would drift
   *  against `music-creation`'s copy with nothing to catch it. */
  it("each reference defers the call mechanics to music-creation's matching reference", () => {
    expect(read(falRef)).toMatch(/^# fal — provider reference for `music-video-creation`/m);
    expect(read(falRef)).toMatch(/`music-creation`[\s\S]{0,160}`references\/providers\/fal\.md`/);
    // `run_model` belongs in the alternation — the rule is "no call loop", and
    // `run_model` is half of that loop.
    expect(read(falRef)).not.toMatch(/recommend_model|get_pricing|run_model|submit_job|check_job/);
    expect(read(elRef)).toMatch(/^# ElevenLabs — provider reference for `music-video-creation`/m);
    expect(read(elRef)).toMatch(/`music-creation`[\s\S]{0,200}`references\/providers\/elevenlabs\.md`/);
    // The elevenlabs half was pinned only POSITIVELY, so an edit could inline
    // `music-creation`'s ElevenLabs mechanics here and drift against that copy with
    // nothing to catch it — the exact class SHARED_IDS exists for, one level up.
    // Naming `compose_music` while pointing AT its owner is the pointer, not the
    // mechanics; what may not appear is the billing rule and the voice-picking loop.
    expect(read(elRef)).not.toMatch(
      /list_voices|billed per generation|approval before every call/,
    );
  });

  it("each reference keeps the escalation gate: 4+ local runs, disclosed cost, user approval", () => {
    for (const rel of [falRef, elRef]) {
      const ref = read(rel);
      expect(ref, rel).toMatch(/4\+ local generations in one session/);
      expect(ref, rel).toMatch(/only with the cost disclosed and their approval/);
      expect(ref, rel).toMatch(
        /local ACE-Step\s+\(`libi\.generate_music`\) is free, on-device and the default/,
      );
    }
  });

  it("splits the two escalations by what each buys, and cross-links them", () => {
    expect(read(falRef)).toMatch(/\*\*specific style models\*\* \(Stable Audio\s+and similar\)/);
    expect(read(falRef)).toMatch(/`references\/providers\/elevenlabs\.md`/);
    expect(read(elRef)).toMatch(/\*\*the strongest English vocals\*\*/);
    expect(read(elRef)).toMatch(/`references\/providers\/fal\.md`/);
    expect(read(elRef)).toMatch(/libi does not bundle or configure it/);
  });

  /** The original reason for this guard was mechanical (no audio-kind model in
   *  fake-fal's KB) and that gap has since been closed — `music-creation`'s fal
   *  reference now names one. This guard stays anyway, on the EDITORIAL reason that
   *  always sat underneath: this skill is the wrapper. It delegates
   *  the music interview and the generation itself to `music-creation`, so its escalation
   *  bullet names a PROVIDER kind; the model belongs one level down, in exactly one file. */
  it("neither reference names a vendor-prefixed endpoint id", () => {
    const re = new RegExp(`\\b(?:${ENDPOINT_VENDORS.join("|")})/[a-zA-Z0-9/_.-]+`);
    for (const rel of [falRef, elRef]) {
      expect(read(rel), `${rel} names a vendor endpoint id`).not.toMatch(re);
    }
  });

  it("frontmatter and registry descriptions name no provider", () => {
    expect(frontmatter.description).not.toMatch(/elevenlabs|fal-ai|fal\.ai|ACE-Step/i);
    const entry = BUNDLED_SKILLS.find((s) => s.id === "music-video-creation");
    expect(entry?.description).toContain("Delegates the interview to");
    expect(entry?.description).not.toMatch(/elevenlabs|fal-ai|fal\.ai|ACE-Step/i);
  });
});

/** `audio-analysis` — the transcription skill, and the second case (after
 *  `music-creation`) where libi's OWN on-device extension is the provider for the kind.
 *  Two things make it different from every other split in the set:
 *
 *  1. **Whisper is the only `transcription` provider in `PROVIDER_CATALOG`.** ElevenLabs
 *     is catalogued for `voice | music | sfx`, never transcription, and libi has since
 *     deleted its ElevenLabs STT client outright. So the body may not call it "the
 *     provider libi recommends" for a transcript — that is the exact claim `6aa6278a`
 *     stripped out of the bundled defs — and `libi.suggest_provider({ kind:
 *     "transcription" })` has nothing to offer beyond the Whisper the user already has,
 *     which makes it useless as the no-diarization exit. (A later fix stopped it from
 *     opening a panel in that case — it answers `status: "none"` with `whisper` in
 *     `covered`. That fixed the panel, not the emptiness: `none`'s own note ends at "use
 *     what `covered` names, or say plainly what libi cannot do", which IS this exit,
 *     minus the diarization-specific offer the skill adds. So the body still says it
 *     itself rather than paying a tool call to be told to.)
 *  2. **`speech_to_text` is still worth documenting**, because a user who connected
 *     ElevenLabs for voice HAS it in their tool list and the gate says to use what you
 *     have. So the reference exists, in the same spirit as `voice-replacement`'s fal
 *     reference for lip-sync (a capability outside that provider's catalog kinds) — it
 *     describes the USER's tool, it does not advertise a libi capability.
 *
 *  The reference is a ROUTER in the same style as `music-creation`'s and
 *  `music-video-creation`'s: the chunk/save loop lives in `SKILL.md`'s Path B and must
 *  not be duplicated into it. */
describe("audio-analysis split — Whisper is the provider, the paid STT is the user's", () => {
  const body = read("audio-analysis/SKILL.md");
  const { frontmatter } = parseSkillBody(body);
  const elRef = "audio-analysis/references/providers/elevenlabs.md";
  /** The skill's OWN prose — the canonical gate is cut out, because the gate lists every
   *  catalog id (`fal`, `elevenlabs`, …) by design as the reference-file naming rule. Cut
   *  to the gate's LAST line (the same approach `music-video-creation` uses), not to the
   *  next `## `, so the two
   *  paragraphs that sit between the gate and `## Path A` stay inside the vendor scan. */
  const ownProse = ownProseOf(body);

  it("names no vendor outside the gate and keeps its own tools", () => {
    expect(body).toContain("libi.analysis_transcribe_audio({ fileId })");
    expect(body).toContain("libi.analysis_chunk_audio");
    expect(body).toContain("libi.analysis_save_audio_chunk");
    expect(body).toContain("references/providers/<id>.md");
    expect(ownProse).not.toMatch(/elevenlabs/i);
    expect(ownProse).not.toMatch(/fal-ai|fal\.ai/i);
    expect(body).not.toContain("ELEVENLABS_API_KEY");
    expect(body).not.toMatch(/provider:\s*"elevenlabs"/);
    // Guard the guard: the slice really is everything either side of the gate, and it
    // still holds the "default provider is local Whisper" paragraph that follows it.
    expect(ownProse).toMatch(/^# Audio Analysis \(Transcription\)$/m);
    expect(ownProse).toMatch(
      /The default provider is \*\*local Whisper\*\* — free, no API key\./,
    );
    expect(ownProse).toMatch(/^## Path A — Whisper \(default\)$/m);
    expect(ownProse).not.toMatch(/## Provider gate/);
  });

  it("keeps the Whisper-first decisions: bootstrap, escalation, the paid ASK-FIRST gate", () => {
    expect(body).toMatch(/^## Path A — Whisper \(default\)$/m);
    expect(body).toMatch(/libi\.get_install_plan\(\{ mcpId: "whisper" \}\)/);
    expect(body).toMatch(/libi\.whisper_download_model\(\{ model: "small" \}\)/);
    expect(body).toMatch(/Download `medium` \(~1\.5 GB\)\s*or `large-v3` \(~3 GB\) only after the user confirms\./);
    expect(body).toMatch(/^## If local Whisper is unavailable \(paid fallback — ASK FIRST\)$/m);
    expect(body).toMatch(/Free\/local Whisper, including its first-run model download, never needs approval\./);
    // Path B is the provider-agnostic seam and stays in the body, whole.
    expect(body).toMatch(/^## Path B — your own STT provider$/m);
    expect(body).toMatch(/libi\.analysis_save_audio_chunk_from_file\(\{ chunkId,\s+jsonPath \}\)/);
  });

  /** The sentence this task exists to remove. `providersForKind("transcription")` returns
   *  `[whisper]` and nothing else, so a "call suggest_provider for diarization" exit sent
   *  the user at the on-device model they already have. An earlier fix stopped that from
   *  opening a panel (`status: "none"`) and a later one taught the gate to route on it,
   *  but neither makes
   *  the call worth making HERE: the tool's `none` answer stops at "use what `covered`
   *  names, or say plainly what libi cannot do", and this paragraph is that sentence plus
   *  the diarization trade-off only this skill knows. `audio-analysis/01` asserts the call
   *  is absent on this path, so a rewrite that defers to the tool fails there too. */
  it("does not send the user shopping for a transcription provider it cannot suggest", () => {
    expect(body).not.toMatch(/suggest_provider\(\{ kind: "transcription", reason:/);
    expect(body).toMatch(
      /libi's own transcription provider is on-device Whisper, and it does not\s+diarize/,
    );
    expect(body).toMatch(/`libi\.list_providers\(\)` shows what is connected\./);
    // The gate's own suggest_provider line is untouched — that one is correct.
    expect(body).toContain('libi.suggest_provider({ kind: "transcription" })');
  });

  it("the provider gate stays first and is not duplicated", () => {
    const h2s = body.match(/^## .+$/gm) ?? [];
    expect(h2s[0]).toMatch(/^## Provider gate/);
    expect(body.match(/## Provider gate — read this first/g)?.length).toBe(1);
    // The clause that makes Whisper the provider rather than a missing provider.
    expect(body).toMatch(/\*\*libi's own extension tools count as a provider\*\*/);
    expect(body).toMatch(/`libi\.analysis_transcribe_audio` \(transcription\)/);
  });

  it("ships the elevenlabs reference and it describes the USER's MCP, not a libi capability", () => {
    expect(existsSync(path.join(skillsDir, elRef))).toBe(true);
    const ref = read(elRef);
    expect(ref).toMatch(/^# ElevenLabs — provider reference for `audio-analysis`/m);
    expect(ref).toMatch(/libi does not\s+bundle, configure or supply it/);
    // The correction 6aa6278a made everywhere else: it is NOT a libi transcription path.
    expect(ref).toMatch(
      /it is not in libi's transcription catalog — libi's own\s+transcription provider is on-device Whisper \(`libi\.analysis_transcribe_audio`\)\./,
    );
    expect(ref).not.toMatch(/libi (bundles|provides|supplies|configures|recommends) ElevenLabs/i);
    expect(ref).not.toMatch(/the (transcription )?provider libi recommends/i);
  });

  it("the reference owns what speech_to_text buys, and the flat-string trap", () => {
    const ref = read(elRef);
    expect(ref).toMatch(/^## What `speech_to_text` adds$/m);
    expect(ref).toContain("speaker_id");
    expect(ref).toMatch(/`type`\s*\n?\(`word` \| `spacing` \| `audio_event`\)/);
    expect(ref).toMatch(
      /\*\*speaker diarization\*\* and\s+\*\*audio-event tags\*\* are the two things this buys/,
    );
    expect(ref).toMatch(/Take the `words` array, not the flat top-level text/);
    expect(ref).toMatch(/^## Cost$/m);
    expect(ref).toMatch(
      /Paid, billed per minute of audio, on the user's own ElevenLabs account\./,
    );
    expect(ref).toMatch(/get explicit approval before the first chunk/);
    expect(ref).toMatch(/Local Whisper,\s+including its first-run model download, never needs approval/);
  });

  /** Router rule (the same one `music-creation` and `music-video-creation` follow): a
   *  per-skill reference names only what that skill needs and defers the shared
   *  mechanics to whoever owns them — here `SKILL.md`'s Path B, one file up rather than
   *  one skill over. A second copy of the chunk/save loop would drift against Path B
   *  with nothing to catch it. */
  it("defers the chunk/save loop to Path B instead of re-inlining it", () => {
    const ref = read(elRef);
    expect(ref).toMatch(/`## Path B — your own STT provider`/);
    expect(ref).not.toMatch(/libi\.analysis_chunk_audio/);
    expect(ref).not.toMatch(/libi\.analysis_save_audio_chunk/);
    expect(ref).not.toMatch(/libi\.analysis_transcribe_audio\(\{ fileId/);
  });

  /** ElevenLabs' STT is a named TOOL (`speech_to_text`), not a fal endpoint id, so there is
   *  no id for this reference to name in the first place. (`music-creation` and
   *  `music-video-creation` also cited fake-fal's missing audio-kind entry; that gap has
   *  since been closed, which changes nothing here — an audio model in the KB is a music
   *  generator, not a transcriber.) */
  it("the reference names no vendor-prefixed endpoint id", () => {
    const re = new RegExp(`\\b(?:${ENDPOINT_VENDORS.join("|")})/[a-zA-Z0-9/_.-]+`);
    expect(read(elRef), `${elRef} names a vendor endpoint id`).not.toMatch(re);
  });

  it("frontmatter and registry descriptions name no provider", () => {
    expect(frontmatter.description).toMatch(/Default is local Whisper/);
    expect(frontmatter.description).not.toMatch(/elevenlabs|fal-ai|fal\.ai/i);
    const entry = BUNDLED_SKILLS.find((s) => s.id === "audio-analysis");
    expect(entry?.description).toContain("Default is local Whisper");
    expect(entry?.description).toContain("the agent's own transcription provider");
    expect(entry?.description).not.toMatch(/elevenlabs|fal-ai|fal\.ai/i);
  });

  /** The install plan is agent-facing and is READ on the `needs_install` path this skill
   *  documents, so a stale vendor claim there survives the SKILL.md split intact and
   *  contradicts it at the worst possible moment. `6aa6278a` fixed the bundled defs and
   *  the tool descriptions; it did not reach the plans. */
  it("whisper's install plan routes diarization by kind, not by vendor", () => {
    const plan = readFileSync(
      path.resolve(__dirname, "../../../mcp/bundled-mcps/plans/whisper.md"),
      "utf8",
    );
    expect(plan).not.toMatch(/elevenlabs/i);
    expect(plan).not.toMatch(/suggest_provider\(\{ kind: "transcription", reason:/);
    expect(plan).toMatch(/the `audio-analysis` skill's Path B/);
    // It still says what libi cannot do, and where the provider's details live.
    expect(plan).toMatch(/faster-whisper does not label speakers/);
    expect(plan).toMatch(/`references\/providers\/<id>\.md`/);
  });
});

/** `voiceover-production` — the generation-time audio authority. Its provider text is
 *  unusual in the set in two ways, and both shape the guards below.
 *
 *  1. **It carries NO provider gate, and must not grow one.** This skill used to be
 *     gated `voice` and then spent nine lines of prose neutralising that gate, because an
 *     AI video's voice comes out of the VIDEO generation (`generate_audio`) and one voice
 *     across clips comes from a *reference-conditioned* generation — so the canonical
 *     gate's "prefer libi's own extension for the kind" resolved to Kokoro
 *     (`libi.generate_speech`), which IS the mute-and-layer-a-TTS-track regression rules
 *     1 and 2 exist to stop. The root cause was the classification, not the gate. This
 *     skill is not a standalone entry point, is loaded by four skills that all gate on
 *     `video` first, and calls no generation tool of its own — exactly the same reasoning
 *     `stitching-multi-clip` relies on for staying ungated, whose guard the one below
 *     mirrors. The paragraph the gate needed is gone with it; what survives is the
 *     positive fact (the provider that decides this skill is the video one) plus the
 *     honest exit the paragraph could not perform.
 *  2. **The endpoint is a POINTER, not a copy.** `ai-video-models`' fal reference owns
 *     fal's engine→endpoint map and is pinned by "maps every engine to its fal endpoint
 *     ids in one place"; `bytedance/seedance-2.0/reference-to-video` is in the SHARED_IDS
 *     table for the three references that DO carry it, and this skill's reference
 *     deliberately holds a pointer instead of a fourth copy (the comment here used to
 *     claim the id had "exactly one home", which was false and argued for deleting a
 *     guard that should stay). This skill's reference is therefore a ROUTER in the same
 *     style as `music-creation`'s and `music-video-creation`'s: it says which KIND of
 *     endpoint carries a voice and what breaks the carry, and defers the id, the input
 *     keys and the per-modality limits to the skill that owns them. The body's POINTERS
 *     say exactly that too: they promise the reference names the *kind* of endpoint and
 *     says where the id lives — they used to promise it "names it", which the reference
 *     refuses to do by design. */
describe("voiceover-production split — the carry is a capability, the endpoint a pointer", () => {
  const body = read("voiceover-production/SKILL.md");
  const { frontmatter } = parseSkillBody(body);
  const falRef = "voiceover-production/references/providers/fal.md";
  /** With the gate gone there is nothing to cut out: the WHOLE file is this skill's own
   *  prose, which is the strongest form of the vendor scan and the one
   *  `stitching-multi-clip` gets for the same reason. `ownProseOf` is a no-op here and is
   *  kept so that regrowing a gate does not silently widen what the scan below is
   *  allowed to see. */
  const ownProse = ownProseOf(body);

  it("names no provider anywhere in the file", () => {
    expect(ownProse).toBe(body); // ungated: the scan is whole-file
    expect(ownProse).not.toMatch(/elevenlabs/i);
    expect(ownProse).not.toMatch(/fal-ai|fal\.ai|\bfal\b/i);
    expect(body).not.toContain("FAL_KEY");
    expect(body).not.toContain("ELEVENLABS_API_KEY");
    expect(body).toContain("references/providers/<id>.md");
    // Guard the guard: the scan really does cover the head of the file and the tree.
    expect(ownProse).toMatch(/^# Voiceover & Native Audio \(generation-time authority\)$/m);
    expect(ownProse).toMatch(/\*\*The provider that matters here is your VIDEO one\.\*\*/);
    expect(ownProse).toMatch(/^## The decision tree \(key on the SOURCE of the footage\)$/m);
  });

  /** Recorded rather than left to look like an oversight. `model-seedance-2` is a
   *  vendor-NAMED guide path, and it is where the `@Audio1` / `@Image1` token grammar
   *  actually lives, so pointing at it by filename is a citation, not a routing decision.
   *  The `stitching-multi-clip` guard bans the bare word "seedance" outright, and the
   *  two files are read together — so the difference is deliberate, and this pins it to
   *  the guide-path form only. */
  it("names a vendor only as the guide path that owns the token grammar", () => {
    for (const m of body.match(/[Ss]eedance[^\n]{0,20}/g) ?? []) {
      expect(m, `unexpected Seedance mention: ${m}`).toMatch(/^seedance-2`/);
    }
    expect(body).toMatch(/`model-seedance-2`/);
  });

  it("keeps every audio DECISION — they are what this skill is", () => {
    expect(body).toMatch(/generate_audio\s*=\s*true/);
    expect(body).toMatch(/\*\*Muting an AI generation is a\s+defect\*\*/);
    expect(body).toMatch(/@Audio1/);
    expect(body).toMatch(/@Image1/);
    expect(body).toMatch(/STANDARD multi-clip voice path, not an\s+experiment, and you MUST attempt it/);
    expect(body).toMatch(/ALWAYS ASK first/);
    expect(body).toMatch(/\*\*\(A\) Reuse the source voice — DEFAULT when a reused beat carries the actor's voiceover\.\*\*/);
    expect(body).toMatch(/\*\*\(B\) Generate a fresh voice/);
    expect(body).toMatch(/\*\*Match the source speaker's DELIVERY in the clip prompt\.\*\*/);
    expect(body).toMatch(/Do NOT pre-emptively mute the clips and layer a separate TTS voiceover/);
    expect(body).toMatch(/^## Re-voicing an existing video → `voice-replacement`$/m);
  });

  /** The MP3-not-`copy` trap is a fact about `libi.extract_audio`'s `format` param — a
   *  libi tool — so it stays in the body even though the thing that rejects the AAC file
   *  is the provider's model. What leaves is "(fal-safe)", the only vendor word in it. */
  it("keeps the extract_audio MP3-not-copy trap in the body", () => {
    expect(body).toContain("libi.extract_audio");
    expect(body).toMatch(/\*\*defaults to MP3\*\*/);
    expect(body).toMatch(/\*\*never pass `format: "copy"`\*\*/);
    expect(body).toMatch(/HTTP 422/);
    expect(body).not.toMatch(/fal-safe/);
  });

  /** The phrasing `stitching-multi-clip` and `ugc-product-video` reuse: the carry
   *  is "a reference-conditioned generation", a capability any provider may or may not
   *  have — never an endpoint path and never a vendor's default-vs-not. */
  it("expresses the carry as a capability, not as an endpoint or a vendor", () => {
    expect(body).toMatch(/reference-conditioned/);
    expect(body).not.toContain("bytedance/seedance-2.0");
    expect(body).not.toContain("reference-to-video");
    expect(body).not.toContain("audio_urls");
    expect(body).not.toContain("image_urls");
    expect(body).not.toMatch(/never ElevenLabs/i);
    expect(body).not.toMatch(/no ElevenLabs/i);
    expect(body).toMatch(/never a separate\s+TTS voice by default/);
  });

  /** It is ungated and must stay that way: a `voice` gate makes the canonical gate's
   *  "prefer libi's own extension for the kind" resolve to `libi.generate_speech`, which
   *  is the regression; a `video` gate would be honest but would stop a build that has
   *  already gated one level up. Either way the gate is wrong HERE. This is the same
   *  guard `stitching-multi-clip`, its twin, carries — the wave used to guard one against
   *  ever growing a gate while giving the other a gate on the wrong kind. */
  it("carries no provider gate — and must not grow one", () => {
    expect(body).not.toContain("## Provider gate");
    expect(body).not.toContain('libi.suggest_provider({ kind: "voice" })');
    expect(body).not.toContain("libi.list_providers");
    expect(body).not.toMatch(/libi's own extension tools count as a provider/);
    expect(body).not.toContain("libi.generate_speech");
    // …and the reason it is correct to be ungated is stated in the file itself.
    expect(body).toMatch(
      /Every one of them gates on a\s+`video` provider before it reaches here, and this skill calls no generation tool of its\s+own, which is why it carries no provider gate\./,
    );
  });

  /** The positive half of the guard above: dropping the gate must not drop the FACT the
   *  gate's wrinkle was pointing at. The deciding provider is the video one, and a TTS
   *  tool is the regression — that is routing, not gating, and it stays.
   *
   *  The honest exit used to be prose with no tool call, so an agent that had read it had
   *  nothing to do. `voice-replacement` solved the identical two-kind shape with an
   *  INLINE `libi.suggest_provider({ kind: "video", reason: … })` at the point of need
   *  (`voice-replacement/SKILL.md`), and this reuses it. */
  it("says the provider that matters here is the VIDEO one, and offers the honest exit", () => {
    expect(body).toMatch(
      /the provider that decides whether this skill can work is\s+your \*\*video\*\* provider/,
    );
    expect(body).toMatch(/reference-conditioned\* generation/);
    expect(body).toMatch(
      /laying a synthesized track over\s+generated clips is the exact regression rules 1 and 2 exist to stop/,
    );
    expect(body).toMatch(/A standalone TTS\s+voice belongs to the `voice-replacement` skill/);
    expect(body).toMatch(/a voice provider does not\s+substitute for one/);
    // The exit names a tool, and it is the VIDEO kind — the only kind that can
    // answer this skill's question. `suggest_provider({ kind: "voice" })` would offer
    // elevenlabs/kokoro for a job that needs a video model.
    expect(body).toContain(
      'libi.suggest_provider({ kind: "video", reason: "reference-conditioned voice carry" })',
    );
    expect(body).not.toMatch(/suggest_provider\(\{ kind: "voice"/);
    // The same inline-call shape `voice-replacement` shipped, which is why this is not a new pattern.
    expect(read("voice-replacement/SKILL.md")).toMatch(
      /libi\.suggest_provider\(\{ kind: "video", reason: "lip-sync" \}\)/,
    );
  });

  it("ships a fal reference and it is a ROUTER, not a second endpoint table", () => {
    expect(existsSync(path.join(skillsDir, falRef))).toBe(true);
    const ref = read(falRef);
    expect(ref).toMatch(/^# fal — provider reference for `voiceover-production`/m);
    expect(ref).toMatch(/`ai-video-models`[\s\S]{0,240}`references\/providers\/fal\.md`/);
    expect(ref).toMatch(/model-seedance-2/);
    // `run_model` is part of the stated rule (a router may not inline the call
    // loop) and was missing from the alternation.
    expect(ref).not.toMatch(/recommend_model|get_pricing|run_model|submit_job|check_job/);
  });

  /** Four pointers used to promise the reference "names" the carry endpoint, while
   *  that reference deliberately holds no id at all and the guard below enforces the
   *  absence. Each side was pinned by a separate assertion, so nothing caught the
   *  contradiction. Pin the two together: the pointers promise the KIND plus where the id
   *  lives, which is what the file delivers. */
  it("the body's pointers promise what the reference actually delivers", () => {
    const prose = ownProse.replace(/\s+/g, " ");
    expect(prose).toContain(
      "`references/providers/<id>.md` under this skill says which kind of endpoint that is for your provider and where its id lives",
    );
    expect(prose).toContain(
      "`references/providers/<id>.md` under this skill says which kind of endpoint accepts them and where its id lives",
    );
    expect(prose).toContain(
      "which kind of endpoint accepts them, and where its id lives, is in `references/providers/<id>.md` under this skill",
    );
    // No pointer may claim the reference NAMES the endpoint — it does not.
    expect(prose).not.toMatch(/references\/providers\/<id>\.md`[^.]{0,80}names (it|the endpoint)/);
    // …and `stitching-multi-clip`, read alongside this file, must not either.
    const stitch = read("stitching-multi-clip/SKILL.md").replace(/\s+/g, " ");
    expect(stitch).toContain(
      "`references/providers/<id>.md` under `voiceover-production` says which kind of endpoint that is and where its id lives",
    );
    expect(stitch).not.toMatch(/under `voiceover-production` names it/);
  });

  it("the reference says which endpoint KIND carries a voice and what breaks the carry", () => {
    const ref = read(falRef);
    expect(ref).toMatch(/^## /m);
    expect(ref).toMatch(/no reference tokens and no audio\s+input/);
    expect(ref).toMatch(/@Audio1/);
    expect(ref).toMatch(/@Image1/);
    expect(ref).toMatch(/audio references and no image or video reference is rejected/);
    // The decision itself does not move into the reference.
    expect(ref).toMatch(/is\s+in `SKILL\.md`/);
  });

  /** The whole reason this reference holds a pointer: `ai-video-models` is pinned by
   *  "maps every engine to its fal endpoint ids in one place", and this id is in the
   *  SHARED_IDS duplication table above for the three references that carry it. THIS
   *  skill's reference deliberately holds a pointer instead of a fourth copy. (This
   *  comment used to say the id had "exactly one home" — false, and an argument for
   *  deleting a guard that should stay.) */
  it("holds a pointer to the carry endpoint id, never a fourth copy of it", () => {
    const owners: string[] = [];
    for (const skill of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!skill.isDirectory()) continue;
      const dir = path.join(skillsDir, skill.name, "references", "providers");
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".md")) continue;
        if (readFileSync(path.join(dir, f), "utf8").includes("bytedance/seedance-2.0/reference-to-video")) {
          owners.push(skill.name);
        }
      }
    }
    // The three that already carry it are pinned against each other by SHARED_IDS above.
    // This skill is not one of them, and its reference names no vendor id at all.
    expect(owners).not.toContain("voiceover-production");
    const re = new RegExp(`\\b(?:${ENDPOINT_VENDORS.join("|")})/[a-zA-Z0-9/_.-]+`);
    expect(read(falRef), `${falRef} names a vendor endpoint id`).not.toMatch(re);
  });

  it("frontmatter and registry descriptions name no provider or endpoint", () => {
    expect(frontmatter.description).toContain("reference-conditioned generation (@Audio1)");
    expect(frontmatter.description).not.toMatch(/seedance|elevenlabs|fal-ai|fal\.ai/i);
    const entry = BUNDLED_SKILLS.find((s) => s.id === "voiceover-production");
    expect(entry?.description).toContain("reference-conditioned generation (@Audio1)");
    expect(entry?.description).not.toMatch(/seedance|elevenlabs|fal-ai|fal\.ai/i);
  });

  /** The install plan is agent-facing and is read on exactly the path this skill's gate
   *  sends a Kokoro-less agent down (`libi.generate_speech` → `needs_install` →
   *  `libi.get_install_plan({ mcpId: "local-tts" })`). Without a scope line it walks the
   *  agent through installing a TTS model and generating a track — the regression — with
   *  nothing in the plan to say that is not what a generated video's voice is. */
  it("the local-tts install plan says a generated video's voice is not a TTS track", () => {
    const plan = readFileSync(
      path.resolve(__dirname, "../../../mcp/bundled-mcps/plans/local-tts.md"),
      "utf8",
    );
    expect(plan).toMatch(/`voiceover-production`/);
    expect(plan).toMatch(/`voice-replacement`/);
    expect(plan).toMatch(/native audio of a video generation/);
    // The cloning note is about the user's OWN connected MCP, not a libi recommendation.
    expect(plan).not.toMatch(/use ElevenLabs instead/);
  });

  /** The cross-reference chase. Five skills point AT this one for its audio policy, and
   *  three of those pointers named things it does not own — a stale pointer misroutes an
   *  agent more cheaply than stale prose does, because it is read instead of the skill. */
  it("the pointers into this skill from other skills resolve", () => {
    const routes = read("ugc-product-video/prompts/production-routes.md");
    // There is no Rule 5 — the decision tree is rules 1-4.
    expect(routes).not.toMatch(/`voiceover-production` Rule 5/);
    expect(routes).toMatch(/`voiceover-production` Rule 4/);
    // It does not own a provider choice, a voice-ID rule or a needs_config flow any more.
    expect(routes).not.toMatch(/never-fall-back-to-Kokoro-for-UGC rule/);
    expect(routes).not.toMatch(/needs_config` STOP-and-ASK flow/);
    const aag = read("ai-asset-generation/SKILL.md");
    expect(aag).not.toMatch(/Kokoro is never the UGC voice; ElevenLabs,\s+ASK if no key/);
    expect(aag).toMatch(/`voice-replacement`/);
    const tree = body.slice(body.indexOf("## The decision tree"));
    const rules = tree.slice(0, tree.indexOf("\n## ", 1)).match(/^\d\. \*\*/gm) ?? [];
    expect(rules.length).toBe(4);
  });
});

/** `stitching-multi-clip` — the negative-constraint end of the split. This skill
 *  generates NOTHING: every line of its cost section is `$0` (CPU-only ffmpeg) and the
 *  only provider text it ever carried was the voice-carry policy it inherits from
 *  `voiceover-production`. So it ships no provider reference and no gate, and the work
 *  here is making sure it carries no vendor text and cannot regain any.
 *
 *  Two things make its guards different from every gated skill above:
 *
 *  1. **There is no gate to cut out.** The `ownProse` slice `music-video-creation`,
 *     `audio-analysis` and `voiceover-production` use exists because the canonical gate
 *     lists every catalog id (`fal`, `elevenlabs`, …) by design, which makes a
 *     whole-file vendor scan unsatisfiable there. This skill is ungated, so the whole
 *     file IS its own prose and the scan can be whole-file — the strongest form
 *     available, and the reason the negatives below are broader than the `no ElevenLabs`
 *     / `bytedance/…` strings the passages actually held.
 *  2. **The capability phrasing is shared, not merely similar.** `voiceover-production`
 *     owns the stitch's VOICE plan and this skill owns its CLIP plan; an agent running a
 *     stitch has both open at once. Two wordings for one rule is how they drift, so the
 *     phrases are pinned against the other file rather than as literals. */
describe("stitching-multi-clip — the stitch owns no provider", () => {
  const body = read("stitching-multi-clip/SKILL.md");
  const { frontmatter } = parseSkillBody(body);
  const collapse = (s: string) => s.replace(/\s+/g, " ");

  it("is ungated and ships no provider reference — and must stay that way", () => {
    // Adding a gate here would be wrong, not merely redundant: the skill spends $0 and
    // is loaded mid-stitch by a skill that has already gated. It would stop a build that
    // needs no provider of its own.
    expect(body).not.toContain("## Provider gate");
    expect(body).not.toContain("libi.suggest_provider");
    expect(body).not.toContain("libi.list_providers");
    expect(existsSync(path.join(skillsDir, "stitching-multi-clip/references"))).toBe(false);
    // …and the cost section is what makes that correct.
    expect(body).toContain("No generation-provider calls.");
    expect(body).toMatch(/`libi\.concat_videos` `-c copy` fast path: \$0/);
  });

  it("names no vendor, model or endpoint id anywhere in the file", () => {
    const vendors = [
      "elevenlabs",
      "higgsfield",
      "ace-step",
      "kokoro",
      "seedance",
      "veo",
      "kling",
      "wan",
      "lucy",
    ];
    for (const v of vendors) {
      expect(body, `stitching-multi-clip names ${v}`).not.toMatch(new RegExp(`\\b${v}\\b`, "i"));
    }
    expect(body).not.toMatch(/\bfal\b/i);
    const endpoint = new RegExp(`\\b(?:${ENDPOINT_VENDORS.join("|")})/[a-zA-Z0-9/_.-]+`);
    expect(body, "stitching-multi-clip names a vendor endpoint id").not.toMatch(endpoint);
    // The frontmatter is what selects the skill; it must stay vendor-free too.
    expect(frontmatter.description).not.toMatch(/seedance|elevenlabs|veo|kling|\bfal\b/i);
    const entry = BUNDLED_SKILLS.find((s) => s.id === "stitching-multi-clip");
    expect(entry?.description).not.toMatch(/seedance|elevenlabs|veo|kling|\bfal\b/i);
  });

  /** The two files are read together in every stitch run, so the carry is described with
   *  ONE wording, pinned against the file that owns it rather than as a literal here. */
  it("reuses voiceover-production's capability phrasing verbatim", () => {
    const voice = collapse(read("voiceover-production/SKILL.md"));
    const stitch = collapse(body);
    for (const phrase of [
      "never a separate TTS voice by default",
      "reference-conditioned endpoint",
      "no silent gaps, no separate TTS voice",
    ]) {
      expect(stitch, `stitching-multi-clip lost "${phrase}"`).toContain(phrase);
      expect(voice, `voiceover-production lost "${phrase}"`).toContain(phrase);
    }
    // …and it still hands the voice decision to that skill rather than restating it.
    expect(collapse(body)).toContain("Load `voiceover-production` (REQUIRED");
  });

  /** A pointer that resolves nowhere misroutes an agent more cheaply than stale prose,
   *  because it is read INSTEAD of the skill. This skill ships no `references/` dir, so
   *  every provider-reference pointer in it has to name the skill that does. Repo-wide,
   *  because "say `under this skill` in a skill that ships none" is the whole defect.
   *
   *  The canonical gate has to come out first, exactly as the vendor scans above cut it:
   *  its own naming rule says "`references/providers/<id>.md` under this skill" and is
   *  explicitly CONDITIONAL ("If this skill ships a reference for it"), so a gated skill
   *  that legitimately ships none — `video-analysis` — is not an offender. Scanning the
   *  raw file flagged it, which is the false positive this cut exists to remove. */
  it("no skill points at a provider reference under itself unless it ships one", () => {
    const offenders: string[] = [];
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(skillsDir, entry.name, "SKILL.md");
      if (!existsSync(skillFile)) continue;
      const text = readFileSync(skillFile, "utf8");
      // `collapse` has already turned every newline into a space, so the `[^\n]*`
      // this used to carry matched the WHOLE file — a path mention near the top and an
      // unrelated "under this skill" near the bottom paired up. Bound the gap instead.
      if (!/references\/providers\/<id>\.md`?.{0,120}under this skill/.test(collapse(ownProseOf(text)))) continue;
      if (!existsSync(path.join(skillsDir, entry.name, "references", "providers"))) {
        offenders.push(entry.name);
      }
    }
    expect(offenders, `these point at a provider reference they do not ship:\n${offenders.join("\n")}`).toEqual([]);
  });

  /** Everything below is craft that cost real dogfood failures to learn and is NOT
   *  provider text. The negatives above are broad; these keep a future sweep from
   *  satisfying them by deleting the skill's substance. */
  it("keeps the decisions that must not move", () => {
    // The always-ask voice gate this skill owns on behalf of voiceover-production.
    expect(body).toMatch(/ALWAYS ASK first/);
    expect(collapse(body)).toContain("Reuse the voice from your source, or give the new creator a fresh voice?");
    // The face-leak guard: fresh edge frames, applied trim, read back, re-extract.
    expect(body).toMatch(/EXTRACT FRESH boundary frames/);
    expect(collapse(body)).toContain("RE-EXTRACT from the READ-BACK committed trim values");
    expect(body).toContain("libi.analysis_extract_frames");
    // Skin tone, delivery match, clean clause boundaries, the director's review.
    expect(body).toMatch(/skin tone \(non-negotiable\)/i);
    expect(body).toMatch(/Match the source's speaking DELIVERY/);
    expect(collapse(body)).toContain("natural sentence/clause boundaries");
    expect(body).toMatch(/^## Narrative continuity — the director's review \(HARD, final pass\)$/m);
    // …and the one-layer-per-beat invariant the whole skill exists for.
    expect(body).toMatch(/ONE full-frame video OVERLAY per beat/);
  });

  /** The cross-reference chase. `production-routes.md` describes THIS skill's voice gate
   *  to an agent that has not loaded it yet, so a vendor left there re-teaches exactly
   *  what the body just stopped saying. `voiceover-production`'s split genericised the
   *  Path C row and left the Path C bullet. */
  it("the pointers into this skill from other skills say what it now says", () => {
    const routes = read("ugc-product-video/prompts/production-routes.md");
    const paths = routes.match(/^ {2}- Audio routing is the `stitching-multi-clip`[^\n]*$/m);
    expect(paths, "the Path C audio-routing bullet moved").not.toBeNull();
    expect(paths![0]).not.toMatch(/elevenlabs/i);
    expect(paths![0]).toMatch(/a separate TTS voice only on an explicit voice-change/);
  });
});
