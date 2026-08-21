/**
 * The onboarding skill is the one piece of agent instruction every new user
 * hits. The two CDN URLs it used to carry were a first-run outage waiting to
 * happen; this asserts they are gone and cannot come back.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";

const SKILL = fs.readFileSync(
  "mcp/skills/onboarding-libi-explainer-short/SKILL.md",
  "utf8",
);

describe("onboarding-libi-explainer-short", () => {
  it("builds via the tool", () => {
    expect(SKILL).toContain("libi.build_onboarding_piece");
    expect(SKILL).toContain("libi.show_piece");
  });

  it("no longer depends on third-party CDNs", () => {
    expect(SKILL).not.toContain("samplelib.com");
    expect(SKILL).not.toContain("download.blender.org");
    expect(SKILL).not.toContain("Big Buck Bunny");
  });

  it("no longer hand-builds overlays", () => {
    expect(SKILL).not.toContain("libi.add_overlay");
    expect(SKILL).not.toContain("libi.apply_layer_effect");
    expect(SKILL).not.toContain("libi.import_remote_files");
  });

  it("sets the download expectation", () => {
    // The brief specified /66\s*MB/i. That number predates the re-encode and
    // is wrong: the manifest is 21 assets / 14,796,113 bytes, and the tool's
    // own description says ~15 MB. Asserting 66 would have forced the skill to
    // quote a size ~4x the real download to every new user. Corrected here and
    // called out in the task report rather than changed silently.
    expect(SKILL).toMatch(/15\s*MB/i);
    expect(SKILL).not.toMatch(/66\s*MB/i);
  });

  it("keeps the transparency close", () => {
    for (const point of [/pre-?made/i, /editable/i, /built in libi/i]) {
      expect(SKILL, String(point)).toMatch(point);
    }
  });

  it("is honest about the tracking shot", () => {
    // Slot D's reticle looks like libi tracking an object live. It is not: the
    // boxes were computed by libi's real object tracking once and baked into a
    // code overlay, because tracking provisions a local model the user has not
    // installed yet. All three halves of that have to be said — it is pre-made,
    // it WAS made with the real thing, and they can run it on their own footage.
    expect(SKILL).toMatch(/track/i);
    // `\s+` rather than a literal space: the phrase is bolded and wraps, so
    // the file holds "**pre-made\n  animation**".
    expect(SKILL).toMatch(/pre-?made\s+animation/i);
    expect(SKILL).toMatch(/real\s+object\s+tracking/i);
    expect(SKILL).toMatch(/their\s+own\s+footage/i);
    // …and the one thing it must NOT promise. There is no tracking settings
    // page; the model provisions on first use.
    expect(SKILL).not.toMatch(/settings\s*(→|->|>)?\s*tracking/i);
    expect(SKILL).not.toMatch(/enable (object )?tracking in settings/i);
  });

  it("does not restate the film's own numbers", () => {
    // The scene/overlay/audio counts and the runtime now come back from
    // `libi.build_onboarding_piece` as a `description` derived from the
    // definition. A copy here is a copy that a v2 recut makes wrong while
    // every test still passes — which is exactly what happened to the old
    // "6 scenes, 20 overlays and 15 audio clips" paragraph.
    const body = SKILL.slice(SKILL.indexOf("---", 4));
    expect(body).not.toMatch(/\b20 overlays\b/);
    expect(body).not.toMatch(/\b15 audio clips\b/);
    expect(body).not.toMatch(/\b6 scenes\b/);
    // …and it points at the field that replaced them.
    expect(body).toContain("description");
  });

  it("tells the agent what to do when the build fails", () => {
    expect(SKILL).toMatch(/could not|fail/i);
    expect(SKILL).toMatch(/what they want to make|what you want to make/i);
  });

  it("forbids a retry loop on failure", () => {
    // Added beyond the brief: a brand-new user watching an agent spin on
    // retries has already formed their opinion. "Do not retry" has to be in
    // the text, not merely implied by "a failed demo is not a dead end".
    expect(SKILL).toMatch(/do not (re-?try|call it again)|never retry/i);
    // …and it must be unconditional. The line above alone still passes on
    // "Do not retry more than twice", which is the exact instruction this
    // test exists to keep out. Matching on the BUDGET rather than on the
    // sentence shape keeps prose free while banning a retry allowance.
    expect(SKILL).not.toMatch(
      /retry\s+(?:it\s+|the\s+\w+\s+)?(?:more than|up to|at most|twice|once more|a few|two|three)\b/i,
    );
  });

  it("does not script a diagnosis the agent cannot make", () => {
    // Several failure modes are not downloads (piece creation, unknown
    // version, slug resolution, a cached failed/cancelled row, user cancel),
    // so the skill must not have the agent assert the cause or clear the
    // user's install in the one message a new user will remember.
    expect(SKILL).not.toMatch(/nothing is wrong with (their|your) install/i);
    expect(SKILL).not.toMatch(/it is a (download|network) problem/i);
  });

  it("keeps the cost expectation the old skill carried", () => {
    // The only place on the entire first-run path that says generation is
    // slower than this download and costs credits. Dropping it made the
    // rewrite less honest than the thing it replaced.
    expect(SKILL).toMatch(/credits/i);
  });

  it("keeps its frontmatter accurate", () => {
    // The description is what selects the skill; it must not still promise
    // two imported sample clips.
    const fm = SKILL.slice(0, SKILL.indexOf("---", 4));
    expect(fm).not.toContain("nature");
    expect(fm).not.toContain("animation");
  });
});
