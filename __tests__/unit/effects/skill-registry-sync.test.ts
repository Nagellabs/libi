import { describe, it, expect } from "vitest";
import { isKnownEffectId, listEffects } from "@/lib/effects/registry";
import { loadSkillGraph, resolveSkills } from "../../helpers/skill-graph";

/** Extract effect ids declared in ```effects fenced blocks (one id per line). */
function effectsNamed(md: string): string[] {
  const out: string[] = [];
  for (const m of md.matchAll(/```effects\n([\s\S]*?)```/g)) {
    out.push(...m[1].split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("#")));
  }
  return out;
}

describe("skill ↔ effects registry drift", () => {
  it("every effect id named in any skill file exists in the registry", () => {
    const offenders: string[] = [];
    for (const skill of loadSkillGraph().values()) {
      for (const file of skill.files) {
        for (const id of effectsNamed(file.text)) {
          if (!isKnownEffectId(id)) offenders.push(`${skill.id}/${file.rel}: ${id}`);
        }
      }
    }
    expect(offenders, `Skill names effects not in the registry: ${offenders.join(", ")}`).toEqual([]);
  });

  it("the skill that owns effect choice names at least the core defaults", () => {
    const named = resolveSkills(["animating-overlays"]).flatMap((s) => s.files.flatMap((f) => effectsNamed(f.text)));
    for (const must of ["fade", "pop", "pulse", "audio-fade-in"]) expect(named).toContain(must);
  });

  it("the registry is non-trivial (catalog landed)", () => {
    const ids = listEffects().map((e) => e.meta.id);
    for (const must of ["fade", "bounce", "spin", "blur", "wipe", "glitch", "typewriter"]) expect(ids).toContain(must);
  });
});
