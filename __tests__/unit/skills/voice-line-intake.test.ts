import { describe, it, expect } from "vitest";
import fs from "fs";

/** A user got an AI ad "generated without audio": generate_audio was true, but nothing made the agent settle
 *  whether the clip has a spoken LINE. The skills' side of the fix (one question, owned by one skill, deferred to
 *  by the others) is an invariant in skill-invariants.test.ts. This keeps the manual's side: a bare clip request
 *  may never load a skill, so the manual's storyboard-first gate must ask too. */
describe("voice-line intake", () => {
  it("the manual's storyboard-first gate asks it too — a bare clip request may never load a skill", () => {
    const t = fs.readFileSync("mcp/templates/instructions.md", "utf8");
    expect(t).toMatch(/Ask once, before the first AI video generation: does it speak\?/);
    expect(t).toMatch(/libi\.generate_music/);
    expect(t).toMatch(/If nobody can[\s>]+answer/);
  });
});
