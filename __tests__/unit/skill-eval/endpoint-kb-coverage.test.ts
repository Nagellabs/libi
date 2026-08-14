import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { extractSkillEndpoints } from "@/scripts/skill-eval/audit-endpoints";
import { resolveEndpoint } from "@/mcp/dev/fake-fal/kb";

/** Endpoints referenced ONLY illustratively in skills (not meant to be callable). */
const ALLOW_LIST = new Set<string>([]);

describe("skill endpoint KB coverage", () => {
  it("every skill-referenced fal endpoint resolves through the KB", () => {
    const skillsDir = resolve(process.cwd(), "mcp", "skills");
    const referenced = extractSkillEndpoints(skillsDir);
    const missing = referenced.filter(
      (id) => !ALLOW_LIST.has(id) && resolveEndpoint(id, null).canonical === null,
    );
    expect(missing, `KB is missing skill-referenced endpoints: ${missing.join(", ")}`).toEqual([]);
  });
});
