import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { BUNDLED_SKILLS } from "@/mcp/skills/registry";

/** Plumbing + wording guard for `social-music`. Behaviour is the scenarios' job
 *  (skill-eval/scenarios/social-music/); this proves the skill exists, is
 *  registered, and still says the lines whose absence costs the user. */
const skillPath = path.join(process.cwd(), "mcp", "skills", "social-music", "SKILL.md");
const skill = fs.existsSync(skillPath) ? fs.readFileSync(skillPath, "utf-8") : "";

describe("social-music skill", () => {
  it("is registered with the two-field frontmatter", () => {
    expect(BUNDLED_SKILLS.some((s) => s.id === "social-music" && s.name === "social-music")).toBe(true);
    expect(skill).toMatch(/^---\nname: social-music\ndescription: .+\n---/);
  });

  it("names the libi tools and the provider tools it relies on", () => {
    for (const needle of [
      "libi.set_audio_rights", "libi.export_video", "libi.post_piece", "libi.social_music_search", "libi.fetch_template_music",
      "libi.get_piece_state", "purpose", "accounts_list_tik_tok_commercial_music", "instagram_search_instagram_audio",
      "instagram_get_instagram_audio", "instagram_audio_requires_facebook_login", "musicSoundInfo", "audioConfiguration",
    ]) expect(skill).toContain(needle);
  });

  it("keeps the rules that protect the user", () => {
    expect(skill).toContain("Never set `owned`");
    expect(skill).toContain("Relay every target's `plan.sentence`");
    expect(skill).toContain("only after the user says yes");
    expect(skill).toContain("never `commercialMusicId`");
    expect(skill).toContain("ignored on drafts");
  });

  it("passes the song's rights on audio_add_clip and relays only reported matches", () => {
    expect(skill).toContain('rights: { class: "copyrighted", track: { title, artist } }');
    expect(skill).toContain("music.summary");
    expect(skill).toContain("Never claim a match the result didn't report");
  });

  it("relays set_audio_rights' own match result, and re-adds without rights after a user_decided refusal", () => {
    expect(skill).toContain("relay the `music`\n  result `libi.set_audio_rights` returns");
    expect(skill).toContain("never claim a match\n  it didn't report");
    expect(skill).toContain("add the clip again without `rights`");
  });

  it("is pointed at from social-posting, music-creation and templates", () => {
    for (const s of ["social-posting", "music-creation", "templates"]) {
      expect(fs.readFileSync(path.join(process.cwd(), "mcp", "skills", s, "SKILL.md"), "utf-8")).toContain("`social-music`");
    }
  });
});
