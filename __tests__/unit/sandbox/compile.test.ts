import { describe, it, expect, vi } from "vitest";
import {
  BodyError,
  buildDrawBodyContext,
  compileDrawBody,
  compileThreeBody,
  firstAnonymousFrame,
  mapBodyError,
  probeWrapperLineOffset,
} from "@/lib/sandbox/runtime/compile";
import { THREE_PARAM_NAMES } from "@/lib/ai/scene-validator";

const OFFSET = probeWrapperLineOffset();
const helpers = { easeOut: (t: number) => t, drawCircle: vi.fn() };
const ctx = {} as CanvasRenderingContext2D;
const timing = { frame: 12, time: 0.4, totalFrames: 90, duration: 3, progress: 0.1333 };
const baseCtx = () => buildDrawBodyContext({ ctx, width: 1, height: 1, fps: 30, time: timing, images: {} });

describe("probeWrapperLineOffset", () => {
  it("measures how many lines new Function puts before the body (V8: 2)", () => {
    expect(OFFSET).toBeGreaterThanOrEqual(1);
    // A throw on the body's first line reports line 1 after mapping.
    expect.assertions(3);
    try {
      compileDrawBody("throw new Error('first line');", helpers, OFFSET)(baseCtx());
    } catch (err) {
      expect(err).toBeInstanceOf(BodyError);
      expect((err as BodyError).line).toBe(1);
    }
  });
});

describe("buildDrawBodyContext (spec §4.3 — the narrowed surface)", () => {
  it("exposes exactly the documented keys and nothing wide", () => {
    const c = buildDrawBodyContext({ ctx, width: 640, height: 360, fps: 30, time: timing, words: [{ text: "hi", start: 0, end: 1 }], images: {} });
    expect(Object.keys(c).sort()).toEqual(["compositionTime", "ctx", "duration", "fps", "frame", "height", "images", "overlayStart", "pieceDuration", "progress", "time", "totalFrames", "width", "words"]);
    expect(c.frame).toBe(12);
    expect(c.width).toBe(640);
  });

  it("hands the piece clock through: compositionTime, overlayStart and pieceDuration are the host's numbers", () => {
    const c = buildDrawBodyContext({
      ctx, width: 1, height: 1, fps: 30, images: {},
      time: { ...timing, time: 0.4, compositionTime: 11.7, overlayStart: 11.3, pieceDuration: 24 },
    });
    expect([c.compositionTime, c.overlayStart, c.pieceDuration]).toEqual([11.7, 11.3, 24]);
  });

  it("a request that carries no piece clock reads the overlay's own as the piece's (start 0, duration = its own)", () => {
    const c = baseCtx();
    expect([c.compositionTime, c.overlayStart, c.pieceDuration]).toEqual([0.4, 0, 3]);
  });

  it("omits `words` entirely when the overlay carries none", () => {
    expect(Object.keys(baseCtx()).sort()).toEqual(["compositionTime", "ctx", "duration", "fps", "frame", "height", "images", "overlayStart", "pieceDuration", "progress", "time", "totalFrames", "width"]);
  });
});

describe("compileDrawBody", () => {
  it("runs a good body with the helpers in scope", () => {
    const fn = compileDrawBody("drawCircle(context.ctx, easeOut(0.5));", helpers, OFFSET);
    fn(baseCtx());
    expect(helpers.drawCircle).toHaveBeenCalledWith(ctx, 0.5);
  });
  it("maps a runtime error to the body's own line and column", () => {
    const src = "const a = 1;\nconst b = a + 1;\n  notDefined(b);";
    const fn = compileDrawBody(src, helpers, OFFSET);
    let caught: BodyError | null = null;
    try { fn(baseCtx()); } catch (e) { caught = e as BodyError; }
    expect(caught).toBeInstanceOf(BodyError);
    expect(caught!.phase).toBe("render");
    expect(caught!.message).toMatch(/notDefined is not defined/);
    expect(caught!.line).toBe(3);
    expect(caught!.column).toBe(3);
    // Runtime frames are stripped: only the message line + body frames remain.
    expect(caught!.bodyStack).not.toMatch(/node_modules|vitest|compile\.ts|scene-validator\.ts/);
  });
  it("maps a throw from inside a nested function to that function's own line", () => {
    // `boom()` sits on body line 2, inside a function declared on line 1 and
    // called from line 4 — the FIRST body frame is the one that threw.
    const src = "function inner() {\n  boom();\n}\ninner();";
    let caught: BodyError | null = null;
    try { compileDrawBody(src, helpers, OFFSET)(baseCtx()); } catch (e) { caught = e as BodyError; }
    expect(caught).toBeInstanceOf(BodyError);
    expect(caught!.line).toBe(2);
    expect(caught!.column).toBe(3);
  });
  it("reports a syntax error as a compile-phase BodyError with no position", () => {
    expect(() => compileDrawBody("this is not ( valid", helpers, OFFSET)).toThrow(BodyError);
    try { compileDrawBody("this is not ( valid", helpers, OFFSET); } catch (e) {
      expect((e as BodyError).phase).toBe("compile");
      expect((e as BodyError).message).toMatch(/syntax error/i);
      // V8 gives no position for a SyntaxError out of `new Function` (spec ruling).
      expect((e as BodyError).line).toBeUndefined();
      expect((e as BodyError).column).toBeUndefined();
    }
  });
  it("keeps the denylist as defense in depth", () => {
    expect.assertions(2);
    try { compileDrawBody("fetch('/api/pieces')", helpers, OFFSET); } catch (e) {
      expect((e as BodyError).phase).toBe("compile");
      expect((e as BodyError).message).toMatch(/disallowed pattern: fetch\(\) calls/);
    }
  });
});

