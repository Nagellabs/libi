import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { BUNDLED_SKILLS } from "@/mcp/skills/registry";

/**
 * Plumbing + wording guard for the bundled `social-posting` skill.
 *
 * Every needle here is a line whose ABSENCE has a cost the user pays:
 *
 *  - the wire names are snake_case and the tools are
 *    `additionalProperties: false`, so a skill that teaches `isDraft` or a
 *    `headers` argument makes the agent fail EVERY write with a pydantic
 *    error and no post created (verified live 2026-09-20,
 *    `.superpowers/sdd/zernio-live-shapes.md`);
 *  - the curated tools answer PROSE, so an agent that reaches for
 *    `posts_create` loses `metadata`, `tiktok_settings` and
 *    `platformSpecificData` silently;
 *  - publishing on Instagram and TikTok is irreversible, so "draft only"
 *    and "explicit yes" are the two sentences that keep a mistake recoverable.
 *
 * Behaviour (the agent actually doing these things) is the skill-eval
 * scenarios' job — `skill-eval/scenarios/social-posting/`. This file proves
 * the skill exists, is registered, and still says the words.
 */
const dir = path.join(process.cwd(), "mcp", "skills", "social-posting");
const read = (rel: string): string => fs.readFileSync(path.join(dir, rel), "utf-8");
const skill = read("SKILL.md");

describe("social-posting skill", () => {
  it("is registered and carries the two-field frontmatter", () => {
    expect(BUNDLED_SKILLS.some((s) => s.id === "social-posting")).toBe(true);
    expect(BUNDLED_SKILLS.some((s) => s.name === "social-posting")).toBe(true);
    expect(skill).toMatch(/^---\nname: social-posting\ndescription: .+\n---/);
  });

  it("pins the libi tools and the provider tools it must use", () => {
    for (const line of [
      "libi.social_status",
      "libi.post_piece",
      "libi.social_link_post",
      "libi.suggest_provider",
      "posts_create_post",
      "posts_update_post",
      "call_tool",
      "search_tools",
      "accounts_get_tik_tok_creator_info",
      "media_get_media_presigned_url",
      "validate_post",
    ]) {
      expect(skill, line).toContain(line);
    }
  });

  it("pins the hard lines", () => {
    for (const line of [
      // Never the lossy convenience tools.
      "never `posts_create`",
      // The wire really is snake_case; `isDraft` at the top level is rejected.
      "is_draft",
      "media_items",
      "tiktok_settings",
      "dry_run",
      // The stamp that makes a post findable from the piece.
      "metadata.libi",
      "metadata.libi.requestId",
      // `mediaUrl` belongs in the SAME stamp list. Telling the agent to keep
      // the upload's own URL while leaving it out of the stamp manufactures
      // the exact state where libi's composer has only the provider-echoed
      // URL to re-send on an edit of a linked, agent-made post.
      "requestId, mediaUrl",
      // The header slot that does NOT exist.
      "x-request-id",
      // Ads.
      "budget",
    ]) {
      expect(skill, line).toContain(line);
    }
    // The idempotency header is named ONLY to say it is unreachable.
    expect(skill).toMatch(/x-request-id[^\n]*\n?[^\n]*(does not exist|is not reachable|rejected)/i);
    expect(skill).toMatch(/no `?headers`? argument/i);
    // camelCase at the top level of a write body is a rejected call.
    expect(skill).toMatch(/camelCase/i);
    // The two promises the user is owed.
    expect(skill).toMatch(/never ask (the user )?for (a|an API) key/i);
    expect(skill).toMatch(/explicit(ly)? (yes|approv)/i);
    // post_piece cannot publish — the agent must not imply otherwise.
    expect(skill).toMatch(/cannot publish|never publishes/i);
    // The two connections are separate.
    expect(skill).toMatch(/libiConnected/);
  });

  it("does not inline the generation provider gate (its gate is social_status)", () => {
    expect(skill).not.toContain("## Provider gate — read this first");
  });

  it("platform references carry the verified limits", () => {
    const tiktok = read("references/platforms/tiktok.md");
    const instagram = read("references/platforms/instagram.md");
    expect(tiktok).toMatch(/600 s|10 min/);
    expect(tiktok).toContain("PUBLIC_TO_EVERYONE");
    expect(tiktok).toContain("dry_run");
    expect(instagram).toMatch(/90 s/);
    expect(instagram).toContain("platformSpecificData");
    // Neither platform has a private/unlisted rehearsal mode on this account.
    expect(tiktok).toMatch(/no (safe )?rehearsal|no private/i);
  });

  it("the provider reference records the idempotency contract and the media-URL trap", () => {
    const zernio = read("references/providers/zernio.md");
    expect(zernio).toContain("metadata.libi.requestId");
    expect(zernio).toContain("additionalProperties: false");
    expect(zernio).toMatch(/never re-send|the URL the provider/i);
    expect(zernio).toContain("posts_list_posts");
  });
});
