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

  it("keeps mcps: [fal-ai] parsing to the same value — it means the test-mode fake", () => {
    const s = parseScenario(SAMPLE, "demo.md");
    expect(s.mcps).toEqual(["fal-ai"]);
  });

  it("accepts a libi extension id in mcps:", () => {
    const s = parseScenario(SAMPLE.replace("mcps: [fal-ai]", "mcps: [youtube-download, fal-ai]"), "demo.md");
    expect(s.mcps).toEqual(["youtube-download", "fal-ai"]);
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

/** Every eval prompt was suffixed with a preamble telling the agent it is
 *  "PRE-AUTHORIZED to run the entire workflow to completion, including every paid
 *  generation tool", which makes "prefer the free path" unassertable suite-wide — an agent
 *  has read a provider reference, correctly stated that the paid route is opt-in only, and
 *  then taken it anyway, citing that sentence. `preauthorize: false` is the opt-out. */
describe("parseScenario — preauthorize", () => {
  const withFm = (fm: string) => `---\nid: demo\n${fm}\n---\n\n## Prompt\nDo a thing.\n`;

  it("defaults to true, because an unattended run must not stall on a question", () => {
    expect(parseScenario(withFm("title: D"), "demo.md").preauthorize).toBe(true);
  });

  it("honours an explicit opt-out and an explicit opt-in", () => {
    expect(parseScenario(withFm("preauthorize: false"), "demo.md").preauthorize).toBe(false);
    expect(parseScenario(withFm("preauthorize: true"), "demo.md").preauthorize).toBe(true);
  });

  it("rejects a non-boolean rather than silently pre-authorizing", () => {
    // `preauthorize: "false"` truthily read as opt-IN would spend money in a scenario
    // written to assert it does not — the exact failure this key exists to prevent.
    expect(() => parseScenario(withFm('preauthorize: "false"'), "demo.md")).toThrow(
      /"preauthorize" must be a boolean/,
    );
  });
});

/** Before this key there was no way for a scenario to declare input media, so every
 *  scenario that reads an existing clip was unrunnable (several carry `assertions: []`).
 *  The allow-shape is deliberately narrow: repo-relative, no `..`, validated at parse time
 *  so a typo fails before anything is spawned. */
describe("parseScenario — fixtures", () => {
  const withFm = (fm: string) => `---\nid: demo\n${fm}\n---\n\n## Prompt\nDo a thing.\n`;

  it("defaults to an empty list", () => {
    expect(parseScenario(withFm("title: D"), "demo.md").fixtures).toEqual([]);
  });

  it("accepts repo-relative paths, as a string or a list", () => {
    expect(
      parseScenario(withFm("fixtures: __tests__/fixtures/audio/jfk.wav"), "demo.md").fixtures,
    ).toEqual(["__tests__/fixtures/audio/jfk.wav"]);
    expect(
      parseScenario(withFm("fixtures: [__tests__/fixtures/audio/jfk.wav]"), "demo.md").fixtures,
    ).toEqual(["__tests__/fixtures/audio/jfk.wav"]);
  });

  it("rejects an absolute path", () => {
    expect(() => parseScenario(withFm("fixtures: [/etc/passwd]"), "demo.md")).toThrow(
      /must be repo-relative/,
    );
  });

  it("rejects a path that climbs out of the repo", () => {
    expect(() => parseScenario(withFm("fixtures: [../../../etc/passwd]"), "demo.md")).toThrow(
      /may not escape the repo/,
    );
    // …including one that only escapes after normalisation.
    expect(() =>
      parseScenario(withFm("fixtures: [__tests__/../../secrets.env]"), "demo.md"),
    ).toThrow(/may not escape the repo/);
  });
});
