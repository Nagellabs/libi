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

describe("social frontmatter", () => {
  const withSocial = (value: string): string =>
    `---\nid: s\nsocial: ${value}\n---\n\n## Prompt\nPost it.\n`;

  it("defaults to none — the state every non-social scenario boots in", () => {
    expect(parseScenario(`---\nid: s\n---\n\n## Prompt\nHi.\n`, "x.md").social).toBe("none");
  });

  it("parses connected and disconnected", () => {
    expect(parseScenario(withSocial("connected"), "x.md").social).toBe("connected");
    expect(parseScenario(withSocial("disconnected"), "x.md").social).toBe("disconnected");
  });

  it("throws on a typo rather than booting the opposite branch", () => {
    expect(() => parseScenario(withSocial("conected"), "x.md")).toThrow(/social/);
  });
});

/** Seeds the harness's freshly-created piece to a non-default canvas size before the
 *  prompt is sent (`POST /api/pieces` always creates 1920×1080) — so a scenario whose fit
 *  gate needs a 9:16 piece does not depend on the agent choosing to resize the canvas,
 *  which is a different skill's behaviour. */
describe("pieceDimensions frontmatter", () => {
  const withFm = (fm: string) => `---\nid: demo\n${fm}\n---\n\n## Prompt\nDo a thing.\n`;

  it("defaults to undefined — the piece stays at 1920x1080", () => {
    expect(parseScenario(withFm("title: D"), "demo.md").pieceDimensions).toBeUndefined();
  });

  it("parses a [width, height] pair", () => {
    expect(parseScenario(withFm("pieceDimensions: [1080, 1920]"), "demo.md").pieceDimensions).toEqual([1080, 1920]);
  });

  it("rejects a pair that isn't exactly two entries", () => {
    expect(() => parseScenario(withFm("pieceDimensions: [1080]"), "demo.md")).toThrow(/pieceDimensions/);
    expect(() => parseScenario(withFm("pieceDimensions: [1080, 1920, 1]"), "demo.md")).toThrow(/pieceDimensions/);
  });

  it("rejects non-positive-integer entries", () => {
    expect(() => parseScenario(withFm("pieceDimensions: [0, 1920]"), "demo.md")).toThrow(/pieceDimensions/);
    expect(() => parseScenario(withFm("pieceDimensions: [1080.5, 1920]"), "demo.md")).toThrow(/pieceDimensions/);
    expect(() => parseScenario(withFm("pieceDimensions: [-1080, 1920]"), "demo.md")).toThrow(/pieceDimensions/);
  });
});

describe("parseScenario — transcript_matches is checked at parse time", () => {
  // A bad pattern used to surface only in evaluate(), AFTER a paid live run, and the throw
  // escaped before the run report was written — so the transcript was lost with it.
  const withPattern = (re: string) =>
    SAMPLE.replace(
      "  - { endpoint_id: \"bytedance/seedance-2.0/*\", count: \">=1\" }",
      `  - transcript_matches: '${re}'\n    expect: present`,
    );

  it("accepts a usable pattern", () => {
    expect(parseScenario(withPattern(String.raw`\[tool-call \w+\]`), "ok.md").assertions).toHaveLength(4);
  });

  it("refuses an invalid pattern, naming the file", () => {
    expect(() => parseScenario(withPattern("("), "bad.md")).toThrow(/bad\.md.*not a valid regular expression/);
  });

  it("refuses a pattern that matches the empty string", () => {
    expect(() => parseScenario(withPattern("x*"), "empty.md")).toThrow(/empty\.md.*empty string/);
  });

  it("the code-overlays scenarios parse", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const dir = "skill-eval/scenarios/code-overlays";
    for (const f of readdirSync(dir)) parseScenario(readFileSync(`${dir}/${f}`, "utf8"), f);
  });
});

describe("catalogCreator frontmatter", () => {
  const withCreator = (value: string): string => `---\nid: s\ncatalogCreator: ${value}\n---\n\n## Prompt\nPublish it.\n`;

  it("is undefined when absent — the harness then boots the catalog with every creator approved", () => {
    expect(parseScenario(`---\nid: s\n---\n\n## Prompt\nHi.\n`, "x.md").catalogCreator).toBeUndefined();
  });

  it("parses each status", () => {
    for (const v of ["none", "pending", "approved", "rejected"] as const) expect(parseScenario(withCreator(v), "x.md").catalogCreator).toBe(v);
  });

  it("throws on an unknown value, naming the key", () => {
    expect(() => parseScenario(withCreator("vip"), "x.md")).toThrow(/catalogCreator/);
  });
});
