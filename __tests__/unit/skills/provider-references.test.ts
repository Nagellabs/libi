/**
 * Facts the provider references and skills state about providers that can be checked against the
 * code and against each other — not against a particular wording.
 *
 *  - the first-last-frame field names a skill teaches are the ones the model KB (the fake provider,
 *    built from the providers' live schemas) actually serves;
 *  - there is exactly one first-last-frame endpoint id across all provider references;
 *  - the "recommended model" marker mechanism (a fork edits SKILL.md, the reference supplies the
 *    default) stays coherent wherever it is used.
 */
import { describe, it, expect } from "vitest";
import { getSchema, resolveEndpoint } from "@/mcp/dev/fake-fal/kb";
import { collapse, loadSkillGraph, resolveSkills } from "../../helpers/skill-graph";

const graph = loadSkillGraph();

describe("first-last-frame keyframe fields match what the providers serve", () => {
  // Whichever skill holds the FLF guidance (physical action craft, engine guides), the names are the KB's.
  const skills = resolveSkills(["physical-action-video", "ai-video-models"]);
  const text = collapse(skills.map((x) => x.text).join("\n"));
  // The provider references only: a Seedance prompt guide legitimately uses @Image1/@Image2 as reference tokens.
  const providerRefs = collapse(
    skills
      .flatMap((x) => x.files)
      .filter((f) => f.rel.startsWith("references/providers/"))
      .map((f) => f.text)
      .join("\n"),
  );

  it("Kling's start/end fields are the ones its schema has — not @Image1/@Image2 reference tokens", () => {
    const kling = getSchema("fal-ai/kling-video/o1/image-to-video", null);
    expect(Object.keys(kling.properties)).toEqual(expect.arrayContaining(["start_image_url", "end_image_url"]));
    expect(text).toContain("start_image_url");
    expect(text).toContain("end_image_url");
    // The claim that once sent agents to a non-existent input shape.
    expect(providerRefs).not.toMatch(/@Image1`?\s*(=|is|as)\s*(the )?`?start|start[_a-z]*`?\s*=\s*`?@Image1/i);
    expect(providerRefs).not.toContain("@Image2");
  });

  it("Veo's first-last-frame endpoint takes first_frame_url + last_frame_url", () => {
    const veo = getSchema("fal-ai/veo3.1/fast/first-last-frame-to-video", null);
    expect(veo.required).toEqual(expect.arrayContaining(["first_frame_url", "last_frame_url"]));
    expect(text).toContain("first_frame_url");
    expect(text).toContain("last_frame_url");
  });

  it("names are said to differ per engine, and the agent is sent to the schema", () => {
    expect(text).toMatch(/differ per engine|there is no universal `end_image_url`|not universal/i);
    expect(text).toMatch(/get_model_schema/);
  });

  it("only one first-last-frame endpoint id exists across all provider references, and the KB serves it", () => {
    const ids = new Set<string>();
    for (const s of graph.values()) {
      for (const f of s.files) {
        if (!f.rel.startsWith("references/providers/")) continue;
        for (const m of f.text.matchAll(/`([a-zA-Z0-9-]+\/[a-zA-Z0-9/_.-]*first-last-frame[a-zA-Z0-9/_.-]*)`/g)) {
          ids.add(m[1]);
        }
      }
    }
    expect(ids.size, `first-last-frame endpoint ids: ${[...ids].join(", ")}`).toBe(1);
    expect(resolveEndpoint([...ids][0], null).canonical).toBe([...ids][0]);
  });
});

describe("the recommended-model marker", () => {
  const MARKER = /RECOMMENDED_VIDEO_MODEL\s*=\s*provider-default/;

  it("wherever a skill uses it, the provider reference marks one RECOMMENDED model with a staleness stamp, and the fork path exists", () => {
    const users = [...graph.values()].filter((s) => MARKER.test(s.body));
    // The mechanism is optional: a skill that drops it needs none of this.
    for (const s of users) {
      const ref = s.files.find((f) => f.rel === "references/providers/fal.md");
      expect(ref, `${s.id} uses the marker but ships no fal reference`).toBeDefined();
      expect(ref!.text, `${s.id}: nothing is marked RECOMMENDED`).toMatch(/^RECOMMENDED: \S+$/m);
      expect(ref!.text, `${s.id}: the recommendation carries no "maintainer-updated" date`).toMatch(
        /maintainer-updated \d{4}-\d{2}-\d{2}/,
      );
      expect(s.body, `${s.id}: how a user forks the default`).toMatch(/`libi\.skill` action `fork`/);
      expect(s.body, `${s.id}: the fork edit goes through libi.skill update`).toMatch(/`libi\.skill` action `update`/);
      // Nothing can write under references/, so the fork must never be told to edit it.
      expect(s.body).toMatch(/never hand-edit[\s\S]{0,40}references\/|(do not|never)[\s\S]{0,40}references\//i);
    }
  });
});