describe("compileThreeBody", () => {
  it("returns a factory over THREE_PARAM_NAMES and rejects a syntax error at compile", () => {
    const factory = compileThreeBody("return (api) => { width; };", OFFSET);
    expect(typeof factory).toBe("function");
    expect(factory.length).toBe(THREE_PARAM_NAMES.length);
    expect(() => compileThreeBody("return (", OFFSET)).toThrow(BodyError);
  });
  it("compiles an EMPTY body to a no-op instead of rejecting it", () => {
    // `new Function(...params, "")` was legal before this seam existed, and a
    // three overlay with an empty sceneFunction renders an empty scene.
    expect(compileThreeBody("   ", OFFSET)()).toBeUndefined();
  });
});

describe("firstAnonymousFrame / mapBodyError", () => {
  it("parses V8's eval frame and subtracts the wrapper offset", () => {
    expect(firstAnonymousFrame("Error: x\n    at eval (eval at <anonymous> (file.ts:1:1), <anonymous>:5:7)")).toEqual({ line: 5, column: 7 });
    const mapped = mapBodyError(Object.assign(new Error("x"), { stack: "Error: x\n    at eval (eval at <anonymous> (file.ts:1:1), <anonymous>:5:7)" }), "render", 2);
    expect(mapped.line).toBe(3);
    expect(mapped.column).toBe(7);
    expect(mapBodyError("plain string", "render", 2).message).toBe("plain string");
    expect(mapBodyError(new Error("no frame"), "render", 2).line).toBeUndefined();
  });
  it("ignores a fake frame the body planted in its own error MESSAGE", () => {
    // The message line is body-controlled text; only real `at …` frames count,
    // or a body could choose which line the editor jumps to.
    const src = "throw new Error('sneaky <anonymous>:99:1');";
    let caught: BodyError | null = null;
    try { compileDrawBody(src, helpers, OFFSET)(baseCtx()); } catch (e) { caught = e as BodyError; }
    expect(caught!.line).toBe(1);
    expect(caught!.column).not.toBe(1);
    expect(firstAnonymousFrame("Error: <anonymous>:99:1\n    at eval (<anonymous>:5:7)")).toEqual({ line: 5, column: 7 });
  });
  it("ignores a fake frame planted in a MULTI-LINE error message", () => {
    // V8's stack head is `${name}: ${message}` — it spans as many lines as the
    // message does, so dropping exactly one head line let a body's own text be
    // read as the first frame. Also reachable by accident: a body that rethrows
    // with a captured stack pasted into the message.
    const src = "throw new Error('sneaky\\n    at <anonymous>:99:1');";
    let caught: BodyError | null = null;
    try { compileDrawBody(src, helpers, OFFSET)(baseCtx()); } catch (e) { caught = e as BodyError; }
    expect(caught!.line).toBe(1); // the real throw line, not 99 - OFFSET
    expect(caught!.bodyStack).not.toMatch(/99/);
    expect(
      firstAnonymousFrame(
        "Error: sneaky\n    at <anonymous>:99:1\n    at eval (<anonymous>:5:7)",
        "sneaky\n    at <anonymous>:99:1",
      ),
    ).toEqual({ line: 5, column: 7 });
  });
  it("strips the runtime's own location even when its path contains parentheses", () => {
    // This repo has `app/(app)/…`, which a bracket-class pattern cannot span.
    const stack =
      "Error: boom\n    at eval (eval at compileDrawBody (/repo/app/(app)/editor/page.ts:12:3), <anonymous>:5:7)";
    const mapped = mapBodyError(Object.assign(new Error("boom"), { stack }), "render", 2);
    expect(mapped.line).toBe(3);
    expect(mapped.bodyStack).toBe("Error: boom\n    at eval (<anonymous>:3:7)");
  });
  it("drops a frame that maps above the body's first line instead of showing a wrapper-relative number", () => {
    const stack =
      "Error: boom\n    at eval (<anonymous>:1:1)\n    at eval (<anonymous>:5:7)";
    const mapped = mapBodyError(Object.assign(new Error("boom"), { stack }), "render", 2);
    expect(mapped.bodyStack).toBe("Error: boom\n    at eval (<anonymous>:3:7)");
  });
  it("passes a BodyError through unchanged rather than re-mapping it", () => {
    const original = new BodyError("build", "already mapped", 4, 2);
    expect(mapBodyError(original, "render", 2)).toBe(original);
  });
  it("survives a body that sets a non-string message (the head is counted from a coerced value)", () => {
    // `e.message = 5` is legal; `message.split` on it would throw inside the
    // mapper, turning a body's own bug into a runtime crash.
    const err = Object.assign(new Error("x"), {
      message: 5 as unknown as string,
      stack: "Error: 5\n    at eval (<anonymous>:5:7)",
    });
    const mapped = mapBodyError(err, "render", 2);
    expect(mapped.line).toBe(3);
    expect(mapped.column).toBe(7);
  });
});
