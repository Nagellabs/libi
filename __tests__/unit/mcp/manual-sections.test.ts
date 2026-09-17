import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  DEFAULT_INDEX_BUDGET_BYTES,
  ESSENTIAL_SECTION_KEYS,
  PROSE_EXAMPLE_SECTION_KEYS,
  normalizeSectionKey,
  renderManualIndex,
  resolveManualSection,
  splitManual,
} from "@/mcp/manual-sections";
import { renderAgentInstructions } from "@/mcp/workspace";

const FIXTURE = [
  "<!-- libi-instructions-start v1.0.0 -->",
  "",
  "# Libi Video Composition API",
  "",
  "Intro paragraph that orients the agent.",
  "",
  "## Drawing API",
  "",
  "All drawing helpers are available directly in the draw function scope. More detail follows.",
  "",
  "```js",
  "## not a heading — inside a fence",
  "```",
  "",
  "## Workflow",
  "",
  "1. Create the piece before anything else. Then add overlays.",
  "",
  "## Providers and skills — what you can rely on",
  "",
  "> Your live tool list is the source of truth.",
  "",
  "<!-- libi-instructions-end -->",
].join("\n");

describe("splitManual", () => {
  it("splits on top-level `##` headings and keeps the preamble separate", () => {
    const { preamble, sections } = splitManual(FIXTURE);

    expect(preamble).toContain("# Libi Video Composition API");
    expect(preamble).toContain("Intro paragraph");
    expect(preamble).not.toContain("## Drawing API");

    expect(sections.map((s) => s.heading)).toEqual([
      "Drawing API",
      "Workflow",
      "Providers and skills — what you can rely on",
    ]);
  });

  it("ignores `##` lines inside fenced code blocks", () => {
    const { sections } = splitManual(FIXTURE);
    expect(sections.map((s) => s.heading)).not.toContain("not a heading — inside a fence");
    // The fenced line stays inside the section it belongs to.
    expect(sections[0].text).toContain("## not a heading — inside a fence");
  });

  it("gives each section a slug key, a first-sentence description and a byte size", () => {
    const { sections } = splitManual(FIXTURE);
    const drawing = sections[0];

    expect(drawing.key).toBe("drawing-api");
    expect(drawing.description).toBe(
      "All drawing helpers are available directly in the draw function scope.",
    );
    expect(drawing.bytes).toBe(Buffer.byteLength(drawing.text, "utf8"));

    expect(sections[2].key).toBe("providers-and-skills-what-you-can-rely-on");
  });

  it("keeps the heading line in the section text", () => {
    const { sections } = splitManual(FIXTURE);
    expect(sections[1].text.startsWith("## Workflow")).toBe(true);
  });

  it("trims a long description to ~100 characters", () => {
    const long = `## Long\n\n${"word ".repeat(60)}end of it.\n`;
    const { sections } = splitManual(long);
    expect(sections[0].description.length).toBeLessThanOrEqual(101);
    expect(sections[0].description.endsWith("…")).toBe(true);
  });

  it("does not cut the description at an abbreviation like 'e.g.'", () => {
    const manual = [
      "## Extension self-healing",
      "",
      "Before relying on any libi extension (e.g. `youtube-download`, `whisper`), call",
      "`libi.diagnose_mcp` and inspect the row's `serverStatus`:",
      "",
      "- `up` — the server passed handshake.",
    ].join("\n");
    const { sections } = splitManual(manual);
    expect(sections[0].description).not.toBe("Before relying on any libi extension (e.g.");
    expect(sections[0].description).toContain("Before relying on any libi extension (e.g.");
    expect(sections[0].description).toContain("youtube-download");
  });

  it("recognizes other common abbreviations (i.e., etc., vs.) as non-terminators", () => {
    const manual = [
      "## Example",
      "",
      "Use the local engine (i.e. the free tracker), not a hosted one, etc. That is the default.",
    ].join("\n");
    const { sections } = splitManual(manual);
    expect(sections[0].description).toBe(
      "Use the local engine (i.e. the free tracker), not a hosted one, etc. That is the default.",
    );
  });

  it("skips a sub-heading directly under the section heading when picking the description", () => {
    const manual = [
      "## Complete Example Scenes",
      "",
      "### Example 1: Title Card with Gradient Background",
      "",
      "```js",
      "// drawFunction for a 3-second title card",
      "const x = 1;",
      "```",
      "",
      "### Example 2: Text Animation with Spring Physics",
      "",
      "```js",
      "const y = 2;",
      "```",
    ].join("\n");
    const { sections } = splitManual(manual);
    expect(sections[0].description).not.toContain("Example 1");
    expect(sections[0].description).not.toContain("###");
    // No prose exists in this section at all (only sub-headings and fenced
    // code) — the description is empty rather than the code itself.
    expect(sections[0].description).toBe("");
  });

  it("uses the first real prose paragraph when a sub-heading is followed by text", () => {
    const manual = [
      "## Extension self-healing",
      "",
      "### Before you start",
      "",
      "Call `libi.diagnose_mcp` first. It tells you what is up.",
    ].join("\n");
    const { sections } = splitManual(manual);
    expect(sections[0].description).toBe(
      "Call `libi.diagnose_mcp` first.",
    );
  });

  it("does not treat a `##` inside an indented fence as a heading", () => {
    const manual = [
      "## Real Section",
      "",
      "Some text.",
      "",
      "  ```",
      "  ## not a real heading — indented fence",
      "  ```",
      "",
      "## Another Section",
      "",
      "More text.",
    ].join("\n");
    const { sections } = splitManual(manual);
    expect(sections.map((s) => s.heading)).toEqual(["Real Section", "Another Section"]);
    expect(sections[0].text).toContain("## not a real heading — indented fence");
  });

  it("does not close a fence with a mismatched marker (``` vs ~~~)", () => {
    const manual = [
      "## Real Section",
      "",
      "~~~",
      "## still inside the ~~~ fence",
      "```",
      "## also still inside — a ``` line does not close a ~~~ fence",
      "~~~",
      "",
      "## Another Section",
    ].join("\n");
    const { sections } = splitManual(manual);
    expect(sections.map((s) => s.heading)).toEqual(["Real Section", "Another Section"]);
  });

  it("keeps every section addressable when headings slug identically (collision-proof suffixing)", () => {
    const manual = ["## Foo", "", "A.", "", "## Foo 2", "", "B.", "", "## Foo", "", "C."].join(
      "\n",
    );
    const { sections } = splitManual(manual);
    const keys = sections.map((s) => s.key);

    // Every key must be unique once normalized — the form lookups actually
    // match against — or a later section becomes unreachable.
    const normalized = keys.map((k) => normalizeSectionKey(k));
    expect(new Set(normalized).size).toBe(normalized.length);

    // Each section is independently resolvable by its own key.
    for (const key of keys) {
      const res = resolveManualSection(manual, key);
      expect(res.ok, key).toBe(true);
    }
  });
});

