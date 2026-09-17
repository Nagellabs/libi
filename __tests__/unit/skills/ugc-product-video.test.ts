import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parseSkillBody } from "@/mcp/skills/frontmatter";
import { writeSkillsToWorkspace } from "@/mcp/skills/writer";
import { getBundledSkillsDir } from "@/lib/libi-home";

const SKILL_NAME = "ugc-product-video";

/** The flat prompt files the refactored skill ships under prompts/.
 *  model-seedance-2.md, model-veo-3-1.md, and model-kling.md were moved to
 *  the shared ai-video-models skill (Task 1 of the skill-overrides plan). */
const EXPECTED_PROMPTS = [
  "ad-formats.md",
  "brief-intake.md",
  "copywriting-angles.md",
  "dialogue-gate.md",
  "forbidden-words.md",
  "model-seedance-2-feature-walkthrough.md",
  "model-seedance-2-premium-reveal.md",
  "model-seedance-2-product-hero.md",
  "model-seedance-2-studio-lookbook.md",
  "model-seedance-2-ugc.md",
  "platform-specs.md",
  "production-routes.md",
  "script-craft.md",
];

/** Provider references shipped under references/providers/. */
const EXPECTED_REFERENCES = ["providers/fal.md"];

const VENDOR_ID = /\b(fal-ai|bytedance|openai)\//;

function skillDir(): string {
  return path.join(getBundledSkillsDir(), SKILL_NAME);
}

function readTree(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) return;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = path.join(rel, entry.name);
      if (entry.isDirectory()) walk(childRel);
      else out.push(childRel);
    }
  };
  walk(".");
  return out.sort();
}

