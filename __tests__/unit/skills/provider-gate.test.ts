import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { getBundledSkillsDir } from "@/lib/libi-home";

/** Every generation skill opens with the provider gate: the agent checks its
 *  own tool list, follows a per-provider reference when one exists, and calls
 *  libi.suggest_provider + stops when it has nothing. A skill that grew a
 *  provider assumption above the gate fails here. */

const GATED: ReadonlyArray<[skill: string, kind: string]> = [
  ["ai-asset-generation", "image"],
  ["realistic-image-generation", "image"],
  ["ai-video-models", "video"],
  ["generic-video", "video"],
  ["physical-action-video", "video"],
  ["ugc-product-video", "video"],
  ["using-storyboard", "video"],
  ["removing-and-replacing-backgrounds", "video"],
  ["voice-replacement", "voice"],
  // `voiceover-production` used to be here on `voice` and is deliberately UNGATED now —
  // its real dependency is a VIDEO provider, it is not a standalone entry point, and the
  // four skills that load it all gate on `video` first. `recreate-skills.test.ts` guards
  // it against regrowing a gate, the same way it guards `stitching-multi-clip`.
  ["audio-analysis", "transcription"],
  ["music-creation", "music"],
  ["music-video-creation", "music"],
  ["video-analysis", "video"],
];

/** Tools no bundled skill may mention any more. New removals get appended here, so
 *  this list only ever grows and a re-introduced reference fails here. */
const REMOVED_TOOLS = [
  "libi.list_bundled_mcps",
  "libi.show_api_config",
  // Scrubbed from skill prose: the settings tab is no longer a place the
  // agent sends the user.
  "libi.list_mcp_servers",
  // renamed to `libi.show_extension` with the Agents page (2026-09-10)
  // libi holds no fal key, so the server-side upload proxy is gone; the
  // agent uploads through its own provider MCP's upload tool.
  "libi.upload_file_to_fal",
  // The one registered script provider ran on a libi-held fal key. The
  // agent now runs fal-ai/video-understanding on its own provider MCP and saves
  // through analysis_save_summary / analysis_update_summary_custom.
  "libi.extra_analysis_model",
  // The fal SAM2 tracking tools were removed outright — the local engine is
  // the only tracker, and libi's track store has no mask field to feed anyway.
  "libi.refine_track_with_sam2",
  "libi.compute_object_track_providers",
  // Never existed — the elevenlabs bundled def's agentInstructions told the
  // agent to call it anyway. transcription is Whisper-only on libi's side; a
  // diarized transcript goes through the agent's own STT via Path B.
  "libi.elevenlabs_transcribe_audio_override",
  "libi.show_mcp_settings",
];

function read(rel: string): string {
  return fs.readFileSync(path.join(getBundledSkillsDir(), rel), "utf-8");
}

function walkMd(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMd(p));
    else if (entry.name.endsWith(".md")) out.push(p);
  }
  return out;
}

