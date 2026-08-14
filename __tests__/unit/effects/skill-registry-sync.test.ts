import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { isKnownEffectId, listEffects } from "@/lib/effects/registry";

/** Extract effect ids declared in a ```effects fenced block (one id per line). */
function effectsNamedInSkill(md: string): string[] {
  const m = md.match(/```effects\n([\s\S]*?)```/);
  if (!m) return [];
  return m[1].split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("#"));
}

describe("skill ↔ effects registry drift", () => {
  it("every effect id named in any SKILL.md exists in the registry", () => {
    const skillsRoot = join(process.cwd(), "mcp", "skills");
    const offenders: string[] = [];
    for (const name of readdirSync(skillsRoot)) {
      const file = join(skillsRoot, name, "SKILL.md");
      if (!existsSync(file)) continue;
      for (const id of effectsNamedInSkill(readFileSync(file, "utf8"))) {
        if (!isKnownEffectId(id)) offenders.push(`${name}: ${id}`);
      }
    }
    expect(offenders, `Skill names effects not in the registry: ${offenders.join(", ")}`).toEqual([]);
  });

  it("using-effects names at least the core defaults", () => {
    const md = readFileSync(join(process.cwd(), "mcp", "skills", "using-effects", "SKILL.md"), "utf8");
    const named = effectsNamedInSkill(md);
    for (const must of ["fade", "pop", "pulse", "audio-fade-in"]) expect(named).toContain(must);
  });

  it("the registry is non-trivial (catalog landed)", () => {
    const ids = listEffects().map((e) => e.meta.id);
    for (const must of ["fade", "bounce", "spin", "blur", "wipe", "glitch", "typewriter"]) expect(ids).toContain(must);
  });
});
