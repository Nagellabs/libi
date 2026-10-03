import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { mentionsSkill } from "../../helpers/skill-graph";

describe("local-tts install plan", () => {
  it("documents the download → mark-installed → generate flow", () => {
    const md = fs.readFileSync(
      path.resolve("mcp/bundled-mcps/plans/local-tts.md"),
      "utf-8",
    );
    expect(md).toContain("libi.tts_download_model");
    expect(md).toContain('update_dep_status({ mcpId: "local-tts"');
    expect(md).toContain("libi.generate_speech");
  });

  /** The plan is read on the `needs_install` path the `voice` provider gate sends a
   *  Kokoro-less agent down — including from the video craft skill's voice reference, where synthesizing a
   *  track over generated clips is the regression the skill exists to stop. So the plan
   *  says what a TTS track is NOT for, and the cloning fallback routes by KIND rather than
   *  naming a vendor as the thing to "use instead". */
  it("scopes what a synthesized track is for, and routes cloning by kind not by vendor", () => {
    const md = fs.readFileSync(
      path.resolve("mcp/bundled-mcps/plans/local-tts.md"),
      "utf-8",
    );
    expect(mentionsSkill(md, "video-generation-craft")).toBe(true);
    expect(mentionsSkill(md, "voice-replacement")).toBe(true);
    expect(md).toMatch(/never the\s+native audio of a video generation/);
    expect(md).toMatch(/## Voice cloning \/ branded voices/);
    expect(md).toMatch(/a `voice`\s+provider that offers one, on an MCP the user has connected themselves/);
    expect(md).toContain("`references/providers/<id>.md`");
    expect(md).not.toMatch(/use ElevenLabs instead/);
  });
});

describe("uv-backed install plans — the 'confirm uv' step is agent-executable", () => {
  for (const id of ["whisper", "local-tts", "local-music"]) {
    it(`${id}: reads uv from libi.get_install_plan's dependencies, never from a settings card`, () => {
      const md = fs.readFileSync(path.resolve(`mcp/bundled-mcps/plans/${id}.md`), "utf-8");
      const step = md.slice(md.indexOf("## 2. Confirm `uv`"), md.indexOf("## 3."));
      expect(step).toContain(`libi.get_install_plan({ mcpId: "${id}" })`);
      expect(step).toContain('binary: "uv"');
      expect(step).toContain(`libi.show({ target: "extension", extensionId: "${id}" })`);
      expect(step).not.toMatch(/check the .* card's dependencies/);
      expect(step).not.toMatch(/tier-1/);
    });
  }
});