describe("ugc-product-video bundled skill (refactored structure)", () => {
  it("SKILL.md frontmatter parses with the required fields", () => {
    const raw = fs.readFileSync(path.join(skillDir(), "SKILL.md"), "utf-8");
    const { frontmatter, body } = parseSkillBody(raw);
    expect(frontmatter.name).toBe(SKILL_NAME);
    expect(frontmatter.description).toMatch(/UGC/i);
    // The description is what the agent reads in its skill list — it must not
    // re-advertise the model the split moved into the provider reference.
    expect(frontmatter.description).not.toMatch(/Seedance|Veo|Kling/i);
    expect(frontmatter.when_to_use).toMatch(/UGC|product ad|TikTok/);
    expect(body.length).toBeGreaterThan(500);
  });

  /** The budget is **400 router lines**, and it always was — the old constant just
   *  baked the gate's height into it as a literal 420, so growing the canonical gate spent
   *  this skill's router budget. The gate is inlined verbatim from
   *  `mcp/skills/_shared/provider-gate.md` into fourteen files; a maintainer editing it has
   *  no reason to expect a UGC router test to go red, which is exactly what adding the
   *  "status: none" routing line did (416 → 421 lines, over the literal). Deriving the
   *  gate's height from the canonical file separates the two budgets: the router is
   *  measured on its own prose. */
  const canonicalGateLines = (): number => {
    const canonical = fs.readFileSync(
      path.resolve(__dirname, "../../../mcp/skills/_shared/provider-gate.md"),
      "utf-8",
    );
    const heading = "## Provider gate — read this first";
    const marker = "so the chat shows the buttons to connect it.";
    const start = canonical.indexOf(heading);
    const end = canonical.indexOf(marker);
    expect(start, "canonical gate: no heading").toBeGreaterThan(-1);
    expect(end, "canonical gate: no closing marker").toBeGreaterThan(start);
    return canonical.slice(start, end + marker.length).split("\n").length;
  };

  it("SKILL.md is a thin router (<= 400 lines of router, gate excluded)", () => {
    // Deep craft still lives in prompts/. The router itself carries the stage map + the
    // storyboard-spine orchestration section (card=clip, the build mechanism) — core, not craft.
    const gateLines = canonicalGateLines();
    // Guard the guard: a derivation that silently returned 0 would restore the old
    // conflation without failing anything.
    expect(gateLines).toBeGreaterThan(10);
    const raw = fs.readFileSync(path.join(skillDir(), "SKILL.md"), "utf-8");
    const routerLines = raw.split("\n").length - gateLines;
    expect(routerLines, `router prose is ${routerLines} lines (gate is ${gateLines})`)
      .toBeLessThanOrEqual(400);
  });

  it("the fal reference marks Seedance 2.0 RECOMMENDED, with a staleness stamp", () => {
    const ref = fs.readFileSync(path.join(skillDir(), "references/providers/fal.md"), "utf-8");
    expect(ref).toMatch(/RECOMMENDED:\s*bytedance\/seedance-2\.0/);
    // Every written-down id in this set carries an "as of" — this one included.
    expect(ref).toMatch(/## The RECOMMENDED model \(maintainer-updated \d{4}-\d{2}-\d{2}\)/);
    // The family-vs-endpoint note travelled with it — the bare id 404s on fal.
    expect(ref).toContain("bytedance/seedance-2.0/image-to-video");
    expect(ref).toContain("bytedance/seedance-2.0/reference-to-video");
    expect(ref).toMatch(/passing the bare id \(no operation suffix\)[\s\S]{0,80}404s on fal/);
    // The reference must NOT claim to be the forkable write target — nothing can write here.
    expect(ref).toMatch(/no `libi\.\*` tool can write under\s+`references\/`/);
  });

  it("the tunable default is a vendor-free marker in the body; the id stays in the reference", () => {
    const md = fs.readFileSync(path.join(skillDir(), "SKILL.md"), "utf-8");
    // The shipped body names no vendor id, but DOES carry the one editable line.
    expect(md).not.toContain("bytedance/seedance-2.0");
    expect(md).not.toContain("recommend_model");
    expect(md).not.toContain("get_pricing");
    expect(md).toMatch(/RECOMMENDED_VIDEO_MODEL = provider-default\s+\(maintainer-updated \d{4}-\d{2}-\d{2}\)/);
    // `provider-default` is only meaningful if the reference marks something RECOMMENDED.
    const ref = fs.readFileSync(path.join(skillDir(), "references/providers/fal.md"), "utf-8");
    expect(ref).toMatch(/^RECOMMENDED: \S+$/m);
  });

  it("the fork instruction names the only write path that exists AND re-syncs", () => {
    const md = fs.readFileSync(path.join(skillDir(), "SKILL.md"), "utf-8");
    const fork = md.slice(md.indexOf("## Permanent-override (fork) instruction"));
    expect(fork).toContain("libi.fork_skill");
    // update_skill writes SKILL.md and calls syncSkillsToWorkspace(); nothing writes
    // references/, and a raw fs edit there never re-syncs. See update-skill-override.test.ts.
    expect(fork).toContain("libi.update_skill");
    expect(fork).toMatch(/RECOMMENDED_VIDEO_MODEL[\s\S]{0,120}`SKILL\.md`/);
    expect(fork).toMatch(/Never hand-edit anything under `references\/`/);
    expect(fork).toMatch(/libi\.add_skill_prompt[\s\S]{0,80}scoped to\s+`prompts\/`/);
    // It must NOT send the agent to references/ as the edit target any more.
    expect(fork).not.toMatch(/edit the `RECOMMENDED_VIDEO_MODEL` line[\s\S]{0,60}references\//);
  });

  it("production-routes keeps its route shape and defers ids", () => {
    const md = fs.readFileSync(path.join(skillDir(), "prompts/production-routes.md"), "utf-8");
    expect(md).toMatch(/Path A/);
    expect(md).toMatch(/Path E/);
    expect(md).not.toContain("fal-ai/wan/v2.2-14b/animate/replace");
    expect(md).not.toContain("fal-ai/veo3.1/fast/extend-video");
    expect(md).toContain("references/providers/");
  });

  it("the fal reference carries every route's endpoint id", () => {
    const ref = fs.readFileSync(path.join(skillDir(), "references/providers/fal.md"), "utf-8");
    for (const id of [
      "bytedance/seedance-2.0",
      "fal-ai/wan/v2.2-14b/animate/replace",
      "decart/lucy-restyle",
      "fal-ai/wan/v2.2-a14b/video-to-video",
      "fal-ai/veo3.1/fast/image-to-video",
      "fal-ai/veo3.1/fast/extend-video",
    ]) {
      expect(ref, `reference is missing ${id}`).toContain(id);
    }
  });

  it("the fal reference keeps every hard rule that moved with the ids", () => {
    const ref = fs.readFileSync(path.join(skillDir(), "references/providers/fal.md"), "utf-8");
    // Model verification tools (the body only says "your provider's tools").
    expect(ref).toContain("recommend_model");
    expect(ref).toContain("get_model_schema");
    expect(ref).toContain("get_pricing");
    // veo3.1/fast prompt-format warning (moved out of Path D step 3b).
    expect(ref).toMatch(/Fast ≠ full Veo 3\.1/);
    expect(ref).toMatch(/no_media_generated/);
    // Path D extend-support detection + the extend chain returning the FULL clip.
    expect(ref).toMatch(/only proven extend-capable model on fal/);
    expect(ref).toMatch(/\*extend\*[\s\S]{0,40}\*continue\*[\s\S]{0,40}\*video-to-video\*/);
    expect(ref).toMatch(/returns the full chain on every call/);
    // Polling + provenance (check_job / libi.sleep / provider: "fal").
    expect(ref).toContain("check_job");
    expect(ref).toMatch(/libi\.sleep\(\{ seconds: 20 \}\)/);
    expect(ref).toMatch(/provider:\s*"fal"/);
    // Never read FAL_KEY / curl fal storage — local files go through the fal MCP's upload tool.
    expect(ref).toMatch(/NEVER\s+read `FAL_KEY`/);
    // Music: the paid alternative's tool name.
    expect(ref).toContain("compose_music");
    // Cross-references by path, not by repetition.
    expect(ref).toContain("ai-asset-generation");
    expect(ref).toContain("ai-video-models");
    expect(ref).toContain("physical-action-video");
    // The FLF default id belongs to physical-action-video's reference — pointer only here,
    // so the id has exactly two homes instead of three (see the cross-reference guard).
    expect(ref).not.toContain("fal-ai/veo3.1/fast/first-last-frame-to-video");
  });

  it("no endpoint id or fal tool name survives in the body or any prompt file", () => {
    const files = ["SKILL.md", ...EXPECTED_PROMPTS.map((n) => path.join("prompts", n))];
    for (const rel of files) {
      const md = fs.readFileSync(path.join(skillDir(), rel), "utf-8");
      // One place for endpoint ids. (The MIT attribution comment says "fal-ai model ids"
      // with no slash, so it does not trip this — and it must stay byte-for-byte.)
      expect(md, `${rel} carries a vendor-prefixed endpoint id`).not.toMatch(VENDOR_ID);
      expect(md, `${rel} names decart/lucy-restyle`).not.toContain("decart/lucy-restyle");
      for (const tool of [
        "recommend_model",
        "get_pricing",
        "check_job",
        "submit_job",
        "run_model",
        "fal-ai.upload_file",
        "fal-ai.get_model_schema",
        "compose_music",
        "FAL_KEY",
      ]) {
        expect(md, `${rel} names ${tool}`).not.toContain(tool);
      }
    }
    // The gate's own tool-docs example is the one allowed get_model_schema mention.
    const routes = fs.readFileSync(path.join(skillDir(), "prompts/production-routes.md"), "utf-8");
    expect(routes).not.toContain("get_model_schema");
  });

  it("the provider gate is still the first section and the model policy survived", () => {
    const md = fs.readFileSync(path.join(skillDir(), "SKILL.md"), "utf-8");
    expect(md.indexOf("## Provider gate")).toBeLessThan(md.indexOf("## Recommended model"));
    expect(md).toMatch(/Honor explicit per-project overrides/);
    expect(md).toMatch(/Always verify the chosen model at runtime/);
    expect(md).toMatch(/libi\.fork_skill/);
    expect(md).toMatch(/RECOMMENDED_VIDEO_MODEL/); // named as the line to edit in the fork copy
    expect(md).toMatch(/Cost disclosure[\s\S]{0,200}references\/providers\/<id>\.md/);
  });

  it("ships all expected prompt files (flat, kebab-case)", () => {
    const dir = path.join(skillDir(), "prompts");
    for (const name of EXPECTED_PROMPTS) {
      expect(fs.existsSync(path.join(dir, name)), `missing prompts/${name}`).toBe(true);
      expect(/^[a-z0-9][a-z0-9-]*\.md$/.test(name), `bad name ${name}`).toBe(true);
    }
  });

  it("retired the legacy templates/ dir; references/ holds only provider references", () => {
    expect(fs.existsSync(path.join(skillDir(), "templates"))).toBe(false);
    const refs = readTree(path.join(skillDir(), "references"));
    expect(refs).toEqual(EXPECTED_REFERENCES.map((n) => path.join(".", n)).sort());
  });

  it("every prompts/ link in SKILL.md resolves to a real file", () => {
    const raw = fs.readFileSync(path.join(skillDir(), "SKILL.md"), "utf-8");
    const links = [...raw.matchAll(/\]\((prompts\/[a-z0-9-]+\.md)\)/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(fs.existsSync(path.join(skillDir(), link)), `broken link ${link}`).toBe(true);
    }
  });

  it("every Seedance use-case file carries the MIT attribution header", () => {
    const dir = path.join(skillDir(), "prompts");
    for (const name of EXPECTED_PROMPTS.filter((n) => n.startsWith("model-seedance-2"))) {
      const body = fs.readFileSync(path.join(dir, name), "utf-8");
      expect(body, `${name} missing attribution`).toMatch(/arcads-claude-code \(MIT/);
    }
  });

  let workspace: string;
  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ugc-write-"));
  });
  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("writer mirrors SKILL.md + every prompt file into .claude/skills", async () => {
    const dir = skillDir();
    const body = fs.readFileSync(path.join(dir, "SKILL.md"), "utf-8");
    const { frontmatter } = parseSkillBody(body);
    const supportingFiles = [
      ...EXPECTED_PROMPTS.map((name) => ({
        relPath: path.join("prompts", name),
        contents: fs.readFileSync(path.join(dir, "prompts", name), "utf-8"),
      })),
      ...EXPECTED_REFERENCES.map((name) => ({
        relPath: path.join("references", name),
        contents: fs.readFileSync(path.join(dir, "references", name), "utf-8"),
      })),
    ];

    await writeSkillsToWorkspace(workspace, [
      {
        id: SKILL_NAME,
        name: SKILL_NAME,
        description: frontmatter.description,
        source: "bundled",
        enabled: true,
        body,
        frontmatter,
        supportingFiles,
        tags: [],
      },
    ]);

    const tree = readTree(path.join(workspace, ".claude/skills", SKILL_NAME));
    const expected = [
      "SKILL.md",
      ...EXPECTED_PROMPTS.map((n) => path.join("prompts", n)),
      ...EXPECTED_REFERENCES.map((n) => path.join("references", n)),
    ].sort();
    expect(tree).toEqual(expected);

    // SKILL.md mirrored to the codex (.agents/skills) dialect too.
    expect(
      fs.readFileSync(path.join(workspace, ".agents/skills", SKILL_NAME, "SKILL.md"), "utf-8"),
    ).toContain("UGC Product Video");
  });
});
