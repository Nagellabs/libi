/**
 * Structural facts about the whole bundled skill graph that must hold however the prose is worded:
 * what a skill points at exists, the registry matches the folders, and provider specifics stay in
 * the provider layer. Nothing here pins a sentence.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BUNDLED_SKILLS } from "@/mcp/skills/registry";
import { writeSkillsToWorkspace } from "@/mcp/skills/writer";
import { ENDPOINT_VENDORS } from "@/scripts/skill-eval/audit-endpoints";
import {
  REPO_ROOT,
  SKILLS_DIR,
  knownSkillNames,
  libiToolMentions,
  loadSkillGraph,
  mentionsSkill,
  registeredLibiTools,
  skillIds,
  type SkillFile,
} from "../../helpers/skill-graph";

const graph = loadSkillGraph();

/** Every markdown file under every skill, with its skill id. */
const allFiles: Array<SkillFile & { skill: string; path: string }> = [...graph.values()].flatMap((s) =>
  s.files.map((f) => ({ ...f, skill: s.id, path: `${s.id}/${f.rel}` })),
);

/** A provider reference: describes ONE provider's tools and ids, so it may name them. */
const isProviderRef = (f: { rel: string }) => f.rel.startsWith("references/providers/");

/** A per-model prompt guide declares itself in frontmatter; it describes one vendor's model. */
const isModelGuide = (text: string): boolean =>
  /^---\n(?:[^\n]*\n)*?prompt_kind:\s*model-guide\s*\n(?:[^\n]*\n)*?---\n/.test(text);

/** Where vendor specifics are allowed to live. */
const vendorLayer = (f: { rel: string; text: string }) => isProviderRef(f) || isModelGuide(f.text);

describe("skills name only tools that exist", () => {
  const registered = registeredLibiTools();

  it("the tool registry parse found a real surface", () => {
    expect(registered.size).toBeGreaterThan(100);
    expect(registered.has("libi.read_manual")).toBe(true);
  });

  it("every libi.<tool> named anywhere under mcp/skills is a registered tool", () => {
    const offenders: string[] = [];
    for (const f of allFiles) {
      for (const tool of new Set(libiToolMentions(f.text))) {
        if (!registered.has(tool)) offenders.push(`${f.path} → ${tool}`);
      }
    }
    expect(offenders, `skills name tools that are not registered:\n${offenders.join("\n")}`).toEqual([]);
  });

  /** Tools no bundled skill or install plan may mention any more. New removals get appended, so this only grows. */
  const REMOVED_TOOLS = [
    "libi.list_bundled_mcps",
    "libi.show_api_config",
    "libi.list_mcp_servers",
    "libi.upload_file_to_fal",
    "libi.extra_analysis_model",
    "libi.refine_track_with_sam2",
    "libi.compute_object_track_providers",
    "libi.elevenlabs_transcribe_audio_override",
    "libi.show_mcp_settings",
  ];

  it("no skill or install plan mentions a removed tool", () => {
    const plans = path.join(REPO_ROOT, "mcp/bundled-mcps/plans");
    const texts: Array<[string, string]> = allFiles.map((f) => [f.path, f.text]);
    for (const name of fs.readdirSync(plans)) {
      if (name.endsWith(".md")) texts.push([`plans/${name}`, fs.readFileSync(path.join(plans, name), "utf8")]);
    }
    const offenders = texts.flatMap(([where, text]) =>
      REMOVED_TOOLS.filter((t) => text.includes(t)).map((t) => `${where} → ${t}`),
    );
    expect(offenders, `removed tools still referenced:\n${offenders.join("\n")}`).toEqual([]);
  });
});

