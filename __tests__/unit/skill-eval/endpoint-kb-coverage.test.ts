import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import {
  describeUnclassified,
  extractSkillEndpoints,
  unclassifiedEndpointOccurrences,
  unclassifiedEndpointPrefixes,
} from "@/scripts/skill-eval/audit-endpoints";
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

  /** The regex that feeds the assertion above is a vendor ALLOW-list, so a vendor it
   *  does not know is invisible: `decart/lucy-restyle` sat in ugc-product-video's fal
   *  reference, absent from the KB, and this suite stayed green. This makes that class
   *  of gap fail loudly instead of hiding. */
  it("no unclassified `a/b` prefix can hide an endpoint from the audit", () => {
    const skillsDir = resolve(process.cwd(), "mcp", "skills");
    const found = unclassifiedEndpointOccurrences(skillsDir);
    // The guard is correct and stays; what was wrong was the message. This assertion
    // fires on work that has nothing to do with fal — quoting a repo directory as `foo/bar`
    // inside a skill is enough — so the failure has to name the file, the token, and both
    // ways out, or the next person to trip it has no idea what it wants.
    expect(found, describeUnclassified(found)).toEqual([]);
  });

  /** Guard the guard: the message has to be built from the occurrences, not a constant. */
  it("the failure message names the file, the token and both ways to resolve it", () => {
    const text = describeUnclassified([
      { prefix: "luma", token: "luma/ray-3", file: "generic-video/references/providers/fal.md" },
    ]);
    expect(text).toContain("luma/ray-3");
    expect(text).toContain("mcp/skills/generic-video/references/providers/fal.md");
    expect(text).toContain("ENDPOINT_VENDORS");
    expect(text).toContain("NON_VENDOR_PREFIXES");
    expect(text).toContain("scripts/skill-eval/audit-endpoints.ts");
    expect(describeUnclassified([])).toBe("");
  });

  /** The two views stay consistent — `unclassifiedEndpointPrefixes` is what the CLI counts. */
  it("the prefix view is the de-duplicated occurrence view", () => {
    const skillsDir = resolve(process.cwd(), "mcp", "skills");
    expect(unclassifiedEndpointPrefixes(skillsDir)).toEqual(
      [...new Set(unclassifiedEndpointOccurrences(skillsDir).map((u) => u.prefix))].sort(),
    );
  });

  it("decart is audited — the vendor whose omission proved the blind spot", () => {
    const skillsDir = resolve(process.cwd(), "mcp", "skills");
    const referenced = extractSkillEndpoints(skillsDir);
    expect(referenced).toContain("decart/lucy-restyle");
    expect(resolveEndpoint("decart/lucy-restyle", null).canonical).toBe("decart/lucy-restyle");
  });
});
