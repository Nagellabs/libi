import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { BUNDLED_SKILLS } from "@/mcp/skills/registry";

/**
 * Plumbing + wording guard for the bundled `browser-posting` skill.
 *
 * Each needle is a line learned on a real TikTok post (2026-10-02) whose absence costs the user:
 *
 *  - TikTok turns Duet/Stitch off and its song clips end at 1:00 above 60 s — a 60.2 s cut lost
 *    both, so the skill defaults to 59 s;
 *  - the "social" export leaves the copyrighted song OUT; posting it without adding TikTok's copy
 *    published a video whose intro was silent;
 *  - Claude in Chrome caps an upload at 10 MB, and Playwright MCP reads files only inside its
 *    workspace roots — the two dead ends before the path that worked;
 *  - Instagram's web uploader has no music, so the browser is never the Instagram route;
 *  - TikTok has no undo: Post only on the user's yes, never typing a credential.
 *
 * Behaviour is the skill-eval scenarios' job (`skill-eval/scenarios/browser-posting/`).
 */
const dir = path.join(process.cwd(), "mcp", "skills", "browser-posting");
const read = (rel: string): string => fs.readFileSync(path.join(dir, rel), "utf-8");
const skill = read("SKILL.md");
const studio = read("references/tiktok-studio.md");

describe("browser-posting skill", () => {
  it("is registered and carries the two-field frontmatter", () => {
    expect(BUNDLED_SKILLS.some((s) => s.id === "browser-posting")).toBe(true);
    expect(skill).toMatch(/^---\nname: browser-posting\ndescription: .+\n---/);
  });

  it("routes TikTok-with-music to the browser and Instagram to the API", () => {
    expect(skill).toMatch(/\*\*TikTok\*\* \| yes \| \*\*this skill\*\* \(browser\)/);
    expect(skill).toMatch(/\*\*Instagram\*\* \| either \| \*\*`social-posting` \(API\)\*\*/);
    expect(skill).toMatch(/Instagram's web uploader has \*\*no music picker\*\*/);
    expect(skill).toMatch(/phone-emulator path/);
  });

  it("defaults to 59 s and says what goes away above 60 s", () => {
    expect(skill).toMatch(/Default length ≤ 59\.9 s; aim for 59 s/);
    expect(skill).toMatch(/Duet and Stitch not available for videos over 60s/);
    expect(skill).toMatch(/at most \*\*1:00\*\*/);
  });

  it("pins the post defaults the owner asked for", () => {
    for (const row of [
      "| Comment | **on** |",
      "| Reuse of content (Duet + Stitch) | **on**",
      '| Disclose post content | **on → "Your brand"**',
      "| AI-generated content | **on**",
      "| Who can see this post | **Everyone** |",
    ]) {
      expect(skill).toContain(row);
    }
  });

  it("never posts the without-song export bare, and adds the song from TikTok's library", () => {
    expect(skill).toMatch(/purpose: "social"/);
    expect(skill).toMatch(/Never post that file without\s+adding the song/);
    expect(skill).toMatch(/Verify by reopening Sounds/);
  });

  it("names the dead ends and the path rule", () => {
    expect(skill).toMatch(/caps\s+that at 10 MB/);
    expect(skill).toMatch(/`<cwd>\/\.playwright-mcp\/`/);
    expect(skill).toMatch(/libi does not add browser\s+tools to an agent/);
    // The hand-off is libi's provider card, never a printed command.
    expect(skill).toContain('`libi.suggest_provider({ kind: "browser" })`');
    expect(skill).toMatch(/do not print commands or edit any config/);
  });

  it("keeps the user in charge of Post, credentials and account settings", () => {
    expect(skill).toMatch(/Click Post only when the user says, for THIS post, "post it"/);
    expect(skill).toMatch(/Never type a password, a code or any credential yourself/);
    expect(skill).toMatch(/automatic content checks\*\* \(a first-upload prompt\)/);
    expect(skill).toMatch(/Never work around the refusal/);
  });

  it("ships the recipes the skill points at", () => {
    expect(skill).toContain("references/tiktok-studio.md");
    for (const needle of [
      "browser_file_upload",
      "await page.waitForTimeout(600);",
      "keyboard.type('#' + tag, { delay: 60 })",
      "label.Checkbox__root",
      "{ name: 'Sounds', exact: true }",
      ".AudioClip__root",
      "Videos with commercial content can only",
    ]) {
      expect(studio).toContain(needle);
    }
  });
});

describe("cross-references into browser-posting", () => {
  const skillsDir = path.join(process.cwd(), "mcp", "skills");
  it("social-posting and social-music send TikTok-with-music to it", () => {
    const posting = fs.readFileSync(path.join(skillsDir, "social-posting", "SKILL.md"), "utf-8");
    const music = fs.readFileSync(path.join(skillsDir, "social-music", "SKILL.md"), "utf-8");
    expect(posting).toContain("`browser-posting` skill");
    expect(music).toContain("`browser-posting` skill");
  });

  it("the manual's social-posting section names it", () => {
    const manual = fs.readFileSync(path.join(process.cwd(), "mcp", "templates", "instructions.md"), "utf-8");
    const section = manual.slice(manual.indexOf("## Social posting"), manual.indexOf("## Templates"));
    expect(section).toContain("`browser-posting` skill");
    expect(section).toMatch(/Instagram is never posted from the web/);
  });
});