describe("provider gate", () => {
  it.each(GATED)("%s opens with a %s provider gate", (skill, kind) => {
    const body = read(`${skill}/SKILL.md`);
    const heading = "## Provider gate — read this first";
    const gateStart = body.indexOf(heading);
    expect(gateStart, `${skill}: no gate heading`).toBeGreaterThan(-1);
    // The gate heading is the first non-blank line after the H1: not merely
    // the first "## " section, but with no prose, note or paragraph between.
    const lines = body.split("\n");
    const h1 = lines.findIndex((l) => l.startsWith("# "));
    expect(h1, `${skill}: no H1`).toBeGreaterThan(-1);
    const afterH1 = lines.slice(h1 + 1).find((l) => l.trim().length > 0);
    expect(afterH1, `${skill}: the gate must directly follow the H1`).toBe(heading);
    // Wide enough for the whole gate with room to grow: adding the "status: none" routing
    // line took it to ~1.9k, and a slice that ends mid-gate would silently stop asserting
    // its tail.
    const gate = body.slice(gateStart, gateStart + 3000);
    expect(gate).toContain(`libi.suggest_provider({ kind: "${kind}" })`);
    expect(gate).toContain("references/providers/<id>.md");
    expect(gate).toContain("Check your tool list");
    expect(gate).toContain("libi's own extension tools count as a provider");
    expect(gate).toContain(`no remote provider tool and no libi extension for ${kind}`);
    expect(gate).toMatch(/stop\**\./i);
    // `suggest_provider` answers `status: "none"` (with a `covered` list and no
    // card) when the agent already has everything the catalog knows of for this kind.
    // Before this line the gate never mentioned it, so the tool fix was inert: no skill
    // could route on it and the exits stayed hand-written.
    expect(gate).toContain('If it answers `status: "none"`, there is nothing to connect');
    expect(gate).toContain("`covered` list names it");
    expect(gate).toContain("Do not open anything or ask for a key");
    expect(gate).toContain(`everything libi knows of\n   for ${kind} is already connected or already installed`);
  });

  /** `mcp/bundled-mcps/plans/*.md` are agent-facing instructions read on the
   *  `needs_install` path — `local-music.md` is what told an agent to call
   *  `libi.show_mcp_settings` (now `libi.show_extension`) — but this scan only ever covered `mcp/skills/**`, so every
   *  removed-tool sweep on this branch had a hole exactly the size of the install plans.
   *  `walkMd` already recurses, so the per-skill `prompts` directories are
   *  covered by the skills root; the plans need their own root. */
  const scanRoots = (): string[] => [
    ...walkMd(getBundledSkillsDir()),
    ...walkMd(path.join(process.cwd(), "mcp/bundled-mcps/plans")),
  ];

  it("no bundled skill or install plan mentions a removed tool", () => {
    const offenders: string[] = [];
    for (const file of scanRoots()) {
      const text = fs.readFileSync(file, "utf-8");
      for (const tool of REMOVED_TOOLS) {
        if (text.includes(tool)) offenders.push(`${path.basename(path.dirname(file))}/${path.basename(file)} → ${tool}`);
      }
    }
    expect(offenders, `removed tools still referenced:\n${offenders.join("\n")}`).toEqual([]);
  });

  /** Five `ownProse` scans in `recreate-skills.test.ts` cut the gate out by
   *  `indexOf(heading)` … `indexOf(lastLine)` and then assume nothing skill-specific sits
   *  inside that span. The per-line `toContain` loop below pins the gate's CONTENT but
   *  neither its contiguity nor its order, so prose inserted INSIDE the gate block would
   *  pass every gate assertion and be invisible to all five scans at once. This makes the
   *  assumption a guarantee: the slice is byte-identical to the canonical template. */
  it("each inlined gate is byte-identical to the canonical template", () => {
    const canonical = fs.readFileSync(
      path.join(process.cwd(), "mcp/skills/_shared/provider-gate.md"),
      "utf-8",
    );
    const heading = "## Provider gate — read this first";
    const marker = "so the chat shows the buttons to connect it.";
    const template = canonical.slice(
      canonical.indexOf(heading),
      canonical.indexOf(marker) + marker.length,
    );
    for (const [skill, kind] of GATED) {
      const body = read(`${skill}/SKILL.md`);
      const slice = body.slice(body.indexOf(heading), body.indexOf(marker) + marker.length);
      expect(slice, `${skill}'s gate slice is not the canonical gate`).toBe(
        template.replace(/<kind>/g, kind),
      );
    }
  });

  it("the registry carries no instruction for a tool that does not exist", () => {
    const registry = fs.readFileSync(
      path.join(process.cwd(), "mcp/registry/bundled.ts"),
      "utf-8",
    );
    expect(registry).not.toContain("elevenlabs_transcribe_audio_override");
  });

  it("the canonical snippet and the inlined copies agree", () => {
    const canonical = fs.readFileSync(
      path.join(process.cwd(), "mcp/skills/_shared/provider-gate.md"),
      "utf-8",
    );
    // The canonical file is the template with <kind> unsubstituted. Its leading
    // HTML comment is maintainer guidance and is not part of the inlined text.
    const heading = "## Provider gate — read this first";
    expect(canonical).toContain(heading);
    expect(canonical).toContain("<kind>");
    const skeleton = canonical
      .slice(canonical.indexOf(heading))
      .replace(/<kind>/g, "KIND")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    for (const [skill, kind] of GATED) {
      const body = read(`${skill}/SKILL.md`);
      for (const line of skeleton) {
        const expected = line.replace(/KIND/g, kind);
        expect(body, `${skill} is missing gate line: ${expected}`).toContain(expected);
      }
    }
  });
});
