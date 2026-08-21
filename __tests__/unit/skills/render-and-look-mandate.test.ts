import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseSkillBody } from "@/mcp/skills/frontmatter";

// A real 42-second piece (6 canvas scenes, 20 overlays, 501 tool calls) shipped
// with the brand mark overlapping its wordmark, a chip 90px too narrow for its
// text, and every text in a serif fallback — because none of the skills on the
// authoring path ever told the agent to render a frame and look. This test
// pins the fix: each authoring skill below must carry the "render and look"
// mandate, naming the exact tool + the two fields that make looking cheap and
// catch a silent font fallback.
const MANDATED_SKILL_PATHS = [
  "mcp/skills/animating-overlays/SKILL.md",
  "mcp/skills/animated-text-overlays/SKILL.md",
  "mcp/skills/generic-video/SKILL.md",
  "mcp/skills/using-storyboard/SKILL.md",
];

describe("render-and-look mandate", () => {
  for (const path of MANDATED_SKILL_PATHS) {
    describe(`skill: ${path}`, () => {
      const raw = readFileSync(path, "utf8");
      const { body } = parseSkillBody(raw);

      it("names the render_overlay_frames tool", () => {
        expect(body).toMatch(/render_overlay_frames/);
      });

      it("tells the agent to use contactSheet", () => {
        expect(body).toMatch(/contactSheet/);
      });

      it("tells the agent to check unresolvedFonts", () => {
        expect(body).toMatch(/unresolvedFonts/);
      });

      it("phrases the mandate as a required step, not optional advice", () => {
        expect(/## Look at what you made \(required\)/.test(body)).toBe(true);
        expect(/before you tell the\s+user it is done/.test(body)).toBe(true);
      });
    });
  }
});
