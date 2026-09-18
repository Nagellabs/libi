import { describe, it, expect } from "vitest";
import { starterBody } from "@/lib/overlays/templates";
import {
  validateDrawFunction,
  validateThreeFunction,
  createDrawFunction,
  THREE_PARAM_NAMES,
} from "@/lib/ai/scene-validator";
import { DRAW_HELPERS } from "@/lib/engine/draw-helpers";

/** Minimal stub CanvasRenderingContext2D that records whether a fill call
 *  landed, mirroring how the real renderer would invoke a code overlay's
 *  compiled draw function. */
function makeStubCtx() {
  const calls: string[] = [];
  const ctx = {
    save: () => calls.push("save"),
    restore: () => calls.push("restore"),
    fillRect: (..._args: number[]) => calls.push("fillRect"),
    set fillStyle(_v: string) {
      calls.push("fillStyle");
    },
    set globalAlpha(_v: number) {
      calls.push("globalAlpha");
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

describe("overlay starter bodies", () => {
  it("code stub passes the draw validator", () => {
    const body = starterBody("code");
    expect(body.length).toBeGreaterThan(0);
    expect(validateDrawFunction(body).valid).toBe(true);
  });

  it("three stub passes the three validator", () => {
    const body = starterBody("three");
    expect(validateThreeFunction(body).valid).toBe(true);
  });

  it("tracked-code stub passes the draw validator", () => {
    expect(validateDrawFunction(starterBody("tracked-code")).valid).toBe(true);
  });

  // The real bug (QA 2026-09-18 B1): the starter body used `ctx`/`width`/
  // `height` as free identifiers, but createDrawFunction only injects a
  // single `context` param — every real invocation destructures it first.
  // Syntax validation alone can't catch this (the body is syntactically
  // valid JS either way); only EXECUTING it through the real compile
  // function reproduces "ctx is not defined".
  for (const kind of ["code", "tracked-code"] as const) {
    it(`${kind} stub compiles AND runs under createDrawFunction with no throw, and fills`, () => {
      const body = starterBody(kind);
      const fn = createDrawFunction(body, DRAW_HELPERS);
      const { ctx, calls } = makeStubCtx();
      expect(() => fn({ ctx, width: 100, height: 50 })).not.toThrow();
      expect(calls).toContain("fillRect");
    });
  }

  it("three stub compiles AND runs under the same injected-param signature buildThreeInstance uses, with no throw, and adds content to the scene", () => {
    const body = starterBody("three");
    // eslint-disable-next-line no-new-func
    const factory = new Function(...(THREE_PARAM_NAMES as unknown as string[]), body);
    const added: unknown[] = [];
    const scene = { add: (m: unknown) => added.push(m) };
    const camera = { position: { set() {} }, lookAt() {}, updateProjectionMatrix() {} };
    const THREE = {
      PlaneGeometry: function (this: unknown) {},
      MeshBasicMaterial: function (this: unknown) {},
      Mesh: function (this: unknown) {
        return {};
      },
    };
    expect(() =>
      factory(THREE, scene, camera, {}, 1280, 720, function () {}, DRAW_HELPERS, {}),
    ).not.toThrow();
    expect(added.length).toBe(1);
  });
});
