import { describe, it, expect } from "vitest";
import { findUndefinedNames, bodyWarningsForOverlays, bodyFamilyOf } from "@/lib/overlays/body-warnings";
import { injectedNames, isBuiltinName } from "@/lib/overlays/body-scope";
import { DRAW_HELPERS } from "@/lib/engine/draw-helpers";
import { THREE_PARAM_NAMES } from "@/lib/ai/scene-validator";
import { makeRuntimeHelpers } from "@/lib/sandbox/runtime/helpers";
import { KIT_BODY } from "@/__tests__/helpers/fixtures/code-kit-body";
import type { PersistedOverlay } from "@/lib/composition/persistence";

const names = (src: string, family: "draw" | "three" = "draw") => findUndefinedNames(src, family).map((w) => w.name);

describe("findUndefinedNames", () => {
  it("catches a called name nothing defines, with its line (the `heart is not defined` class)", () => {
    const src = ["const { ctx, width } = context;", "ctx.fillStyle = '#fff';", "", "heart(ctx, width / 2, 100, 40);"].join("\n");
    expect(findUndefinedNames(src, "draw")).toEqual([{ name: "heart", line: 4 }]);
  });

  it("reports a name once, at its first read, in source order", () => {
    const src = "a();\nb();\na();\nb(a);";
    expect(findUndefinedNames(src, "draw")).toEqual([{ name: "a", line: 1 }, { name: "b", line: 2 }]);
  });

  it("does not flag what the runtime injects: every documented helper, and `context`", () => {
    const calls = Object.keys(DRAW_HELPERS).map((h) => `${h};`).join("\n");
    expect(names(`context; ${calls}`)).toEqual([]);
    // the helpers an end-card body leans on, by name
    expect(names("const t = interpolate(context.time, [0, 1], [0, 1]); drawRoundedRect(context.ctx, 0, 0, 1, 1, 1, '#000'); easeOutCubic(t);")).toEqual([]);
  });

  it("the injected names are the runtime's own: the helper bag the sandbox builds, and the three parameters", () => {
    const runtime = new Set(Object.keys(makeRuntimeHelpers(() => ({}), "ov")));
    for (const k of runtime) expect(injectedNames("draw").has(k), `runtime helper ${k} not known to the check`).toBe(true);
    for (const k of injectedNames("draw")) if (k !== "context") expect(runtime.has(k), `${k} is not a runtime helper`).toBe(true);
    expect([...injectedNames("three")].sort()).toEqual([...THREE_PARAM_NAMES].sort());
    // A three body does not get the draw helpers as bare names.
    expect(isBuiltinName("interpolate", "three")).toBe(false);
    expect(isBuiltinName("THREE", "draw")).toBe(false);
  });

  it("does not flag the standard library or the canvas names a body builds on", () => {
    expect(names("Math.max(1, 2); JSON.stringify({}); new Path2D('M0 0'); new OffscreenCanvas(1, 1); Number.isFinite(1); [].map(String); new Map(); undefined; NaN; Infinity; parseFloat('1');")).toEqual([]);
  });

  it("does not flag declarations: var/let/const/function/class, parameters, destructuring, catch, loop heads", () => {
    const src = [
      "var a = 1; let b = 2; const c = 3;",
      "function f(p, { q, r = a }, [s, ...t], ...rest) { return p + q + r + s + t + rest + arguments.length; }",
      "class K { m(x) { return x + b; } static s() { return K; } }",
      "const { u, v: w, ...others } = context; const [x0, y0] = [1, 2];",
      "try { f(); } catch (err) { err.message; }",
      "for (let i = 0; i < 3; i++) { i; } for (const k in {}) { k; } for (const [m0, n0] of []) { m0 + n0; }",
      "const g = (z) => z + c; const h = function named(n) { return named; };",
      "u; w; others; x0; y0; g; h; K;",
    ].join("\n");
    expect(names(src)).toEqual([]);
  });

  it("scopes properly: a name declared only inside another function or block is not visible outside", () => {
    expect(names("function a() { const inner = 1; return inner; }\ninner;")).toEqual(["inner"]);
    expect(names("{ let blocked = 1; }\nblocked;")).toEqual(["blocked"]);
    expect(names("for (let i = 0; i < 2; i++) {}\ni;")).toEqual(["i"]);
    // var is function-scoped, hoisted out of its block; a function declaration hoists.
    expect(names("{ var seen = 1; }\nseen; later(); function later() {}")).toEqual([]);
    // a closure sees its enclosing scope
    expect(names("const k = 2; function a() { return () => k; }")).toEqual([]);
  });

  it("does not flag property names, object keys, labels or method names", () => {
    const src = "const o = { alpha: 1, beta() {}, 'gamma': 2 }; o.alpha; o.beta; o?.delta; class A { epsilon() {} zeta = 1; } outer: for (;;) { break outer; }";
    expect(names(src)).toEqual([]);
  });

  it("flags a shorthand property and a computed key, which ARE reads", () => {
    expect(names("const o = { shorty };")).toEqual(["shorty"]);
    expect(names("const o = { [computed]: 1 };")).toEqual(["computed"]);
  });

  it("does not flag `typeof missing`, but flags a compound assignment and a plain read", () => {
    expect(names("if (typeof maybe !== 'undefined') {}")).toEqual([]);
    expect(names("counter += 1;")).toEqual(["counter"]);
    expect(names("const z = missing + 1;")).toEqual(["missing"]);
  });

  it("an assignment to an undeclared name is an implicit global: not flagged, and neither are its later reads", () => {
    expect(names("function init() { shared = 1; }\ninit(); shared;")).toEqual([]);
  });

  it("flags names read inside nested functions and default values", () => {
    expect(names("function f(a = nope) { return () => alsoNope; }")).toEqual(["nope", "alsoNope"]);
  });

  it("flags a three body's missing name, and treats THREE / scene / helpers as injected", () => {
    const src = "const m = new THREE.Mesh(); scene.add(m); helpers.interpolate(0, [0, 1], [0, 1]);\nreturn () => spinner(m);";
    expect(findUndefinedNames(src, "three")).toEqual([{ name: "spinner", line: 2 }]);
  });

  it("a body that does not parse yields nothing (the validator reports the syntax error)", () => {
    expect(findUndefinedNames("const = ;", "draw")).toEqual([]);
  });

  it("the full style kit is clean: every name it reads is declared or injected", () => {
    expect(findUndefinedNames(KIT_BODY, "draw")).toEqual([]);
  });

  it("is bounded: a body reading hundreds of unknown names reports at most 20", () => {
    const src = Array.from({ length: 300 }, (_, i) => `u${i}();`).join("\n");
    expect(findUndefinedNames(src, "draw")).toHaveLength(20);
  });

  it("a deeply nested body is an empty result, not a crash", () => {
    const src = `${"(".repeat(20000)}1${")".repeat(20000)};`;
    expect(() => findUndefinedNames(src, "draw")).not.toThrow();
  });
});