describe("normalizeSectionKey", () => {
  it("is case-insensitive and punctuation-tolerant", () => {
    expect(normalizeSectionKey("drawing api")).toBe(normalizeSectionKey("drawing-api"));
    expect(normalizeSectionKey("Drawing API")).toBe(normalizeSectionKey("drawing_api"));
    expect(normalizeSectionKey("  Providers and skills — what you can rely on ")).toBe(
      normalizeSectionKey("providers-and-skills-what-you-can-rely-on"),
    );
  });
});

describe("resolveManualSection", () => {
  it("returns the index when called with no section", () => {
    const res = resolveManualSection(FIXTURE);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain("`drawing-api`");
    expect(res.text).toContain("`workflow`");
    expect(res.text.trimEnd().endsWith('`libi.read_manual({ section: "<key>" })`')).toBe(true);
  });

  it("returns exactly one section's text for a known key", () => {
    const res = resolveManualSection(FIXTURE, "drawing-api");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text.startsWith("## Drawing API")).toBe(true);
    expect(res.text).not.toContain("## Workflow");
  });

  it("matches a key case-insensitively and through punctuation", () => {
    for (const key of ["Drawing API", "drawing api", "drawing_api", "DRAWING-API"]) {
      const res = resolveManualSection(FIXTURE, key);
      expect(res.ok, key).toBe(true);
      if (res.ok) expect(res.text.startsWith("## Drawing API")).toBe(true);
    }
  });

  it("returns the whole manual unchanged for `all`", () => {
    const res = resolveManualSection(FIXTURE, "all");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toBe(FIXTURE);
    const upper = resolveManualSection(FIXTURE, "ALL");
    if (upper.ok) expect(upper.text).toBe(FIXTURE);
  });

  it("fails with the list of valid keys for an unknown section — never an empty success", () => {
    const res = resolveManualSection(FIXTURE, "nope");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain("nope");
    expect(res.message).toContain("drawing-api");
    expect(res.message).toContain("workflow");
    expect(res.message).toContain("all");
  });

  it("treats an empty / whitespace section argument as no argument", () => {
    const res = resolveManualSection(FIXTURE, "   ");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toContain("`drawing-api`");
  });
});

