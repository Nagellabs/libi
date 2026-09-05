import { describe, it, expect } from "vitest";
import fs from "fs";

const read = (p: string) => fs.readFileSync(p, "utf8");

describe("length-policy guidance", () => {
  it.each([
    "mcp/skills/music-creation/SKILL.md",
    "mcp/skills/music-video-creation/SKILL.md",
  ])("%s tells the agent to ask before changing the piece's length", (p) => {
    const t = read(p);
    expect(t).toMatch(/lengthPolicy/);
    expect(t).toMatch(/longer than the piece|extend the piece/i);
  });

  it("the audio_add_clip tool description documents lengthPolicy", () => {
    expect(read("mcp/server.ts")).toMatch(
      /Add an audio clip to the composition[\s\S]{0,600}lengthPolicy/,
    );
  });
});
