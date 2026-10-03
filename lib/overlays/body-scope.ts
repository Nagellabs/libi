/**
 * What a body can name without declaring it — the one list the static checks
 * (`code-scope.ts`, `code-include.ts`, the missing-name warning) read.
 *
 * Two kinds of free name are legitimate:
 *
 *  - INJECTED: the runtime hands a body its helpers as PARAMETERS of the
 *    function it builds (`createDrawFunction`: every key of the helper bag,
 *    then `context`; a three body: `THREE_PARAM_NAMES`). The names are read
 *    from those same sources, never copied here, so a helper added to
 *    `DRAW_HELPERS` is known the moment it exists
 *    (`__tests__/unit/overlays/body-scope.test.ts` pins it against the
 *    sandbox runtime's own helper bag).
 *  - GLOBALS the sandbox worker still has. The worker hardens the escapes
 *    (`lib/sandbox/runtime/harden.ts`) and deletes nothing a draw body needs,
 *    so this is the ECMAScript standard library plus the few canvas / worker
 *    names a body may legitimately build on (`Path2D`, `OffscreenCanvas`,
 *    `ImageData`, `DOMMatrix`, …). It is deliberately a closed list: a name
 *    outside it is reported, and a false report is a warning the agent can
 *    ignore, whereas a missed `heart is not defined` costs a render.
 *
 * A body is untrusted text. Nothing here runs one.
 */
import { DRAW_HELPERS } from "@/lib/engine/draw-helpers";
import { THREE_PARAM_NAMES } from "@/lib/ai/scene-validator";

/** `draw`: code and tracked-code bodies. `three`: a three scene body. */
export type BodyFamily = "draw" | "three";

/** The standard library and the worker names a body may use without declaring them. */
export const SANDBOX_GLOBALS: ReadonlySet<string> = new Set([
  // values and functions
  "undefined", "NaN", "Infinity", "globalThis", "isNaN", "isFinite", "parseInt", "parseFloat",
  "encodeURI", "encodeURIComponent", "decodeURI", "decodeURIComponent", "escape", "unescape",
  "structuredClone", "queueMicrotask", "setTimeout", "clearTimeout", "setInterval", "clearInterval",
  "requestAnimationFrame", "cancelAnimationFrame", "atob", "btoa", "console", "performance",
  // namespaces and constructors
  "Object", "Function", "Array", "String", "Number", "Boolean", "Symbol", "BigInt", "Math", "JSON",
  "Date", "RegExp", "Map", "Set", "WeakMap", "WeakSet", "WeakRef", "Promise", "Proxy", "Reflect", "Intl",
  "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError", "AggregateError",
  "ArrayBuffer", "SharedArrayBuffer", "DataView", "Atomics",
  "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array",
  "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
  // canvas and worker names a draw body builds on
  "Path2D", "OffscreenCanvas", "ImageData", "ImageBitmap", "DOMMatrix", "DOMMatrixReadOnly", "DOMPoint",
  "DOMRect", "TextEncoder", "TextDecoder", "URL", "URLSearchParams", "Blob", "AbortController", "AbortSignal",
  "createImageBitmap", "FontFace",
]);

const injected: Partial<Record<BodyFamily, ReadonlySet<string>>> = {};

/** Names the runtime injects as parameters, per body family. Read from the runtime's own sources. */
export function injectedNames(family: BodyFamily): ReadonlySet<string> {
  return (injected[family] ??=
    family === "three"
      ? new Set<string>(THREE_PARAM_NAMES)
      : new Set<string>([...Object.keys(DRAW_HELPERS), "context"]));
}

/** True when a body of this family may name `name` without declaring it. */
export function isBuiltinName(name: string, family: BodyFamily): boolean {
  return SANDBOX_GLOBALS.has(name) || injectedNames(family).has(name);
}
