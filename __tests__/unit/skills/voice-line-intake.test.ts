import { describe, it, expect } from "vitest";
import fs from "fs";

const read = (p: string) => fs.readFileSync(p, "utf8");

/** A user got an AI ad "generated without audio": generate_audio was true, but no
 *  skill ever made the agent settle whether the clip has a spoken LINE, so the prompt
 *  carried no dialogue and the clip came back ambient-only. The fix is one intake
 *  question, owned by ai-asset-generation Step 6.6 and referenced by every skill that
 *  generates AI video. These assertions keep that wiring from drifting. */
describe("voice-line intake", () => {
  it("ai-asset-generation owns the question: a line, or no line + a music-bed offer", () => {
    const t = read("mcp/skills/ai-asset-generation/SKILL.md");
    expect(t).toMatch(/#### Voice-line intake — ask ONCE/);
    expect(t).toMatch(/Should it have a spoken line\?/);
    expect(t).toMatch(/Want a music bed instead\?/);
    expect(t).toMatch(/libi\.generate_music/);
    expect(t).toMatch(/never ask again per clip/);
    // Native audio is not what the question toggles.
    expect(t).toMatch(/Native audio stays ON either way/);
  });

  it.each([
    "mcp/skills/using-storyboard/SKILL.md",
    "mcp/skills/generic-video/SKILL.md",
    "mcp/skills/voiceover-production/SKILL.md",
  ])("%s defers to the intake instead of re-deciding audio", (p) => {
    const t = read(p);
    expect(t).toMatch(/voice-line\s+intake/);
    expect(t).toMatch(/ai-asset-generation.*Step 6\.6/);
  });

  it("the manual's storyboard-first gate asks it too — a bare clip request may never load a skill", () => {
    const t = read("mcp/templates/instructions.md");
    expect(t).toMatch(/Ask once, before the first AI video generation: does it speak\?/);
    expect(t).toMatch(/libi\.generate_music/);
    expect(t).toMatch(/If nobody can[\s>]+answer/);
  });

  it("when nobody can answer, the default is a drafted line, never an ambient-only clip", () => {
    const t = read("mcp/skills/ai-asset-generation/SKILL.md");
    expect(t).toMatch(/If nobody can answer[\s\S]{0,200}spoken line drafted from the brief/);
    expect(t).toMatch(/narration fits ANY shot/);
  });

  it("the storyboard card's voiceover.line is the clip's dialogue", () => {
    const t = read("mcp/skills/using-storyboard/SKILL.md");
    expect(t).toMatch(/`voiceover\.line` is the clip\s+prompt's dialogue/);
  });

  it("generic-video offers the music bed when there is no line", () => {
    expect(read("mcp/skills/generic-video/SKILL.md")).toMatch(/no line, offer a music bed/);
  });
});