describe("renderManualIndex", () => {
  it("lists every section with its key and an approximate size", () => {
    const index = renderManualIndex(FIXTURE);
    expect(index).toContain("`drawing-api`");
    expect(index).toContain("`workflow`");
    expect(index).toContain("`providers-and-skills-what-you-can-rely-on`");
    expect(index).toMatch(/~[\d.]+ KB/);
    expect(index).toContain("Intro paragraph");
  });

  it("inlines the essential sections verbatim", () => {
    const index = renderManualIndex(FIXTURE);
    // `workflow` is an essential; `drawing-api` is not.
    expect(index).toContain("1. Create the piece before anything else.");
    expect(index).not.toContain("All drawing helpers are available directly in the draw function scope. More detail follows.");
  });

  it("drops essentials that would push it past the byte budget", () => {
    const big = `## Workflow\n\n${"x".repeat(40_000)}\n`;
    const index = renderManualIndex(big);
    expect(Buffer.byteLength(index, "utf8")).toBeLessThan(DEFAULT_INDEX_BUDGET_BYTES);
    expect(index).not.toContain("x".repeat(1_000));
  });

  it("never throws even when the preamble + per-section index alone exceed the budget — that part is NOT bounded", () => {
    // A manual with enough sections that the head (preamble + one index line
    // per section) already exceeds a deliberately tiny budget, on its own,
    // before the essentials loop runs at all.
    const manySections = Array.from(
      { length: 50 },
      (_, i) => `## Section ${i}\n\nSome prose for section ${i}.\n`,
    ).join("\n");
    expect(() => renderManualIndex(manySections, 10)).not.toThrow();
    const index = renderManualIndex(manySections, 10);
    // The head alone is already far over the 10-byte budget — confirming
    // the budget genuinely only governs the essentials loop, not the head.
    expect(Buffer.byteLength(index, "utf8")).toBeGreaterThan(10);
    expect(index).toContain("`section-0`");
  });
});

