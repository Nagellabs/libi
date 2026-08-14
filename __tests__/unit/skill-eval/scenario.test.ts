import { describe, it, expect } from "vitest";
import { parseScenario } from "@/scripts/skill-eval/scenario";

const SAMPLE = `---
id: demo
title: Demo scenario
skills: [ugc-product-video, ai-asset-generation]
mcps: [fal-ai]
agent: claude-code
runs: 2
covers: [gpt-image-2, native-audio]
---

## Prompt
Make a 10-second ad.

## Hard invariants
\`\`\`yaml
assertions:
  - { tool: run_model, endpoint_id: openai/gpt-image-2, expect: present }
  - { endpoint_id: "fal-ai/nano-banana*", expect: absent }
  - { tool: submit_job, where: "input.generate_audio == false", expect: absent }
  - { endpoint_id: "bytedance/seedance-2.0/*", count: ">=1" }
\`\`\`

## Behavioral expectations
- Wrote specific prompts.
- Did NOT generate a Kokoro voiceover.
`;

describe("parseScenario", () => {
  it("parses frontmatter, prompt, assertions, and behavior", () => {
    const s = parseScenario(SAMPLE, "demo.md");
    expect(s.id).toBe("demo");
    expect(s.skills).toEqual(["ugc-product-video", "ai-asset-generation"]);
    expect(s.mcps).toEqual(["fal-ai"]);
    expect(s.agents).toEqual(["claude-code"]);
    expect(s.runs).toBe(2);
    expect(s.timeoutSec).toBe(300); // default
    expect(s.covers).toContain("gpt-image-2");
    expect(s.prompt).toBe("Make a 10-second ad.");
    expect(s.assertions).toHaveLength(4);
    expect(s.assertions[0]).toMatchObject({ tool: "run_model", endpoint_id: "openai/gpt-image-2", expect: "present" });
    expect(s.assertions[3]).toMatchObject({ endpoint_id: "bytedance/seedance-2.0/*", count: ">=1" });
    expect(s.behavior).toEqual(["Wrote specific prompts.", "Did NOT generate a Kokoro voiceover."]);
  });

  it("normalizes an array agent and defaults runs/timeout", () => {
    const md = SAMPLE.replace("agent: claude-code", "agent: [claude-code, codex]").replace("runs: 2\n", "");
    const s = parseScenario(md, "demo.md");
    expect(s.agents).toEqual(["claude-code", "codex"]);
    expect(s.runs).toBe(1);
  });

  it("throws on a missing id", () => {
    const md = SAMPLE.replace("id: demo\n", "");
    expect(() => parseScenario(md, "bad.md")).toThrow(/id/);
  });

  it("throws on a malformed yaml assertions block", () => {
    const md = SAMPLE.replace("assertions:\n", "assertions: [ {{{ \n");
    expect(() => parseScenario(md, "bad.md")).toThrow(/assertions/i);
  });

  it("allows a scenario with no invariants and no behavior", () => {
    const md = `---\nid: x\ntitle: X\nskills: [a]\nmcps: [b]\ncovers: [c]\n---\n\n## Prompt\nHi.\n`;
    const s = parseScenario(md, "x.md");
    expect(s.assertions).toEqual([]);
    expect(s.behavior).toEqual([]);
    expect(s.prompt).toBe("Hi.");
  });

  it("parses falStrict frontmatter (defaults false)", () => {
    const withStrict = parseScenario(
      `---\nid: x\nfalStrict: true\n---\n## Prompt\nhi\n`, "x.md",
    );
    expect(withStrict.falStrict).toBe(true);

    const without = parseScenario(`---\nid: y\n---\n## Prompt\nhi\n`, "y.md");
    expect(without.falStrict).toBe(false);
  });
});
