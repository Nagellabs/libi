import { describe, it, expect, vi } from "vitest";
import { validateDrawFunction, createDrawFunction } from "@/lib/ai/scene-validator";

describe("validateDrawFunction", () => {
  it("accepts valid Canvas2D code", () => {
    const code = `
      ctx.fillStyle = 'red';
      ctx.fillRect(0, 0, 100, 100);
    `;
    const result = validateDrawFunction(code);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("rejects empty code", () => {
    const result = validateDrawFunction("");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Draw function code is empty");
  });

  it("rejects whitespace-only code", () => {
    const result = validateDrawFunction("   \n\t  ");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Draw function code is empty");
  });

  it("rejects eval() calls", () => {
    const result = validateDrawFunction("eval('bad code')");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("eval() calls");
  });

  it("rejects fetch() calls", () => {
    const result = validateDrawFunction("fetch('https://example.com')");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("fetch() calls");
  });

  it("rejects require() calls", () => {
    const result = validateDrawFunction("const fs = require('fs')");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("require() calls");
  });

  it("rejects dynamic import()", () => {
    const result = validateDrawFunction("import('some-module').then(m => m.default)");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("dynamic import()");
  });

  it("rejects document.cookie access", () => {
    const result = validateDrawFunction("const c = document.cookie");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("document.cookie access");
  });

  it("rejects syntactically invalid code", () => {
    const result = validateDrawFunction("const x = {{{");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("syntax error");
  });

  it("accepts code with canvas API methods (beginPath, arc, fill)", () => {
    const code = `
      context.ctx.beginPath();
      context.ctx.arc(50, 50, 30, 0, Math.PI * 2);
      context.ctx.fill();
    `;
    const result = validateDrawFunction(code);
    expect(result.valid).toBe(true);
  });
});

describe("createDrawFunction", () => {
  it("creates an executable function with injected helpers", () => {
    const helperFn = vi.fn(() => 42);
    const code = `return myHelper();`;

    const fn = createDrawFunction(code, { myHelper: helperFn });
    const result = fn({});

    expect(helperFn).toHaveBeenCalledOnce();
    expect(result).toBe(42);
  });

  it("provides context parameter to the function", () => {
    const code = `return context.frame;`;

    const fn = createDrawFunction(code, {});
    const result = fn({ frame: 99 });

    expect(result).toBe(99);
  });

  it("injects multiple helpers into scope", () => {
    const add = (a: number, b: number) => a + b;
    const multiply = (a: number, b: number) => a * b;
    const code = `return add(3, multiply(2, 4));`;

    const fn = createDrawFunction(code, { add, multiply });
    const result = fn({});

    expect(result).toBe(11);
  });

  it("helpers are available by their object key names", () => {
    const interpolate = (start: number, end: number, t: number) =>
      start + (end - start) * t;
    const code = `return interpolate(0, 100, 0.5);`;

    const fn = createDrawFunction(code, { interpolate });
    const result = fn({});

    expect(result).toBe(50);
  });
});

describe("createDrawFunction validation at load", () => {
  it("throws rather than compiling a body the denylist rejects", () => {
    // Matches the DANGEROUS_PATTERNS `fetch() calls` entry — this is exactly
    // the shape the CSP `connect-src 'self'` gap makes dangerous: a body
    // reaching the app's own local API from an unvalidated composition.json.
    const hostile = "fetch('/api/pieces'); return null;";
    expect(() => createDrawFunction(hostile, {})).toThrow();
  });

  it("still compiles a legitimate draw body", () => {
    const fn = createDrawFunction(
      "ctx.fillStyle = '#000'; ctx.fillRect(0, 0, width, height);",
      { ctx: {}, width: 0, height: 0 },
    );
    expect(typeof fn).toBe("function");
  });
});
