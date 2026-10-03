import { describe, it, expect } from "vitest";
import { assembleInclude, MAX_ASSEMBLED_BODY_CHARS } from "@/lib/overlays/code-include";
import { KIT_BODY } from "@/__tests__/helpers/fixtures/code-kit-body";

const SRC_ID = "code-kit0001";

function run(newBody: string, opts: { sourceBody?: string; names?: string[]; family?: "draw" | "three" } = {}) {
  return assembleInclude({
    family: opts.family ?? "draw",
    newBody,
    sourceBody: opts.sourceBody ?? KIT_BODY,
    sourceOverlayId: SRC_ID,
    names: opts.names,
  });
}

function ok(r: ReturnType<typeof run>) {
  if (!r.ok) throw new Error(`${r.error} ${r.hint ?? ""}`);
  return r;
}

describe("assembleInclude", () => {
  it("copies a named helper and everything it needs, transitively, in source order, under a banner", () => {
    const body = "const { ctx, width } = context;\nheart(ctx, width / 2, 100, 40);\n";
    const r = ok(run(body, { names: ["heart"] }));
    const names = r.report.included.map((i) => i.name);
    // heart reads PAPER, INK, GRAIN, rand; rand reads seed.
    expect(new Set(names)).toEqual(new Set(["heart", "PAPER", "INK", "GRAIN", "rand", "seed"]));
    // Source order: the lines they come from only ever increase.
    const lines = r.report.included.map((i) => i.sourceLine);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
    // Each declaration's own text is in the assembled body, in that order.
    const at = (needle: string) => r.body.indexOf(needle);
    expect(at("const INK")).toBeLessThan(at("const PAPER"));
    expect(at("const GRAIN")).toBeLessThan(at("let seed"));
    expect(at("let seed")).toBeLessThan(at("const rand"));
    expect(at("const rand")).toBeLessThan(at("function heart("));
    // Banner names the source overlay; the original body follows the end marker unchanged.
    expect(r.body.startsWith(`// ── included by libi from overlay ${SRC_ID} (6 declarations). A COPY`)).toBe(true);
    expect(r.body.endsWith(`// ── end include ──\n${body}`)).toBe(true);
    // Other helpers of the kit are NOT copied.
    expect(r.body).not.toContain("function star(");
    expect(r.body).not.toContain("PALETTE");
    expect(r.report.unresolved).toEqual([]);
  });

  it("sourceLine is the source file's own line, and bodyStartsAtLine is where the body's first line lands", () => {
    const body = "heart(ctx, 1, 2);\n";
    const r = ok(run(body, { names: ["heart"] }));
    const heart = r.report.included.find((i) => i.name === "heart")!;
    expect(KIT_BODY.split("\n")[heart.sourceLine - 1]).toMatch(/^function heart\(/);
    expect(r.body.split("\n")[r.report.bodyStartsAtLine - 1]).toBe("heart(ctx, 1, 2);");
  });

  it("without names, copies exactly what the body reads but never declares (helpers and globals are not roots)", () => {
    const body = [
      "const { ctx, width, height } = context;",
      "const t = interpolate(context.time, [0, 1], [0, 1]);",
      "ctx.fillStyle = Math.max(0, 1) ? PAPER : INK;",
      "star(ctx, 10, 10, 20);",
    ].join("\n");
    const r = ok(run(body));
    const names = r.report.included.map((i) => i.name);
    expect(names).toEqual(expect.arrayContaining(["star", "PAPER", "INK", "GRAIN", "rand", "seed"]));
    expect(names).not.toContain("interpolate");
    expect(names).not.toContain("Math");
    expect(names).not.toContain("heart");
    expect(r.report.unresolved).toEqual([]);
  });

  it("a name the new body already declares wins, and is reported as skipped", () => {
    const body = "const INK = '#000';\nfunction rand() { return 4; }\nheart(ctx, 1, 2);\n";
    const r = ok(run(body, { names: ["heart"] }));
    const included = r.report.included.map((i) => i.name);
    expect(included).toContain("heart");
    expect(included).not.toContain("INK");
    expect(included).not.toContain("rand");
    expect(r.report.skipped.map((s) => s.name).sort()).toEqual(["INK", "rand"]);
    expect(r.report.skipped[0]!.reason).toMatch(/new body declares it/);
    // The kit's INK text is not in the assembled body; the new body's is.
    expect(r.body).not.toContain('"#1b1b3a"');
    expect(r.body).toContain("const INK = '#000';");
  });

  it("an explicitly requested name the new body declares is skipped, not an error", () => {
    const r = ok(run("function heart() {}\nheart();", { names: ["heart"] }));
    expect(r.report.included).toEqual([]);
    expect(r.report.skipped).toEqual([{ name: "heart", reason: expect.stringMatching(/new body declares it/) }]);
    expect(r.body).toBe("function heart() {}\nheart();");
    expect(r.report.bodyStartsAtLine).toBe(1);
  });

  it("names the source does not declare come back unresolved; the rest is still copied", () => {
    const r = ok(run("heart(ctx, 1, 2); blorp();", { names: ["heart", "blorp"] }));
    expect(r.report.included.map((i) => i.name)).toContain("heart");
    expect(r.report.unresolved).toEqual(["blorp"]);
  });

  it("without names, a free name the source lacks is unresolved too", () => {
    const r = ok(run("heart(ctx, 1, 2); blorp();"));
    expect(r.report.unresolved).toEqual(["blorp"]);
  });

  it("top-level statements that are not declarations are never copied, and are counted", () => {
    const kit = [
      "const A = 1;",
      "let count = 0;",
      "count += 1;",
      "function bump() { return count + A; }",
      "console.log('side effect');",
      "if (A) { count = 2; }",
    ].join("\n");
    const r = ok(run("bump();", { sourceBody: kit, names: ["bump"] }));
    expect(r.body).toContain("function bump()");
    expect(r.body).toContain("let count = 0;");
    expect(r.body).not.toContain("count += 1");
    expect(r.body).not.toContain("side effect");
    expect(r.report.statementsLeftOut).toBe(3);
  });

  it("copies one declarator of a multi-declarator statement, with only its own dependencies", () => {
    const kit = "const A = 1, B = A + 1, C = 99;\nfunction f() { return B; }";
    const r = ok(run("f();", { sourceBody: kit, names: ["f"] }));
    expect(r.report.included.map((i) => i.name).sort()).toEqual(["A", "B", "f"]);
    expect(r.body).toContain("const A = 1;");
    expect(r.body).toContain("const B = A + 1;");
    expect(r.body).not.toContain("C = 99");
  });

  it("a destructuring declaration that shares a name with the new body is skipped whole, and says why", () => {
    const kit = "const { ctx, width } = context;\nfunction w() { return width; }";
    const r = ok(run("const { ctx } = context;\nw();", { sourceBody: kit, names: ["w"] }));
    expect(r.report.included.map((i) => i.name)).toEqual(["w"]);
    const byName = Object.fromEntries(r.report.skipped.map((s) => [s.name, s.reason]));
    expect(byName.ctx).toMatch(/new body declares it/);
    expect(byName.width).toMatch(/together with `ctx`/);
  });

  it("a dependency the new body supplies is satisfied by it (the kit's `ctx` destructure is not copied)", () => {
    const kit = "const { ctx } = context;\nfunction mark() { ctx.fillRect(0, 0, 1, 1); }";
    const r = ok(run("const { ctx } = context;\nmark();", { sourceBody: kit, names: ["mark"] }));
    expect(r.report.included.map((i) => i.name)).toEqual(["mark"]);
    expect(r.body.match(/const \{ ctx \}/g)).toHaveLength(1);
  });

  it("a name only a non-declaration top-level statement creates is skipped with that reason", () => {
    const kit = "if (true) { var extra = 1; }\nfunction f() { return extra; }";
    const r = ok(run("f();", { sourceBody: kit, names: ["f"] }));
    expect(r.report.skipped).toEqual([{ name: "extra", reason: expect.stringMatching(/not a declaration/) }]);
  });

  it("classes and recursion copy once", () => {
    const kit = "class Dot { constructor(x) { this.x = x; } }\nfunction make(n) { return n ? [new Dot(n), ...make(n - 1)] : []; }";
    const r = ok(run("make(3);", { sourceBody: kit, names: ["make"] }));
    expect(r.report.included.map((i) => i.name).sort()).toEqual(["Dot", "make"]);
    expect(r.body.match(/function make/g)).toHaveLength(1);
  });

  it("a parameter or local that shadows a kit name is not a dependency", () => {
    const kit = "const INK = '#111';\nfunction tint(INK) { return INK + 1; }\nfunction other() { const PAPER = 1; return PAPER; }\nconst PAPER = '#fff';";
    const r = ok(run("tint(1); other();", { sourceBody: kit, names: ["tint", "other"] }));
    expect(r.report.included.map((i) => i.name).sort()).toEqual(["other", "tint"]);
  });

  it("a source that does not parse, or a new body that does not, is a refusal naming the line", () => {
    const a = run("x();", { sourceBody: "const A = ;\n", names: ["A"] });
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.error).toMatch(/does not parse \(line 1\)/);
    const b = run("const = 1;");
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.error).toMatch(/^the body does not parse/);
  });

  it("refuses an assembled body past the cap, pointing at `names`", () => {
    const big = `function huge() { return "${"x".repeat(MAX_ASSEMBLED_BODY_CHARS)}"; }`;
    const r = run("huge();", { sourceBody: big, names: ["huge"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/over the .* limit/);
  });

  it("a three body includes from a three body: its injected names are not roots", () => {
    const kit = "const SPEED = 2;\nfunction spin(m) { m.rotation.y += SPEED; }";
    const r = ok(run("const mesh = new THREE.Mesh();\nscene.add(mesh);\nreturn () => spin(mesh);", { sourceBody: kit, family: "three" }));
    expect(r.report.included.map((i) => i.name).sort()).toEqual(["SPEED", "spin"]);
    expect(r.report.unresolved).toEqual([]);
  });

  it("is idempotent: including the same names into the assembled body skips them all", () => {
    const first = ok(run("heart(ctx, 1, 2);", { names: ["heart"] }));
    const second = ok(run(first.body, { names: ["heart"] }));
    expect(second.report.included).toEqual([]);
    expect(second.body).toBe(first.body);
    expect(second.report.skipped.map((s) => s.name)).toContain("heart");
  });

  it("every list in the report is capped", () => {
    const names = Array.from({ length: 80 }, (_, i) => `n${i}`);
    const kit = names.map((n) => `const ${n} = ${n.slice(1)};`).join("\n");
    const r = ok(run("1;", { sourceBody: kit, names }));
    expect(r.report.included).toHaveLength(60);
    expect(r.report.truncated).toBe(true);
  });
});