describe("against the real rendered manual", () => {
  const manual = renderAgentInstructions("claude");

  it("splits into a workable number of sections, none over 30 KB", () => {
    const { sections } = splitManual(manual);
    expect(sections.length).toBeGreaterThanOrEqual(8);
    expect(sections.length).toBeLessThanOrEqual(40);
    for (const s of sections) {
      expect(s.bytes, `${s.key} is ${s.bytes} bytes`).toBeLessThanOrEqual(30 * 1024);
    }
  });

  it("every ESSENTIAL_SECTION_KEYS entry still resolves to a real heading", () => {
    const { sections } = splitManual(manual);
    const keys = new Set(sections.map((s) => normalizeSectionKey(s.key)));
    for (const key of ESSENTIAL_SECTION_KEYS) {
      expect(keys.has(normalizeSectionKey(key)), `essential key "${key}" is missing`).toBe(true);
    }
  });

  // The section keys named as EXAMPLES in prose outside this module — the MCP
  // `instructions` core, the `libi.read_manual` tool description, and its
  // schema description — must resolve too. `mcp/server.ts` and
  // `mcp/tools/schemas.ts` build their example text FROM
  // `PROSE_EXAMPLE_SECTION_KEYS` (so they can't drift on their own), which
  // the first test below checks directly. `mcp/instructions-core.md` is
  // plain text and can't import the constant, so the second test regexes
  // its quoted keys out and resolves each one independently — that is what
  // actually catches the core drifting out of sync with a renamed heading.
  it("every PROSE_EXAMPLE_SECTION_KEYS entry resolves to a real heading (covers mcp/server.ts and mcp/tools/schemas.ts, which build their example text from it)", () => {
    const { sections } = splitManual(manual);
    const keys = new Set(sections.map((s) => normalizeSectionKey(s.key)));
    for (const key of PROSE_EXAMPLE_SECTION_KEYS) {
      expect(keys.has(normalizeSectionKey(key)), `prose example key "${key}" is missing`).toBe(
        true,
      );
    }
  });

  it("every quoted section-like key named in mcp/instructions-core.md resolves to a real heading", () => {
    const { sections } = splitManual(manual);
    const validKeys = new Set(sections.map((s) => normalizeSectionKey(s.key)));

    const corePath = path.join(process.cwd(), "mcp", "instructions-core.md");
    const coreText = fs.readFileSync(corePath, "utf-8");

    // Section keys are kebab-case (letters/digits, hyphen-joined) and always
    // appear double-quoted in prose (`section: "mcp-tools"` or a bare
    // `"canvas-dimensions"` in a following list). Requiring at least one
    // hyphen keeps this from matching an unrelated quoted single word.
    const KEY_PATTERN = /"([a-z0-9]+(?:-[a-z0-9]+)+)"/g;
    const found = new Set<string>();
    for (const m of coreText.matchAll(KEY_PATTERN)) found.add(m[1]);

    expect(found.size).toBeGreaterThan(0);
    for (const key of found) {
      expect(validKeys.has(normalizeSectionKey(key)), `instructions-core.md names "${key}"`).toBe(
        true,
      );
    }
    // …and every key it names is one of the shared prose examples, so the two
    // surfaces cannot drift apart on a rename.
    //
    // Deliberately a SUBSET check, not equality. This used to require the core
    // to name ALL of PROSE_EXAMPLE_SECTION_KEYS, which coupled a
    // size-capped surface to two uncapped ones: the core is the whole of what
    // Claude Code shows before `read_manual` is ever called, inside a
    // 2,048-character budget, while the tool and schema descriptions
    // can list four examples for free. Naming one example there and four in
    // the tool description is a legitimate choice; naming a key that does not
    // exist never is, and the loop above is what catches that.
    for (const key of found) {
      expect(
        PROSE_EXAMPLE_SECTION_KEYS.includes(key),
        `instructions-core.md names "${key}", which is not in PROSE_EXAMPLE_SECTION_KEYS`,
      ).toBe(true);
    }
  });

  it("the no-arg index stays well under the ~15 KB budget", () => {
    const index = renderManualIndex(manual);
    expect(Buffer.byteLength(index, "utf8")).toBeLessThan(DEFAULT_INDEX_BUDGET_BYTES);
    // …and is a small fraction of the full manual.
    expect(Buffer.byteLength(index, "utf8")).toBeLessThan(
      Buffer.byteLength(manual, "utf8") / 4,
    );
  });

  it("the index carries the workflow material an agent needs before its first edit", () => {
    const index = renderManualIndex(manual);
    expect(index).toContain("## Workflow");
    expect(index).toContain("## Working with Pieces");
    expect(index).toContain("## Canvas Coordinate System");
  });

  it("`all` round-trips the full manual byte-for-byte", () => {
    const res = resolveManualSection(manual, "all");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toBe(manual);
  });

  it("a real section key returns just that section", () => {
    const res = resolveManualSection(manual, "canvas coordinate system");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text.startsWith("## Canvas Coordinate System")).toBe(true);
      expect(res.text).not.toContain("## MCP Tools");
    }
  });
});
