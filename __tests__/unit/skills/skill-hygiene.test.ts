/**
 * Authoring rules for bundled skills (skills-tools-tidy plan, "Global constraints" + skills audit §8).
 *
 * Every bundled skill must satisfy all of these: agent-neutral wording (no one harness's tool names),
 * no prices or "verified <date>" claims, no vendor endpoint ids in SKILL.md bodies (those belong in
 * references/providers/*), sparse ALL-CAPS, and trigger-only descriptions.
 */
import { describe, it, expect } from "vitest";
import { ENDPOINT_VENDORS } from "@/scripts/skill-eval/audit-endpoints";
import { loadSkillGraph, stripFrontmatter, type SkillNode } from "../../helpers/skill-graph";

const skills: SkillNode[] = [...loadSkillGraph().values()];


/** Prose without fenced code, for word-level metrics. */
const prose = (md: string) => stripFrontmatter(md).replace(/```[\s\S]*?```/g, "");

describe("skill hygiene — rules the skills already meet", () => {
  it.each(skills.map((s) => [s.id, s] as const))("%s: name matches its folder and a description exists", (_id, s) => {
    expect(s.frontmatter.name).toBe(s.id);
    expect(s.frontmatter.description.trim().length).toBeGreaterThan(0);
  });

  it("no SKILL.md is longer than 460 lines (the budget only ever goes down)", () => {
    const over = skills
      .map((s) => [s.id, s.skillMd.split("\n").length] as const)
      .filter(([, n]) => n > 460)
      .map(([id, n]) => `${id}: ${n} lines`);
    expect(over, over.join("\n")).toEqual([]);
  });

  it("no skill file names an agent model (skills must stay model-neutral)", () => {
    const offenders = skills.flatMap((s) =>
      s.files
        .filter((f) => /\b(claude[- ](opus|sonnet|haiku)|gpt-?5)\b/i.test(f.text))
        .map((f) => `${s.id}/${f.rel}`),
    );
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});

describe("skill hygiene", () => {
  it("frontmatter description is at most 400 characters (triggers, not a workflow summary)", () => {
    const over = skills
      .filter((s) => s.frontmatter.description.length > 400)
      .map((s) => `${s.id}: ${s.frontmatter.description.length}`);
    expect(over, over.join("\n")).toEqual([]);
  });

  it("no Claude-only harness tool names (TodoWrite, ScheduleWakeup, Skill tool, Read tool)", () => {
    const re = /\b(TodoWrite|ScheduleWakeup|Skill tool|Read tool)\b/;
    const offenders = skills.flatMap((s) =>
      s.files.filter((f) => re.test(f.text)).map((f) => `${s.id}/${f.rel} → ${re.exec(f.text)![0]}`),
    );
    expect(offenders, `describe the action in agent-neutral words:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("no prices or 'verified <date>' stamps in a SKILL.md body (a provider reference may name a default and how to verify it)", () => {
    const re = /\$\s?\d|\bverified\s+\d{4}-\d{2}|maintainer-updated\s+\d{4}-\d{2}/i;
    const offenders = skills.filter((s) => re.test(s.body)).map((s) => `${s.id} → ${re.exec(s.body)![0]}`);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("no vendor-prefixed endpoint id in any SKILL.md body (strict form: no allowance)", () => {
    const re = new RegExp(`\\b(?:${ENDPOINT_VENDORS.join("|")})/[a-zA-Z0-9/_.-]+`);
    const offenders = skills.filter((s) => re.test(s.body)).map((s) => `${s.id} → ${re.exec(s.body)![0]}`);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("no description (frontmatter or registry) names a vendor or model, except the engine guides", () => {
    const re = /seedance|veo\b|kling|elevenlabs|fal-ai|fal\.ai|\bfal\b|bria|birefnet|lucy|latentsync|sync-lipsync/i;
    const engine = new Set(["ai-video-models", "video-generation-craft"]);
    const offenders = skills
      .filter((s) => !engine.has(s.id) && re.test(s.frontmatter.description))
      .map((s) => `${s.id} → ${re.exec(s.frontmatter.description)![0]}`);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("no skill inlines the multi-step provider gate; a generating skill carries one line pointing at libi.suggest_provider", () => {
    const offenders = skills.filter((s) => /##\s*Provider gate\s*—\s*read this first/.test(s.body)).map((s) => s.id);
    expect(offenders, `the full gate lives in the core instructions + manual:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("no ALL-CAPS density: at most 1% of words in a SKILL.md are shouted", () => {
    const over = skills
      .map((s) => {
        const words = prose(s.skillMd).match(/[A-Za-z][A-Za-z']+/g) ?? [];
        const caps = words.filter((w) => w.length >= 4 && w === w.toUpperCase());
        return [s.id, words.length ? (caps.length / words.length) * 100 : 0] as const;
      })
      .filter(([, pct]) => pct > 1)
      .map(([id, pct]) => `${id}: ${pct.toFixed(2)}%`);
    expect(over, over.join("\n")).toEqual([]);
  });
});