describe("skills point at things that exist", () => {
  it("the registry and the skill folders agree", () => {
    const registered = BUNDLED_SKILLS.map((s) => s.id).sort();
    expect(registered).toEqual(skillIds());
    for (const s of BUNDLED_SKILLS) expect(s.name, `${s.id}: registry name differs from its id`).toBe(s.id);
  });

  it("the frontmatter description is the whole trigger: no `when_to_use` (Codex reads name + description only), at most 400 characters", () => {
    const offenders: string[] = [];
    for (const s of graph.values()) {
      if ("when_to_use" in s.frontmatter && s.frontmatter.when_to_use) offenders.push(`${s.id}: trigger text in when_to_use, which Codex never sees`);
      if (s.frontmatter.description.length > 400) offenders.push(`${s.id}: description is ${s.frontmatter.description.length} characters`);
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("a backticked skill name in any skill file is a skill that still exists", () => {
    const live = new Set(skillIds());
    const known = new Set(knownSkillNames());
    const offenders: string[] = [];
    for (const f of allFiles) {
      for (const m of f.text.matchAll(/`([a-z][a-z0-9]*(?:-[a-z0-9]+)+)`/g)) {
        const name = m[1];
        if (known.has(name) && !live.has(name)) offenders.push(`${f.path} → \`${name}\``);
      }
    }
    expect(offenders, `dangling skill references (a merged or removed skill):\n${offenders.join("\n")}`).toEqual([]);
  });

  it("every relative markdown link in a skill file resolves", () => {
    const broken: string[] = [];
    for (const s of graph.values()) {
      for (const f of s.files) {
        for (const m of f.text.matchAll(/\]\((\.{0,2}\/?[^)#\s]+\.md)(?:#[^)]*)?\)/g)) {
          const target = m[1];
          if (/^https?:/.test(target) || target.includes("docs-local/")) continue;
          const abs = path.resolve(s.dir, path.dirname(f.rel), target);
          if (!fs.existsSync(abs)) broken.push(`${s.id}/${f.rel} → ${target}`);
        }
      }
    }
    expect(broken, `dead links:\n${broken.join("\n")}`).toEqual([]);
  });

  it("a skill that points at `references/providers/<id>.md` under itself ships a providers folder", () => {
    const offenders: string[] = [];
    for (const s of graph.values()) {
      const text = s.body.replace(/\s+/g, " ");
      if (!/references\/providers\/<id>\.md`?.{0,120}under this skill/.test(text)) continue;
      // The gate's own sentence is conditional ("If this skill ships a reference for it"), so a skill that
      // ships none is only an offender when it claims one elsewhere.
      if (!fs.existsSync(path.join(s.dir, "references", "providers"))) {
        const claims = /references\/providers\/<id>\.md`? (under this skill )?(names|carries|holds)/.test(text);
        if (claims) offenders.push(s.id);
      }
    }
    expect(offenders, `claims a provider reference it does not ship:\n${offenders.join("\n")}`).toEqual([]);
  });
});

describe("provider specifics stay in the provider layer", () => {
  const endpointRe = new RegExp(`\\b(?:${ENDPOINT_VENDORS.join("|")})/[a-zA-Z0-9/_.-]+`);

  it("no skill body, prompt or reference outside the provider layer carries a vendor-prefixed endpoint id", () => {
    // `fal-ai/video-understanding` still sits in two SKILL.md bodies; K6 moves it into a provider reference.
    // Delete this allowance then (skill-hygiene.test.ts has the strict form, enabled by K6).
    const UNTIL_K6 = new Set(["fal-ai/video-understanding"]);
    const offenders = allFiles
      .filter((f) => !vendorLayer(f))
      .flatMap((f) => {
        const hits = [...f.text.matchAll(new RegExp(endpointRe, "g"))].map((m) => m[0]).filter((h) => !UNTIL_K6.has(h));
        return hits.length ? [`${f.path} → ${hits[0]}`] : [];
      });
    expect(offenders, `vendor endpoint ids outside references/providers or a model guide:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("no skill file recommends a provider on libi's behalf", () => {
    // PROVIDER_CATALOG carries no "recommended" flag for any remote provider; a skill that says otherwise
    // re-teaches a claim the product does not make.
    const offenders = allFiles.filter((f) => /\blibi recommends\b/i.test(f.text)).map((f) => f.path);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("no skill file reads or sets a provider key", () => {
    // Keys live in the provider's own MCP. A skill may name FAL_KEY only to forbid reading it.
    const offenders: string[] = [];
    for (const f of allFiles) {
      const text = f.text.replace(/\s+/g, " ");
      for (const m of text.matchAll(/\b(FAL_KEY|ELEVENLABS_API_KEY)\b/g)) {
        const before = text.slice(Math.max(0, m.index! - 160), m.index);
        if (!/(never|do not|don't|not)\b/i.test(before)) offenders.push(`${f.path} → …${before.slice(-60)}${m[0]}`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("provider call tools (recommend_model, get_pricing, submit_job, check_job, run_model) are named only in provider references", () => {
    const re = /\b(recommend_model|get_pricing|submit_job|check_job|run_model|compose_music)\b|fal-ai\.upload_file/;
    const offenders = allFiles.filter((f) => !vendorLayer(f) && re.test(f.text)).map((f) => `${f.path} → ${re.exec(f.text)![0]}`);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  /**
   * Skills that route by KIND must name no remote vendor in their own prose. Entries scan the skill's SKILL.md
   * and its non-provider files while the folder exists; `extra` are files the content moves to in a merge.
   */
  const VENDORS = /elevenlabs|fal-ai|fal\.ai|\bfal\b|higgsfield/i;
  const MODELS = /\b(seedance|veo|kling|wan|lucy|ace-step|kokoro)\b/i;
  const VENDOR_FREE: ReadonlyArray<{ skill: string; also?: RegExp; extra?: string[] }> = [
    { skill: "voice-replacement" },
    { skill: "music-creation" },
    { skill: "music-video-creation" },
    { skill: "audio-analysis" },
    { skill: "stitching-multi-clip", also: MODELS },
    // where the merged content lands (voiceover-production -> voice.md, ugc-craft -> craft.md)
    { skill: "video-generation-craft", extra: ["references/voice.md"] },
    { skill: "ugc-product-video", extra: ["references/craft.md"], also: MODELS },
  ];

  it.each(VENDOR_FREE.map((v) => [v.skill, v] as const))("%s names no remote vendor in its own prose", (_skill, v) => {
    const node = graph.get(v.skill);
    if (!node) return; // merged away or not yet created: nothing to scan
    const files = v.extra
      ? node.files.filter((f) => v.extra!.includes(f.rel))
      : node.files.filter((f) => !vendorLayer(f));
    const offenders: string[] = [];
    for (const f of files) {
      const text = f.text;
      const hit = VENDORS.exec(text) ?? (v.also ? v.also.exec(text) : null);
      if (hit) offenders.push(`${v.skill}/${f.rel} → "${hit[0]}"`);
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("frontmatter descriptions name no vendor or model", () => {
    const re = /seedance|veo\b|kling|elevenlabs|fal-ai|fal\.ai|\bfal\b|bria|birefnet|lucy|latentsync|sync-lipsync/i;
    const offenders: string[] = [];
    for (const s of graph.values()) {
      const fm = re.exec(s.frontmatter.description);
      if (fm) offenders.push(`${s.id} frontmatter → ${fm[0]}`);
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("no routing or craft prompt guide names a provider vendor (only per-model guides may)", () => {
    const re = /\bfal\b|fal-ai|fal\.ai|elevenlabs|higgsfield/i;
    const offenders = allFiles
      .filter((f) => f.rel.startsWith("prompts/") && !isModelGuide(f.text) && re.test(f.text))
      .map((f) => `${f.path} → ${re.exec(f.text)![0]}`);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  // The defect behind this rule: a Seedance guide offering "fall back to a single ElevenLabs VO" as the opt-in
  // fallback, attributed to a skill that had stopped saying it. Voice routing belongs to the voice skills and their
  // references, so it holds for the per-model guides too, which the vendor rule above exempts.
  it("no prompt guide — a per-model guide included — names a remote voice vendor or offers a separate-voice fallback", () => {
    const offenders = allFiles
      .filter((f) => f.rel.startsWith("prompts/"))
      .flatMap((f) => {
        const hit = /elevenlabs/i.exec(f.text) ?? /fall back to a single [\w ]*VO/i.exec(f.text);
        return hit ? [`${f.path} → ${hit[0]}`] : [];
      });
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("every provider reference opens by naming its provider", () => {
    const refs = allFiles.filter(isProviderRef);
    expect(refs.length).toBeGreaterThanOrEqual(8);
    for (const f of refs) {
      const provider = path.basename(f.rel, ".md");
      const h1 = f.text.split("\n").find((l) => l.startsWith("# ")) ?? "";
      expect(h1.toLowerCase(), `${f.path}: H1 does not name "${provider}"`).toContain(provider.toLowerCase());
    }
  });

  it("no provider reference promises a token is 'not repeated here' and then repeats it", () => {
    const offenders: string[] = [];
    for (const f of allFiles.filter(isProviderRef)) {
      const paras = f.text.split(/\n\s*\n/);
      const i = paras.findIndex((p) => p.includes("not repeated here"));
      if (i === -1) continue;
      const rest = paras.slice(i + 1).join("\n");
      for (const tok of paras[i].match(/`[a-zA-Z_][a-zA-Z0-9_.]*`/g) ?? []) {
        const bare = tok.slice(1, -1);
        if (bare.includes("/") || bare.endsWith(".md")) continue;
        if (rest.includes(bare)) offenders.push(`${f.path} → ${bare}`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("per-model guides declare themselves, name their model, and are named model-*", () => {
    for (const f of allFiles.filter((x) => isModelGuide(x.text))) {
      expect(path.basename(f.rel), `${f.path} is marked but is not a model- guide`).toMatch(/^model-/);
      expect(f.text, `${f.path} is marked but declares no model`).toMatch(/^model:\s*\S.*$/m);
    }
  });

  it("the OLD local ElevenLabs server's tool names appear only in one fallback paragraph per reference", () => {
    const OLD_TOOLS = /\b(text_to_speech|compose_music|text_to_sound_effects|speech_to_speech|speech_to_text|isolate_audio|voice_clone)\b/;
    const refs = allFiles.filter((f) => isProviderRef(f) && path.basename(f.rel) === "elevenlabs.md");
    expect(refs.length).toBeGreaterThanOrEqual(3);
    for (const f of refs) {
      const naming = f.text.split(/\n\s*\n/).filter((p) => OLD_TOOLS.test(p));
      for (const p of naming) expect(p, f.path).toMatch(/older local server/);
      expect(naming.length, f.path).toBeLessThanOrEqual(1);
      expect(f.text, `${f.path} names fields the hosted server does not return`).not.toMatch(
        /output_url|estimated_credits|canvas_url/,
      );
    }
  });
});

describe("install plans and the registry agree with the skills", () => {
  const plan = (name: string) => fs.readFileSync(path.join(REPO_ROOT, "mcp/bundled-mcps/plans", `${name}.md`), "utf8");

  it("whisper's plan routes diarization by kind (to the agent's own STT), never by vendor", () => {
    const md = plan("whisper");
    expect(md).not.toMatch(/elevenlabs/i);
    expect(md).not.toMatch(/suggest_provider\(\{ kind: "transcription", reason:/);
    expect(mentionsSkill(md, "audio-analysis")).toBe(true);
    expect(md).toMatch(/does not label speakers|diariz/i);
  });

  it("the local-tts plan points at the voice skills and never tells the agent to use a vendor instead", () => {
    const md = plan("local-tts");
    expect(mentionsSkill(md, "voice-replacement")).toBe(true);
    expect(md).not.toMatch(/use ElevenLabs instead/);
  });

  it("the extension registry carries no instruction for a tool that does not exist", () => {
    const registry = fs.readFileSync(path.join(REPO_ROOT, "mcp/registry/bundled.ts"), "utf8");
    expect(registry).not.toContain("elevenlabs_transcribe_audio_override");
  });
});

describe("the writer mirrors every bundled skill's whole folder", () => {
  it("SKILL.md plus every supporting file lands in both dialect trees", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "skills-mirror-"));
    try {
      const skills = [...graph.values()].map((s) => ({
        id: s.id,
        name: s.id,
        description: s.frontmatter.description,
        source: "bundled" as const,
        enabled: true,
        body: s.skillMd,
        frontmatter: s.frontmatter,
        supportingFiles: s.files
          .filter((f) => f.rel !== "SKILL.md")
          .map((f) => ({ relPath: f.rel, contents: f.text })),
        tags: [],
      }));
      await writeSkillsToWorkspace(workspace, skills);
      for (const s of graph.values()) {
        for (const dialect of [".claude/skills", ".agents/skills"]) {
          for (const f of s.files) {
            expect(
              fs.existsSync(path.join(workspace, dialect, s.id, f.rel)),
              `${dialect}/${s.id}/${f.rel} was not written`,
            ).toBe(true);
          }
        }
      }
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});

// Keep SKILLS_DIR referenced so a move of the skills folder fails loudly here rather than silently emptying the graph.
describe("the graph is not empty", () => {
  it("loads the bundled skills", () => {
    expect(fs.existsSync(SKILLS_DIR)).toBe(true);
    expect(skillIds().length).toBeGreaterThan(20);
    expect(allFiles.length).toBeGreaterThan(60);
  });
});
