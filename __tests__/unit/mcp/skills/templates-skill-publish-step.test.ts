// __tests__/unit/mcp/skills/templates-skill-publish-step.test.ts
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SKILL = fs.readFileSync(path.resolve("mcp/skills/templates/SKILL.md"), "utf8");

describe("templates skill — publish step", () => {
  it("no longer defers publishing to a later sub-project", () => {
    expect(SKILL).not.toMatch(/Publishing arrives with the public catalog/);
  });
  it("asks private vs public, discloses what becomes public, offers to export the example, then calls publish_template", () => {
    expect(SKILL).toMatch(/private on this machine, or publish it to the public catalog/);
    expect(SKILL).toMatch(/anyone can use it/);
    expect(SKILL).toMatch(/nickname/);
    expect(SKILL).toMatch(/no private cloud option/);
    expect(SKILL).toMatch(/exportPieceId/);
    expect(SKILL).toMatch(/libi\.publish_template/);
  });
  // An agent can prepare a publish; only the user publishes, on the Templates page.
  // The disclosure comes first, then the call (which only prepares), then the
  // hand-off to the user — and the agent never claims it published.
  it("discloses, then prepares with publish_template, then tells the user to publish it themselves — never 'published'", () => {
    const create = SKILL.split("## Creating a template")[1].split("\n## ")[0];
    const disclosure = create.indexOf("no private cloud option");
    const call = create.indexOf("Call `libi.publish_template(");
    const handOff = create.indexOf("ready for THEM to\n     publish");
    expect(disclosure).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(disclosure);
    expect(handOff).toBeGreaterThan(call);
    expect(create).toContain("awaiting_your_confirmation");
    expect(create).toContain("Never say it is published");
    expect(create).toContain("it publishes NOTHING");
    // Everything the disclosure must name.
    for (const what of ["instructions", "overlays", "images", "fonts", "example video", "poster"]) expect(create.slice(disclosure - 600, disclosure), what).toContain(what);
  });
  // Publishing is invite-only: an unapproved creator is refused by the tool; the agent says so once, never pushes.
  it("step 5 explains the invite-only refusal once: Apply to publish on the Templates page, no nagging, no retry", () => {
    const start = SKILL.indexOf("5. **Always ask");
    const end = SKILL.indexOf("6. **Show it");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const step5 = SKILL.slice(start, end);
    expect(step5).toMatch(/invite-only/);
    expect(step5).toContain("Apply to publish");
    expect(step5).toMatch(/don't (push|ask again)/i);
    expect(step5).toMatch(/never retry/i);
    // Before the call's answer is handled: the rule sits with the disclosure, ahead of "Then, on their answer".
    expect(step5.indexOf("invite-only")).toBeLessThan(step5.indexOf("Then, on their answer"));
  });
});