describe("bodyWarningsForOverlays / bodyFamilyOf", () => {
  const code = (id: string, drawFunction: string) => ({ id, kind: "code", drawFunction }) as unknown as PersistedOverlay;

  it("lists only the code-bearing overlays that have warnings, by overlay id", () => {
    const overlays = [
      code("c1", "const { ctx } = context; heart(ctx);"),
      code("c2", "const { ctx } = context; ctx.fillRect(0, 0, 1, 1);"),
      { id: "t1", kind: "text", content: "hi" } as unknown as PersistedOverlay,
      { id: "k1", kind: "three", sceneFunction: "return () => tilt();" } as unknown as PersistedOverlay,
      { id: "tr1", kind: "tracked", content: { kind: "code", drawFunction: "wobble();" } } as unknown as PersistedOverlay,
    ];
    expect(bodyWarningsForOverlays(overlays)).toEqual([
      { overlayId: "c1", kind: "code", warnings: [{ name: "heart", line: 1 }] },
      { overlayId: "k1", kind: "three", warnings: [{ name: "tilt", line: 1 }] },
      { overlayId: "tr1", kind: "tracked", warnings: [{ name: "wobble", line: 1 }] },
    ]);
  });

  it("family: code and tracked-code are draw bodies, three is three, anything else has none", () => {
    expect(bodyFamilyOf({ kind: "code" } as never)).toBe("draw");
    expect(bodyFamilyOf({ kind: "tracked", content: { kind: "code" } } as never)).toBe("draw");
    expect(bodyFamilyOf({ kind: "tracked", content: { kind: "text" } } as never)).toBeNull();
    expect(bodyFamilyOf({ kind: "three" } as never)).toBe("three");
    expect(bodyFamilyOf({ kind: "image" } as never)).toBeNull();
  });
});
