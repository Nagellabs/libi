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
    expect(frontmatter.when_to_use).toMatch(/UGC|product ad|TikTok/);
    expect(body.length).toBeGreaterThan(500);
  });

  it("SKILL.md is a thin router (<= 400 lines)", () => {
    // Deep craft still lives in prompts/. The router itself carries the stage map + the
    // storyboard-spine orchestration section (card=clip, the build mechanism) — core, not craft.
    const raw = fs.readFileSync(path.join(skillDir(), "SKILL.md"), "utf-8");
    expect(raw.split("\n").length).toBeLessThanOrEqual(400);
  });

  it("declares Seedance 2.0 as the recommended (forkable) model", () => {
    const raw = fs.readFileSync(path.join(skillDir(), "SKILL.md"), "utf-8");
    expect(raw).toMatch(/RECOMMENDED_VIDEO_MODEL\s*=\s*bytedance\/seedance-2\.0/);
  });

  it("ships all expected prompt files (flat, kebab-case)", () => {
    const dir = path.join(skillDir(), "prompts");
    for (const name of EXPECTED_PROMPTS) {
      expect(fs.existsSync(path.join(dir, name)), `missing prompts/${name}`).toBe(true);
      expect(/^[a-z0-9][a-z0-9-]*\.md$/.test(name), `bad name ${name}`).toBe(true);
    }
  });

  it("retired the legacy references/ and templates/ dirs", () => {
    expect(fs.existsSync(path.join(skillDir(), "references"))).toBe(false);
    expect(fs.existsSync(path.join(skillDir(), "templates"))).toBe(false);
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
    const supportingFiles = EXPECTED_PROMPTS.map((name) => ({
      relPath: path.join("prompts", name),
      contents: fs.readFileSync(path.join(dir, "prompts", name), "utf-8"),
    }));

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
    const expected = ["SKILL.md", ...EXPECTED_PROMPTS.map((n) => path.join("prompts", n))].sort();
    expect(tree).toEqual(expected);

    // SKILL.md mirrored to the codex (.agents/skills) dialect too.
    expect(
      fs.readFileSync(path.join(workspace, ".agents/skills", SKILL_NAME, "SKILL.md"), "utf-8"),
    ).toContain("UGC Product Video");
  });
});
